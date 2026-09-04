// Provider router. The model id selects the provider, so config.yml needs no separate
// provider field and each stage can use a different vendor -- e.g. a cheap model for
// high-volume triage and a stronger one for the fix stage, where a bad patch costs more
// than a bad label.

import { ask as askAnthropic } from './claude.mjs';
import { ask as askGemini } from './gemini.mjs';

const PROVIDERS = {
  anthropic: { match: /^claude-/, keyEnv: 'ANTHROPIC_API_KEY', ask: askAnthropic },
  google: { match: /^gemini-/, keyEnv: 'GEMINI_API_KEY', ask: askGemini },
};

export function providerFor(model) {
  if (typeof model !== 'string' || !model) {
    throw new Error(`llm: model must be a non-empty string, got ${JSON.stringify(model)}`);
  }
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    if (spec.match.test(model)) return name;
  }
  const known = Object.values(PROVIDERS)
    .map((p) => String(p.match).replace(/[/^]/g, ''))
    .join(', ');
  throw new Error(`llm: cannot determine a provider for model "${model}" (expected one of: ${known}*)`);
}

export function apiKeyEnvFor(model) {
  return PROVIDERS[providerFor(model)].keyEnv;
}

// env is passed in rather than read from process.env so tests can drive this without
// mutating global state, and so a missing key names the exact variable to set.
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ask({
  model,
  system,
  messages,
  maxTokens,
  env = {},
  transport,
  workspaceId,
  json,
  attempts,
  sleep,
}) {
  const provider = providerFor(model);
  const spec = PROVIDERS[provider];
  const apiKey = env[spec.keyEnv];

  if (!apiKey) {
    throw new Error(
      `llm: ${spec.keyEnv} is not set, but model "${model}" requires it (provider: ${provider})`
    );
  }

  const args = { model, system, messages, maxTokens, apiKey };
  // Only Google exposes constrained JSON decoding through this client; for Anthropic the
  // prompt is the only constraint, so the flag is simply not forwarded.
  if (provider === 'google' && json) args.json = true;
  if (transport) args.transport = transport;
  // Only Anthropic takes a workspace id; passing it to another provider would be a bug.
  if (provider === 'anthropic' && workspaceId) args.workspaceId = workspaceId;

  return withRetry(() => spec.ask(args), { attempts, sleep });
}

// SPEC.md section 2 originally listed retry as a non-goal. Dogfooding overturned that:
// two of the first four live calls came back 503 "experiencing high demand", which is a
// normal condition on a free tier, not an outage. These workflows run unattended, so
// giving up permanently on an explicitly transient failure means issues silently go
// untriaged and nobody finds out.
//
// This is a bounded retry, not retry infrastructure: three attempts, only for statuses
// the provider itself describes as temporary. Every 4xx except 429 is a permanent
// failure -- a bad key or a malformed request will fail identically forever, and
// retrying it wastes quota and delays the error the operator needs to see.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function withRetry(fn, { attempts = 3, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = TRANSIENT_STATUSES.has(err?.status);
      if (!retryable || attempt === attempts) throw err;
      // Backoff with jitter: several workflows can fire at once on a busy repo, and
      // retrying in lockstep would recreate the spike that caused the 503.
      const base = 1000 * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * 500));
    }
  }
  throw lastError;
}
