// Stage 4 (Respond). Triggered when an issue closes, or by the
// autosupport:respond label. Posts one reply comment - there is no other
// delivery channel in Level 1 (no email, no push); see AUTOSUPPORT.md.
//
// Prompt assembly and outcome classification are pure functions exported
// below, separate from runRespond(). gh access goes through an injectable
// exec (lib/exec.mjs) and the model call through an injectable askFn
// (lib/claude.mjs's ask, itself transport-injectable), so tests can drive
// this whole script with fakes only - see TEST-PLAN.md's "Required
// refactor" section.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ask as defaultAsk } from './lib/llm.mjs';
import { extractEnvelope, extractJsonBlock, TRIAGE_MARKERS } from './lib/envelope.mjs';
import { loadConfig } from './lib/config.mjs';
import { createExec } from './lib/exec.mjs';
import { wrapUntrusted } from './lib/untrusted.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function findTriageResult(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const json = extractJsonBlock(comments[i].body ?? '', TRIAGE_MARKERS.start, TRIAGE_MARKERS.end);
    if (json) return json;
  }
  return null;
}

function findFixLink(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body ?? '';
    if (body.includes('<!-- autosupport:fix-pr -->')) return body;
  }
  return null;
}

// --- Pure logic (exported for tests) ----------------------------------------

// Best-effort outcome classification. The brief names five outcomes
// (fixed-by-pr, wont-fix, duplicate, needs-info, local-device-issue) without
// prescribing an exact algorithm, since GitHub does not have a canonical
// field for most of them. This reads the signals AutoSupport itself already
// produced - labels from triage.mjs, the fix-pr marker from fix.mjs, and the
// issue's close reason - and falls back to "needs-info" when unsure. The
// outcome only selects which respond.md guidance the model leans on; the
// model still sees the raw signals in the prompt and can adjust.
export function determineOutcome({ labelNames, state, stateReason, triage, fixLinked }) {
  if (labelNames.includes('duplicate')) return 'duplicate';
  if (labelNames.some((n) => n === 'wontfix' || n === 'wont-fix')) return 'wont-fix';
  if (fixLinked) return 'fixed-by-pr';
  if (state === 'CLOSED' && stateReason === 'NOT_PLANNED') return 'wont-fix';
  if (triage?.classification === 'invalid') return 'local-device-issue';
  if (triage?.reproducible === 'unclear') return 'needs-info';
  if (state === 'CLOSED') return 'fixed-by-pr';
  return 'needs-info';
}

// Places the reporter-authored issue title/body inside one delimited,
// labelled block - see lib/untrusted.mjs and the "Untrusted input" section
// of prompts/respond.md. The outcome/tone/locale/triage/fix-link/signature
// fields are all AutoSupport's own derived signals, not reporter text, so
// they stay outside the block.
export function buildUserMessage({ issue, outcome, tone, locale, triage, fixLinked, signature }) {
  const untrustedParts = [`Issue #${issue.number} title: ${issue.title ?? ''}`, '', issue.body || '(empty)'];

  return [
    wrapUntrusted(untrustedParts.join('\n')),
    '',
    `Outcome: ${outcome}`,
    `Reply tone: ${tone}`,
    locale
      ? `Reporter locale hint: ${locale}`
      : 'No locale hint available; detect language from the issue text, defaulting to English.',
    triage ? `Triage result:\n${JSON.stringify(triage, null, 2)}` : 'No triage result available.',
    fixLinked ? `Fix link comment:\n${fixLinked}` : '',
    signature ? `Sign off with: ${signature}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// --- Orchestration -----------------------------------------------------------

export async function runRespond(deps = {}) {
  const {
    env = process.env,
    exec = createExec(),
    askFn = defaultAsk,
    configPath = path.join(__dirname, '..', 'config.yml'),
    tmpDir = tmpdir(),
  } = deps;

  const issueNumber = Number(requireEnv(env, 'ISSUE_NUMBER'));
  const repo = requireEnv(env, 'REPO');
  // The provider (and therefore which API key env var is required) is derived from
  // the configured model id by lib/llm.mjs, which errors naming the missing variable.
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID || undefined;
  const config = loadConfig(configPath);

  function postComment(body) {
    const file = path.join(
      tmpDir,
      `autosupport-respond-comment-${issueNumber}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    );
    writeFileSync(file, body, 'utf8');
    exec.gh(['issue', 'comment', String(issueNumber), '--repo', repo, '--body-file', file]);
  }

  const issue = exec.ghJson([
    'issue', 'view', String(issueNumber), '--repo', repo,
    '--json', 'number,title,body,labels,state,stateReason,comments',
  ]);
  const envelope = extractEnvelope(issue.body ?? '');
  const triage = findTriageResult(issue.comments ?? []);
  const fixLinked = findFixLink(issue.comments ?? []);
  const labelNames = (issue.labels ?? []).map((l) => l.name);

  const outcome = determineOutcome({
    labelNames,
    state: issue.state,
    stateReason: issue.stateReason,
    triage,
    fixLinked,
  });

  const system = readFileSync(path.join(__dirname, '..', 'prompts', 'respond.md'), 'utf8');
  const tone = config.reply?.tone ?? 'friendly-concise';
  const signature = config.reply?.signature ?? '';
  const locale = envelope?.app?.locale;

  const userMessage = buildUserMessage({ issue, outcome, tone, locale, triage, fixLinked, signature });

  const model = config.model?.respond ?? 'gemini-3.8-flash';
  const reply = await askFn({
    model,
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 1024,
    env,
    workspaceId,
  });

  const body = reply.trim();
  if (!body) {
    throw new Error('model returned an empty reply');
  }

  postComment(body);
  console.log(`respond complete for #${issueNumber}: outcome=${outcome}`);
  return { exitCode: 0, issueNumber, outcome };
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

// Only the direct-run path ever calls process.exit - runRespond() itself
// always either resolves with a result object or rejects, so importing this
// module for its exports never has a side effect or terminates the process.
if (isDirectRun()) {
  runRespond().catch((err) => {
    console.error(`respond failed: ${err.message}`);
    process.exit(1);
  });
}
