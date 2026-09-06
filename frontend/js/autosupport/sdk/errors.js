// Base class for every error thrown by this package, so a host app can do a single
// `instanceof AutoSupportSdkError` check if it doesn't care which kind it got. Mirrors the
// shape of `AutoSupportError` in packages/core/src/errors.js, but this is a distinct
// hierarchy: the SDK has no dependency on core other than the deferred `buildEnvelope`
// import in index.js, and errors core itself throws (e.g. `ValidationError` from a bad
// report) propagate unwrapped -- they are already typed and already carry `.errors`.
export class AutoSupportSdkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutoSupportSdkError';
  }
}

// Thrown by init() when required options are missing or malformed, and by report()/
// getReplies() when a dependency they need (a fetch implementation, packages/core) isn't
// available.
export class ConfigError extends AutoSupportSdkError {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Thrown by report()/getReplies() when called before init(). SPEC-L2.md section 7:
// "Calling report/getReplies before init throws."
export class NotInitializedError extends AutoSupportSdkError {
  constructor(message) {
    super(message);
    this.name = 'NotInitializedError';
  }
}

// Thrown by transport.js for any non-2xx response, and for a fetch that rejects outright
// (network failure, status 0). `status` lets the host app branch on it (e.g. treat 429 as
// "try again later" and 4xx as "don't retry"). The message is built from the response's
// status and its `error` code only -- never from request headers or body, so it can never
// contain the reporter_token, which travels solely in the Authorization header.
export class HttpError extends AutoSupportSdkError {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
