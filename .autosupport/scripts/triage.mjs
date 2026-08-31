// Stage 2 (Triage). Triggered by .github/workflows/autosupport-triage.yml.
// Reads the issue, asks Claude for a strict-JSON verdict, posts it as a
// comment, and applies labels. Degrades gracefully when the issue has no
// AutoSupport envelope (a human filed it by hand): classifies from the
// issue text alone and skips fingerprint dedup search.
//
// Prompt assembly, response parsing, and label/close decisions are pure
// functions exported below, separate from runTriage(). gh access goes
// through an injectable exec (lib/exec.mjs) and the model call through an
// injectable askFn (lib/claude.mjs's ask, itself transport-injectable), so
// tests can drive this whole script with fakes only - see TEST-PLAN.md's
// "Required refactor" section.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ask as defaultAsk, stripCodeFences } from './lib/claude.mjs';
import { extractEnvelope } from './lib/envelope.mjs';
import { loadConfig } from './lib/config.mjs';
import { createExec } from './lib/exec.mjs';
import { wrapUntrusted } from './lib/untrusted.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

// --- Pure logic (exported for tests) ---------------------------------------

// Places every reporter-authored field - issue title, issue body, and the
// structured envelope (already PII-redacted by packages/core, but still
// untrusted text) - inside one delimited, labelled block, so both the model
// and a test can tell data from instructions. See lib/untrusted.mjs and the
// "Untrusted input" section of prompts/triage.md. Prior-fingerprint matches
// come from GitHub's own search API, not from the report, so they are kept
// outside the block.
export function buildUserMessage({ issue, envelope, priorMatches = [] }) {
  const untrustedParts = [
    `Issue #${issue.number} title: ${issue.title ?? ''}`,
    '',
    'Issue body:',
    issue.body || '(empty)',
  ];
  if (envelope) {
    untrustedParts.push(
      '',
      'Structured envelope (already redacted for PII, still untrusted user content):',
      JSON.stringify(envelope, null, 2)
    );
  }

  return [
    wrapUntrusted(untrustedParts.join('\n')),
    '',
    envelope
      ? 'The envelope above was present, so a diagnostic report was attached to this issue.'
      : 'No structured envelope was found on this issue - it was likely filed by hand. Classify from the text alone.',
    '',
    priorMatches.length
      ? `Issues that already share this fingerprint (from GitHub's own search, not from the report):\n${priorMatches
          .map((m) => `#${m.number} [${m.state}] ${m.title}`)
          .join('\n')}`
      : 'No prior issues share this fingerprint.',
  ].join('\n');
}

// Strips fences, parses JSON, and checks the one field the rest of this
// script depends on. Throws a plain Error with a clear message on any
// failure - this function never returns something malformed.
export function parseTriageResponse(raw) {
  const cleaned = stripCodeFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`triage response was not valid JSON (${err.message})`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.classification !== 'string'
  ) {
    throw new Error('triage response was not valid JSON (response JSON is missing a "classification" string field)');
  }
  return parsed;
}

export function formatTriageComment(triage) {
  return [
    '### AutoSupport triage',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Classification | ${triage.classification ?? '-'} |`,
    `| Severity | ${triage.severity ?? '-'} |`,
    `| Reproducible | ${triage.reproducible ?? '-'} |`,
    `| Confidence | ${triage.confidence ?? '-'} |`,
    `| Duplicate of | ${triage.duplicate_of ? `#${triage.duplicate_of}` : '-'} |`,
    `| Suspected area | ${triage.suspected_area || '-'} |`,
    '',
    triage.summary ? `**Summary:** ${triage.summary}` : '',
    '',
    '<!-- autosupport:triage -->',
    '```json',
    JSON.stringify(triage, null, 2),
    '```',
    '<!-- /autosupport:triage -->',
  ].join('\n');
}

function formatParseFailureComment(raw) {
  return [
    '### AutoSupport triage',
    '',
    'Automated triage could not be completed: the model response was not valid JSON.',
    '',
    '<details><summary>Raw model output</summary>',
    '',
    '```',
    raw,
    '```',
    '',
    '</details>',
  ].join('\n');
}

