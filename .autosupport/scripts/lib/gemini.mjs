// Google Gemini adapter for the Generative Language API. Mirrors claude.mjs: same ask()
// shape in, plain text out, no retry/backoff (SPEC.md section 2).

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google's docs show the key as a ?key= query parameter. This sends it as a header
// instead: query strings land in server logs, proxy logs, and browser referrers, and a
// credential does not belong in any of them. x-goog-api-key is the standard Google API
// key header and is accepted here.
const KEY_HEADER = 'x-goog-api-key';

// Anthropic uses user/assistant; Gemini uses user/model. Anything else is a caller bug.
function toGeminiRole(role) {
  if (role === 'assistant') return 'model';
  if (role === 'user') return 'user';
  throw new Error(`gemini: unsupported message role "${role}"`);
}

export async function ask({ model, system, messages, maxTokens = 2000, apiKey, transport = fetch }) {
  const body = {
    contents: (messages ?? []).map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (system) body.system_instruction = { parts: [{ text: system }] };

  const res = await transport(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { [KEY_HEADER]: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API request failed: ${res.status} ${res.statusText} - ${text.slice(0, 2000)}`);
  }

  const data = await res.json();

  // A safety block returns HTTP 200 with no candidates, or a candidate carrying a
  // finishReason and no parts. Both must read as a clear failure rather than as an empty
  // reply, or the caller will post an empty comment and call it success.
  const candidate = (data.candidates ?? [])[0];
  if (!candidate) {
    const reason = data.promptFeedback?.blockReason ?? 'no candidates returned';
    throw new Error(`Gemini API returned no usable response: ${reason}`);
  }

  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');

  if (!text) {
    throw new Error(
      `Gemini API returned an empty response (finishReason: ${candidate.finishReason ?? 'unknown'})`
    );
  }
  return text;
}
