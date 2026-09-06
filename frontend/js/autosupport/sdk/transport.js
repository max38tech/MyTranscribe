// Thin fetch wrapper. Exists so index.js never calls the global `fetch` directly -- every
// network call goes through the function this module returns, which is what makes it
// possible for a test to inject a fake and assert it was (or, for getReplies() with no
// stored reporter_token, was NOT) called. SPEC-L2.md section 7: "The SDK never retries on
// its own. A failed report throws; the host app decides."
import { ConfigError, HttpError } from './errors.js';

function defaultFetch() {
  return typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
}

// The reporter_token never appears in a URL (it's sent only via the Authorization header,
// per SPEC-L2.md section 4), so stripping the query string here is just hygiene against
// accidentally logging a `since=` timestamp or similar, not a security boundary.
function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

// Returns an async `request({ url, method, headers, body })` function bound to `fetchImpl`
// (or the global `fetch` if `fetchImpl` is omitted and one exists). `body`, when present, is
// a plain object that gets JSON-serialized; the response is parsed as JSON and returned.
// Non-2xx responses -- and outright network failures -- throw a typed HttpError carrying
// the HTTP status (0 for a network failure, since there was no response). The error message
// is built only from the URL's origin+path and the response's status/`error` code, never
// from request headers or bodies, so it can never contain a bearer token.
export function createTransport(fetchImpl) {
  const fn = fetchImpl ?? defaultFetch();
  if (typeof fn !== 'function') {
    throw new ConfigError(
      'AutoSupport SDK: no fetch implementation available; pass one via init({ fetch: yourFetch })'
    );
  }

  return async function request({ url, method = 'GET', headers = {}, body }) {
    let response;
    try {
      response = await fn(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new HttpError(
        `AutoSupport SDK: request to ${maskUrl(url)} failed: network error`,
        0
      );
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const code = data && typeof data.error === 'string' ? data.error : 'request_failed';
      const err = new HttpError(
        `AutoSupport SDK: request to ${maskUrl(url)} failed with status ${response.status} (${code})`,
        response.status
      );
      err.code = code;
      throw err;
    }

    return data;
  };
}
