import { AutoSupportError } from './errors.js';

const defaultHasher = async (bytes) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AutoSupportError(
      'globalThis.crypto.subtle is not available in this environment; call setHasher(fn) with a SHA-256 implementation before using fingerprint().'
    );
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
};

let hasher = defaultHasher;

export function setHasher(fn) {
  hasher = fn;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX_RUN_RE = /[0-9a-f]{8,}/g;
const DIGIT_RUN_RE = /\d{3,}/g;
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?/g;

// Most-specific-first, per SPEC.md 6.2. Timestamps must be collapsed before the generic
// run collapse: a timestamp's 4-digit year is itself a digit run of 3+, so collapsing runs
// first would consume the year and leave the timestamp pattern unmatchable, which breaks
// dedup for the same crash logged at different times.
const collapseUuids = (s) => s.replace(UUID_RE, 'N');
const collapseTimestamps = (s) => s.replace(ISO_TIMESTAMP_RE, 'T');
const collapseRuns = (s) => s.replace(HEX_RUN_RE, 'N').replace(DIGIT_RUN_RE, 'N');
const collapseWhitespace = (s) => s.replace(/\s+/g, ' ').trim();

const asString = (value) => (typeof value === 'string' ? value : '');

// Steps 1-4 from SPEC.md 6.2, shared by title and stack.
const normalizeCore = (value) => collapseRuns(collapseTimestamps(collapseUuids(asString(value).toLowerCase())));

const normalizeTitle = (title) => collapseWhitespace(normalizeCore(title));

// stack additionally keeps only the first 5 lines. That has to happen before
// the final whitespace collapse (step 5), which would otherwise erase the
// newlines "first 5 lines" depends on.
const normalizeStack = (stack) => {
  const core = normalizeCore(stack);
  const firstLines = core.split('\n').slice(0, 5).join('\n');
  return collapseWhitespace(firstLines);
};

const toHex = (bytes) => {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
};

export async function fingerprint(parts) {
  const { kind, appId, title, stack } = parts;
  const normTitle = normalizeTitle(title);
  const normStack = normalizeStack(stack);
  const input = `${kind}\0${appId}\0${normTitle}\0${normStack}`;
  const digest = await hasher(new TextEncoder().encode(input));
  return toHex(digest.slice(0, 8));
}
