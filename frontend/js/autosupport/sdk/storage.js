// Thin wrapper around a localStorage-shaped backend ({getItem, setItem, removeItem}).
// SPEC-L2.md section 7: "Every read and write is wrapped in try/catch: private windows and
// blocked site data must degrade, never throw." This file is the one place that rule is
// implemented; index.js never touches a storage backend directly.
//
// Every key is namespaced under this prefix so the SDK never collides with anything else
// the host page keeps in the same localStorage.
const PREFIX = 'autosupport:';

// Reading the `localStorage` global can itself throw in a real browser (Safari private
// mode, cookies disabled, some embedded webviews raise a SecurityError just for touching
// the property) -- and even `typeof localStorage` triggers that, because `localStorage` is
// an accessor property, not a plain binding. So resolving the default backend has to be
// inside its own try/catch, separate from get/set/remove below.
function resolveDefaultBackend() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// Returns a {get, set, remove} object backed by `backend` (defaults to the global
// `localStorage` when `backend` is omitted entirely; pass `null` explicitly for
// memory-only storage). Every call is wrapped in try/catch and falls back to an in-memory
// Map that is private to this storage instance and lives only for the page session -- so a
// backend that is missing, blocked, or throws on every call still lets the SDK function,
// it just loses persistence across reloads. That degradation is intentional, not a bug:
// see the README section on losing a reporter_token.
export function createStorage(backend) {
  const resolved = backend === undefined ? resolveDefaultBackend() : backend;
  const mem = new Map();

  function get(key) {
    const fullKey = PREFIX + key;
    if (resolved) {
      try {
        const value = resolved.getItem(fullKey);
        if (value !== null && value !== undefined) return value;
      } catch {
        // Backend unreadable (blocked/quota/private mode) -- fall through to the
        // in-memory shadow below instead of throwing.
      }
    }
    return mem.has(fullKey) ? mem.get(fullKey) : null;
  }

  function set(key, value) {
    const fullKey = PREFIX + key;
    // Always keep the in-memory shadow up to date first, so a throwing backend still
    // leaves this storage instance internally consistent for the rest of the session.
    mem.set(fullKey, value);
    if (resolved) {
      try {
        resolved.setItem(fullKey, value);
      } catch {
        // Write rejected (private mode, quota exceeded, blocked site data). The
        // in-memory copy above is now the source of truth until the page reloads.
      }
    }
  }

  function remove(key) {
    const fullKey = PREFIX + key;
    mem.delete(fullKey);
    if (resolved) {
      try {
        resolved.removeItem(fullKey);
      } catch {
        // Nothing to do -- it's already gone from the in-memory shadow.
      }
    }
  }

  return { get, set, remove };
}

export const STORAGE_PREFIX = PREFIX;
