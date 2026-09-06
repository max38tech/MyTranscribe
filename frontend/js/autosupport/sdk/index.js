// Public entry point for @autosupport/sdk. Per SPEC-L2.md section 7 this file's three
// exports -- init, report, getReplies -- are a frozen API; do not change their signatures
// without updating the spec first, and do not add further public exports here (error
// classes live in ./errors.js and are not part of the frozen surface).
import { createStorage } from './storage.js';
import { createTransport } from './transport.js';
import { ConfigError, NotInitializedError } from './errors.js';

// Resolving buildEnvelope, in order of preference:
//
// 1. Whatever the host app passed to init(). The relative import below only resolves when
//    the SDK sits in this repo's package layout; served from an app's own static directory
//    it does not, and mirroring `packages/` into someone's frontend just to satisfy a path
//    is the wrong trade. Injection keeps the SDK usable in any layout.
// 2. The relative import, which carries the same wart packages/cli does (see its README):
//    Level 2 is one npm workspace, so core is imported by path rather than as a dependency.
//
// Deferred behind a dynamic import either way, so init() -- and, for the many users who
// never file a report, the entire SDK -- never needs core to load at all. Only a real
// report() call pays for it, and it fails with one clear message rather than an unrelated
// module-resolution crash.
async function loadBuildEnvelope(injected) {
  if (injected) return injected;
  try {
    const core = await import('../../core/src/index.js');
    return core.buildEnvelope;
  } catch (err) {
    throw new ConfigError(
      'AutoSupport SDK: cannot load @autosupport/core from ../../core/src/index.js, and no ' +
        `buildEnvelope was passed to init(). Pass one when serving the SDK outside this repo: ${err.message}`
    );
  }
}

const REQUIRED_OPTIONS = ['endpoint', 'appId', 'appVersion', 'platform'];
// `fetch` and `storage` are the injectable boundaries; everything else is required config.
const KNOWN_OPTIONS = new Set([...REQUIRED_OPTIONS, 'fetch', 'storage', 'buildEnvelope']);

function validateInitOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('AutoSupport SDK: init() requires an options object');
  }
  const missing = REQUIRED_OPTIONS.filter(
    (key) => typeof options[key] !== 'string' || options[key].length === 0
  );
  if (missing.length > 0) {
    throw new ConfigError(`AutoSupport SDK: init() missing required option(s): ${missing.join(', ')}`);
  }

  // Reject unknown keys rather than ignoring them. A misspelled `fetch` or `storage`
  // silently falls back to the real global, which is invisible in production and actively
  // dangerous in a test: an injected transport that is quietly ignored makes assertions
  // about "no network call" pass for the wrong reason. Cheap to check, expensive to debug.
  const unknown = Object.keys(options).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `AutoSupport SDK: init() got unknown option(s): ${unknown.join(', ')}. ` +
        `Known options are: ${[...KNOWN_OPTIONS].join(', ')}`
    );
  }
}

// Shallow, key-by-key `Object.is` comparison across the union of both objects' own keys.
// "Same options" is judged by value equality for primitives (two calls built from the same
// literal endpoint/appId/etc. count as identical) and by reference equality for anything
// else (a freshly-constructed `fetch` or `storage` override counts as different, even if it
// behaves the same as the last one) -- which is exactly what lets a test re-init() with a
// new fake and have it actually take effect.
function sameOptions(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

const trimTrailingSlash = (s) => s.replace(/\/+$/, '');

// Module-level singleton. SPEC-L2.md section 7 describes init() as idempotent config, not
// a constructor -- there is deliberately exactly one SDK "instance" per loaded module.
let state = null;

// init(options): validates and stores config in module state. Calling it twice with the
// same options is a no-op; calling it with different options replaces the config (a fresh
// storage wrapper and a fresh transport are created either way, but "no-op" matters because
// storage.js keeps an in-memory fallback that would otherwise be discarded on every
// redundant init() call).
export function init(options = {}) {
  validateInitOptions(options);
  if (state && sameOptions(state.options, options)) {
    return;
  }
  state = {
    options,
    storage: createStorage(options.storage),
    transport: createTransport(options.fetch),
  };
}

function requireState(fnName) {
  if (!state) {
    throw new NotInitializedError(`AutoSupport SDK: ${fnName}() was called before init()`);
  }
  return state;
}

// Generated once via crypto.randomUUID(), prefixed anon-, and persisted -- SPEC-L2.md
// section 7. Lazy: only ever called from report(), so a user who never files a report never
// gets one written to storage at all.
function ensureAnonId(s) {
  let anonId = s.storage.get('anon_id');
  if (!anonId) {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      throw new ConfigError('AutoSupport SDK: crypto.randomUUID() is not available in this environment');
    }
    anonId = `anon-${crypto.randomUUID()}`;
    s.storage.set('anon_id', anonId);
  }
  return anonId;
}

