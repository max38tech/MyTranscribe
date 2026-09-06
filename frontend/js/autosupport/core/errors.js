// Base class for every error thrown by this package, so consumers can do a
// single `instanceof AutoSupportError` check if they don't care which kind.
export class AutoSupportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutoSupportError';
  }
}

// Thrown by validateReport/validateConfig-driven checks (buildEnvelope) when
// an assembled object fails schema validation. `errors` mirrors the return
// value of validateReport/validateConfig so callers don't have to re-run it.
export class ValidationError extends AutoSupportError {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

// Thrown by redact() when given input it cannot process (e.g. non-string).
export class RedactionError extends AutoSupportError {
  constructor(message) {
    super(message);
    this.name = 'RedactionError';
  }
}