// policy.bug.confidence_floor (default 0.8) gates auto-fix specifically -
// intentionally a stricter, separate threshold from
// policy.support.confidence_floor (default 0.7, used for chatbot
// escalation): opening a PR against the codebase is higher stakes than
// answering a support question. Returns a plain list of actions instead of
// performing them, so a test can assert on the decision without any gh call
// happening (and so no report field, however phrased, can add an action
// this function didn't decide on - see ADV-2).
export function decideLabelActions(triage, config) {
  const actions = [];
  if (triage.severity) {
    actions.push({ type: 'add-label', label: `severity:${triage.severity}`, description: 'adding severity label' });
  }

  const confidenceFloor = config.policy?.bug?.confidence_floor ?? 0.8;
  if (
    triage.classification === 'bug' &&
    typeof triage.confidence === 'number' &&
    triage.confidence >= confidenceFloor &&
    config.policy?.bug?.auto_fix
  ) {
    actions.push({ type: 'add-label', label: 'autosupport:auto-fix', description: 'adding auto-fix label' });
  }

  if (triage.duplicate_of) {
    actions.push({ type: 'add-label', label: 'duplicate', description: 'adding duplicate label' });
    actions.push({
      type: 'close',
      comment: `Closing as a duplicate of #${triage.duplicate_of}.`,
      description: 'closing as duplicate',
    });
  }

  return actions;
}

// --- Orchestration -----------------------------------------------------------

// deps lets tests replace every side-effecting boundary: exec (gh calls),
// askFn (the Claude call), env (instead of mutating process.env), configPath
// and tmpDir (so nothing is ever written outside a test's own scratch dir).
// Every default is the real thing, so a plain `node triage.mjs` run (the
// GitHub Actions case) behaves exactly as before this refactor.
export async function runTriage(deps = {}) {
  const {
    env = process.env,
    exec = createExec(),
    askFn = defaultAsk,
    configPath = path.join(__dirname, '..', 'config.yml'),
    tmpDir = tmpdir(),
  } = deps;

  const issueNumber = Number(requireEnv(env, 'ISSUE_NUMBER'));
  const repo = requireEnv(env, 'REPO');
  const apiKey = requireEnv(env, 'ANTHROPIC_API_KEY');
  // Optional: only identity-linked keys need it, workspace-scoped keys must not send it.
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID || undefined;
  const config = loadConfig(configPath);

  function postComment(body) {
    const file = path.join(
      tmpDir,
      `autosupport-triage-comment-${issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    );
    writeFileSync(file, body, 'utf8');
    exec.gh(['issue', 'comment', String(issueNumber), '--repo', repo, '--body-file', file]);
  }

  function tryGh(args, description) {
    try {
      exec.gh(args);
    } catch (err) {
      console.error(`warning: ${description} failed: ${err.message}`);
    }
  }

  const issue = exec.ghJson(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,title,body,labels']);
  const envelope = extractEnvelope(issue.body ?? '');

  let priorMatches = [];
  if (envelope?.fingerprint) {
    const results = exec.ghJson([
      'issue', 'list', '--repo', repo,
      '--search', `${envelope.fingerprint} in:body`,
      '--state', 'all',
      '--json', 'number,title,state',
    ]);
    priorMatches = results.filter((r) => r.number !== issueNumber);
  }

  const system = readFileSync(path.join(__dirname, '..', 'prompts', 'triage.md'), 'utf8');
  const userMessage = buildUserMessage({ issue, envelope, priorMatches });

  const model = config.model?.triage ?? 'claude-sonnet-5';
  const raw = await askFn({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 1024,
    apiKey,
    workspaceId,
  });

  let triage;
  try {
    triage = parseTriageResponse(raw);
  } catch (err) {
    postComment(formatParseFailureComment(raw));
    throw err;
  }

  postComment(formatTriageComment(triage));

  // Labeling is best-effort and independent per label: `gh issue edit
  // --add-label` fails if the label does not exist yet in the repo (see
  // AUTOSUPPORT.md step 2 - a fresh repo needs the labels created once).
  // The triage comment above is the important deliverable and has already
  // posted, so a missing label should warn, not abort the run or block the
  // other labels/close from being attempted (see DEG-3).
  for (const action of decideLabelActions(triage, config)) {
    if (action.type === 'add-label') {
      tryGh(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', action.label], action.description);
    } else if (action.type === 'close') {
      tryGh(['issue', 'close', String(issueNumber), '--repo', repo, '--comment', action.comment], action.description);
    }
  }

  console.log(`triage complete for #${issueNumber}: ${triage.classification}/${triage.severity ?? 'n/a'}`);
  return { exitCode: 0, issueNumber, triage };
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

// Only the direct-run path ever calls process.exit - runTriage() itself
// always either resolves with a result object or rejects, so importing this
// module for its exports never has a side effect or terminates the process.
if (isDirectRun()) {
  runTriage().catch((err) => {
    console.error(`triage failed: ${err.message}`);
    process.exit(1);
  });
}
