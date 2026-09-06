// Extracts structured JSON blocks (the report envelope, and AutoSupport's own
// triage result) from GitHub issue body/comment text.
//
// Transport convention, used both by the reporting app and by triage.mjs:
//
//   <!-- autosupport:envelope -->
//   ```json
//   { ... }
//   ```
//   <!-- /autosupport:envelope -->
//
// A human filing an issue by hand will not include these markers. Every
// function here returns null rather than throwing when the markers are
// missing or the payload does not parse - callers must treat null as
// "no envelope" and fall back to the raw issue text, never crash.

export const ENVELOPE_MARKERS = Object.freeze({
  start: '<!-- autosupport:envelope -->',
  end: '<!-- /autosupport:envelope -->',
});

export const TRIAGE_MARKERS = Object.freeze({
  start: '<!-- autosupport:triage -->',
  end: '<!-- /autosupport:triage -->',
});

export function extractJsonBlock(text, startMarker, endMarker) {
  if (typeof text !== 'string') return null;
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return null;
  const between = text.slice(startIdx + startMarker.length, endIdx);
  const fenced = between.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = (fenced ? fenced[1] : between).trim();
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

export function extractEnvelope(issueBody) {
  return extractJsonBlock(issueBody, ENVELOPE_MARKERS.start, ENVELOPE_MARKERS.end);
}

// The Level 2 ingest worker returns ONLY comments carrying these markers to the end user
// (SPEC-L2.md section 5). That is an allowlist on purpose: a denylist would leak any
// comment type added later, and the triage comment carries suspected_area, confidence and
// internal summaries that a reporter must never see.
export const REPLY_MARKERS = Object.freeze({
  start: '<!-- autosupport:reply -->',
  end: '<!-- /autosupport:reply -->',
});

export function wrapReply(text) {
  return `${REPLY_MARKERS.start}\n${text}\n${REPLY_MARKERS.end}`;
}

// Returns the reply text without its markers, or null when the comment is not a reply.
export function extractReply(commentBody) {
  return extractBetween(commentBody, REPLY_MARKERS.start, REPLY_MARKERS.end);
}

function extractBetween(text, start, end) {
  if (typeof text !== 'string') return null;
  const from = text.indexOf(start);
  if (from === -1) return null;
  const to = text.indexOf(end, from + start.length);
  if (to === -1) return null;
  return text.slice(from + start.length, to).trim() || null;
}
