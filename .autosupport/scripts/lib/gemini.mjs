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

export async function ask({
  model,
  system,
  messages,
  maxTokens = 2000,
  apiKey,
  json = false,
  transport = fetch,
}) {
  const body = {
    contents: (messages ?? []).map((m) => ({
      role: toGeminiRole(m.role),
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
    })),
    generationConfig: { maxOutputTokens: maxTokens },
  };
  // Constrained decoding beats asking politely: with this set the response is guaranteed
  // parseable, instead of depending on the model not wrapping it in prose or a fence.
  if (json) body.generationConfig.responseMimeType = 'application/json';
  if (system) body.system_instruction = { parts: [{ text: system }] };

  const res = await transport(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { [KEY_HEADER]: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `Gemini API request failed: ${res.status} ${res.statusText} - ${text.slice(0, 2000)}`
    );
    // The retry layer in llm.mjs branches on this rather than parsing the message.
    err.status = res.status;
    throw err;
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

  // A truncated response is text that happens to stop mid-token. Callers parsing JSON
  // would otherwise report "unterminated string", which describes the symptom and hides
  // the cause -- the budget, not the model, was the problem. Gemini 3.x models think
  // before answering and that reasoning is charged against maxOutputTokens, so the usable
  // budget is smaller than it looks.
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new Error(
      `Gemini API response was truncated at the ${maxTokens}-token limit (finishReason: MAX_TOKENS). ` +
        'Raise maxTokens for this call; thinking tokens count against the same budget.'
    );
  }
  return text;
}
