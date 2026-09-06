import { redact } from './redact.js';
import { fingerprint } from './fingerprint.js';
import { validateReport } from './validate.js';
import { ValidationError } from './errors.js';

// Hardcoded to match package.json's "version" — buildEnvelope must work in a
// browser, so it cannot read package.json at runtime.
const CORE_VERSION = '0.1.0';

const mergeRedaction = (target, result) => {
  for (const name of result.applied) target.applied.add(name);
  for (const [name, count] of Object.entries(result.counts)) {
    target.counts[name] = (target.counts[name] ?? 0) + count;
  }
  return result.text;
};

// Mirrors the maxLength values in schema/report.v1.schema.json for every field that gets
// redacted. Kept next to the redaction call sites deliberately: if a maxLength changes in
// the schema, the schema-parity test in test/ fails and points here.
const MAX_LENGTHS = { title: 200, body: 20000, stack: 10000, action: 200, inline: 100000 };

function findOversizedFields(src) {
  const errors = [];
  const check = (value, limit, path) => {
    if (typeof value === 'string' && value.length > limit) {
      errors.push({ path, message: `string is ${value.length} characters, maximum is ${limit}` });
    }
  };

  check(src.title, MAX_LENGTHS.title, '/title');
  check(src.body, MAX_LENGTHS.body, '/body');
  check(src.context?.stack, MAX_LENGTHS.stack, '/context/stack');

  if (Array.isArray(src.context?.last_actions)) {
    src.context.last_actions.forEach((action, i) =>
      check(action, MAX_LENGTHS.action, `/context/last_actions/${i}`)
    );
  }
  if (Array.isArray(src.attachments)) {
    src.attachments.forEach((att, i) =>
      check(att?.inline, MAX_LENGTHS.inline, `/attachments/${i}/inline`)
    );
  }
  return errors;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export async function buildEnvelope(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('buildEnvelope: input must be an object', [
      { path: '', message: `expected object, got ${input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input}` },
    ]);
  }

  // Clone so redaction/freezing never touches the caller's own object.
  const src = structuredClone(input);

  // Size-check before redacting, not after. Redaction on a field that validation is
  // certain to reject is wasted work on attacker-controlled input, and it puts every
  // regex in the pipeline in front of a payload chosen by whoever filed the report.
  // Checking first means oversized input costs a length comparison and comes back as the
  // ValidationError the API documents, rather than as whatever the first pattern to choke
  // happens to throw.
  const oversized = findOversizedFields(src);
  if (oversized.length > 0) {
    throw new ValidationError('buildEnvelope: input field exceeds its maximum length', oversized);
  }

  const redaction = { applied: new Set(), counts: {} };

  if (typeof src.title === 'string') {
    src.title = mergeRedaction(redaction, redact(src.title, options));
  }
  if (typeof src.body === 'string') {
    src.body = mergeRedaction(redaction, redact(src.body, options));
  }
  if (src.context && typeof src.context === 'object') {
    if (typeof src.context.stack === 'string') {
      src.context.stack = mergeRedaction(redaction, redact(src.context.stack, options));
    }
    if (Array.isArray(src.context.last_actions)) {
      src.context.last_actions = src.context.last_actions.map((action) =>
        typeof action === 'string' ? mergeRedaction(redaction, redact(action, options)) : action
      );
    }
  }
  if (Array.isArray(src.attachments)) {
    src.attachments = src.attachments.map((att) => {
      if (att && typeof att === 'object' && typeof att.inline === 'string') {
        att.inline = mergeRedaction(redaction, redact(att.inline, options));
        att.redacted = true;
      }
      return att;
    });
  }

  // Fingerprint from the *redacted* title/stack — this is what makes the
  // same crash from two different users dedup to the same value.
  const fp = await fingerprint({
    kind: src.kind,
    appId: src.app?.id,
    title: src.title,
    stack: src.context?.stack,
  });

  const report = {
    ...src,
    schema: 'autosupport/report@1',
    redaction: { applied: [...redaction.applied].sort(), counts: redaction.counts },
    fingerprint: fp,
    idempotency_key: src.idempotency_key ?? `${fp}-${src.reporter?.anon_id}`,
    created_at: src.created_at ?? new Date().toISOString(),
    sdk: `core/${CORE_VERSION}`,
  };

  const { valid, errors } = validateReport(report);
  if (!valid) {
    throw new ValidationError('buildEnvelope: assembled report failed schema validation', errors);
  }

  return deepFreeze(report);
}