// report({ kind, title, body, context, attachments }) -> { issue_number, deduped }
//
// Builds the envelope with core's buildEnvelope (so redaction and fingerprinting happen
// client-side too, ahead of the worker's own re-redaction), POSTs it to
// `${endpoint}/v1/reports`, and stores the returned reporter_token if none is stored yet --
// an existing token is never overwritten (SPEC-L2.md section 7). No retries: a failed
// request throws a typed error (see transport.js) and it is up to the host app to retry.
export async function report({ kind, title, body, context, attachments } = {}) {
  const s = requireState('report');
  const buildEnvelope = await loadBuildEnvelope(s.options.buildEnvelope);

  const envelope = await buildEnvelope({
    kind,
    title,
    body,
    context,
    attachments,
    app: {
      id: s.options.appId,
      version: s.options.appVersion,
      platform: s.options.platform,
    },
    reporter: { anon_id: ensureAnonId(s) },
  });

  const data = await s.transport({
    url: `${trimTrailingSlash(s.options.endpoint)}/v1/reports`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-AutoSupport-App': s.options.appId,
    },
    body: envelope,
  });

  if (typeof data?.reporter_token === 'string' && !s.storage.get('reporter_token')) {
    s.storage.set('reporter_token', data.reporter_token);
  }

  return { issue_number: data?.issue_number, deduped: Boolean(data?.deduped) };
}

// getReplies() -> [{ issue_number, created_at, body }]
//
// THE RULE THAT MATTERS MOST (SPEC-L2.md section 7 / handoff/PKG-E-sdk.md): most users
// never file a report, so most callers of getReplies() hold no reporter_token. This first
// check -- return [] before any fetch -- is what keeps polling every user on a timer cheap
// enough to stay inside a free tier; everything below it only runs for the minority who
// actually have a report to follow up on.
export async function getReplies() {
  const s = requireState('getReplies');

  const token = s.storage.get('reporter_token');
  if (!token) {
    return [];
  }

  const since = s.storage.get('last_seen_reply_at');
  const url = new URL(`${trimTrailingSlash(s.options.endpoint)}/v1/replies`);
  if (since) {
    url.searchParams.set('since', since);
  }

  const data = await s.transport({
    url: url.toString(),
    method: 'GET',
    headers: {
      'X-AutoSupport-App': s.options.appId,
      Authorization: `Bearer ${token}`,
    },
  });

  const replies = Array.isArray(data?.replies) ? data.replies : [];

  // Advance last_seen_reply_at only after we actually have replies to return, and only to
  // the newest created_at among them -- SPEC-L2.md section 7. An empty response must never
  // move the cursor forward.
  if (replies.length > 0) {
    const newest = replies.reduce(
      (max, r) => (typeof r?.created_at === 'string' && r.created_at > max ? r.created_at : max),
      replies[0]?.created_at ?? ''
    );
    if (newest) {
      s.storage.set('last_seen_reply_at', newest);
    }
  }

  return replies;
}
