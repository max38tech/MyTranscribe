// Minimal Anthropic Messages API client. Deliberately no retry/backoff logic
// (SPEC.md section 2 lists that as out of scope for Level 1) - a failed call
// throws and the calling script exits non-zero.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// transport defaults to the real global fetch but is injectable so tests can
// exercise this function's status/error handling (401, 429, 500, network
// failure) without making a real network call. Any function matching
// fetch's (url, init) -> Promise<Response-like> signature works.
export async function ask({ model, system, messages, maxTokens = 2000, apiKey, transport = fetch }) {
  const res = await transport(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, system, messages, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API request failed: ${res.status} ${res.statusText} - ${body.slice(0, 2000)}`);
  }

  const data = await res.json();
  return (data.content ?? [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// Models sometimes wrap structured output (JSON, diffs) in a markdown fence
// even when told not to. Strip one leading/trailing fence, any language tag,
// so callers can parse the payload directly. Text with no fence is returned
// trimmed and unchanged.
export function stripCodeFences(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const match = trimmed.match(/^```[A-Za-z0-9_-]*\n?([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : trimmed;
}
