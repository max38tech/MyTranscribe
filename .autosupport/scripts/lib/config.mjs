// Tiny YAML-subset loader for .autosupport/config.yml.
//
// This is NOT a general YAML parser. The target repo has no dependencies
// (SPEC.md section 2 / PKG-C brief), so this handles exactly the flat subset
// our own config.yml uses:
//   - block mappings, nested by 2-space indent
//   - scalar values: quoted strings ('...' or "..."), bare strings,
//     true/false, null/~, integers, decimals
//   - flow sequences of scalars on a single line, e.g. [a, "b", 3]
//   - block sequences of scalars ("- item" lines under a key), which is what
//     `yaml.stringify` emits for arrays and therefore what `autosupport init`
//     actually writes - handling only flow style meant labels, platforms and
//     reply.languages silently parsed as {} at runtime
//   - full-line and trailing comments starting with a `#` that is not
//     inside a quoted string
//
// NOT supported, by design: flow mappings ({a: b}), multi-line scalars
// (| or >), anchors/aliases, arrays of objects (e.g. a hand-written
// redaction.custom list must use flow style on one line:
// custom: [{name: x, regex: y}] would NOT parse - avoid it). A line
// this loader cannot make sense of is skipped rather than thrown on, so a
// syntax error in a user-edited config degrades to "field missing" instead
// of crashing a workflow; validateConfig (packages/core) is the place to
// catch that, in the CLI, not here.

import { readFileSync } from 'node:fs';

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function splitFlowItems(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') items.push(cur);
  return items;
}

function parseValue(rest) {
  const trimmed = rest.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    return inner === '' ? [] : splitFlowItems(inner).map(parseScalar);
  }
  return parseScalar(trimmed);
}

export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const indent = line.length - line.trimStart().length;

    if (trimmedLine.startsWith('- ') || trimmedLine === '-') {
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const top = stack[stack.length - 1];
      // A bare "key:" is ambiguous: a nested mapping and a block sequence look
      // identical until the first child line. The key handler below guesses
      // mapping and creates {}; the first "- " under it proves otherwise, so
      // swap in an array and repoint the parent at it.
      if (top.parent && isPlainObject(top.node) && Object.keys(top.node).length === 0) {
        top.node = [];
        top.parent[top.key] = top.node;
      }
      if (Array.isArray(top.node)) {
        top.node.push(trimmedLine === '-' ? null : parseValue(trimmedLine.slice(2)));
      }
      continue;
    }

    const match = trimmedLine.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (!isPlainObject(parent)) continue;

    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child, parent, key });
    } else {
      parent[key] = parseValue(rest);
    }
  }

  return root;
}

const DEFAULTS = {
  model: {
    triage: 'claude-sonnet-5',
    fix: 'claude-sonnet-5',
    respond: 'claude-sonnet-5',
    chat: 'claude-sonnet-5',
  },
  policy: {
    bug: { auto_fix: true, auto_pr: true, require_approval: true, confidence_floor: 0.8, labels: [] },
    feature: { auto_fix: false, notify_owner: true, labels: [] },
    support: { chatbot: true, escalate_after_turns: 3, confidence_floor: 0.7, labels: [] },
  },
  redaction: { patterns: [] },
  dedup: { window_days: 90, enabled: true },
  knowledge: { sources: [], include_closed_issues: true, include_discussions: true },
  reply: { tone: 'friendly-concise', languages: ['en'], signature: '' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = isPlainObject(base?.[key]) ? deepMerge(base[key], override[key]) : override[key];
  }
  return result;
}

// Thrown by loadConfig for states this loader can positively identify as
// broken (file missing, file empty) so a workflow run stops with one clear,
// actionable line instead of silently continuing on all-default policy
// values. See DEG-5: missing / empty / malformed-YAML / schema-invalid must
// each produce a distinct, actionable message. This loader can only ever
// detect the first two on its own - it has no access to
// schema/config.v1.schema.json (core-only, per SPEC.md 6.4) and, by design
// (see the file-level comment above), tolerates YAML it cannot parse by
// skipping the offending line rather than failing the whole file, so a
// typo'd-but-nonempty config still degrades to "field missing" here.
// Malformed-but-parses and schema-invalid are exactly what
// `autosupport check` (packages/cli/src/check.js, using the real
// validateConfig from packages/core) exists to catch before you push -
// that is a deliberate division of labor, not a gap: this loader runs
// inside the GitHub Actions workflow itself and has no dependency budget to
// import a JSON Schema validator, while `check` is a separate, dependency-
// permitted CLI step meant to be run ahead of time.
export class ConfigError extends Error {}

// Reads and parses configPath, then fills in any field this loader's
// DEFAULTS knows about that the file left out. Fields with no schema
// default (version, app, redaction.patterns) are simply absent if the file
// omits them - callers must handle that themselves.
export function loadConfig(configPath) {
  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new ConfigError(
        `AutoSupport config not found at ${configPath}. Run "autosupport init", or restore .autosupport/config.yml, before this workflow can run.`
      );
    }
    throw new ConfigError(`Could not read AutoSupport config at ${configPath}: ${err.message}`);
  }

  const parsed = parseYaml(text);
  if (Object.keys(parsed).length === 0) {
    throw new ConfigError(
      `AutoSupport config at ${configPath} is empty (or has no line this loader recognizes as "key: value"). ` +
        'It must at least declare "version: 1" and "app.id" / "app.repo" - see AUTOSUPPORT.md, or run "autosupport check" for details.'
    );
  }

  return deepMerge(DEFAULTS, parsed);
}
