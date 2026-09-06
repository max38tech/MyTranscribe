import { RedactionError } from './errors.js';

// A single non-word-boundary-safe character class shared by bearer/apikey
// token bodies, kept as a fragment so the individual patterns stay readable.
const TOKEN_CHARS = '[A-Za-z0-9._~+/=-]+';

// IPv6 has no single simple regex; this is the standard group-based
// decomposition (full form, every valid "::" compression length, and the
// bare "::" case) joined with the IPv4 dotted-quad below.
//
// Order within this alternation matters, and not just for which name gets
// credited (as with bearer/apikey above): JS regex alternation commits to
// the first alternative that matches at a position rather than the longest
// one. The "N groups then ::" alternative is a valid (shorter) match for
// any compressed address that also has groups *after* the "::", so trying
// it before the "::  then groups" alternatives truncated addresses like
// 2001:db8:85a3::8a2e:370:7334 at the "::" and left "8a2e:370:7334" - part
// of a real address - unredacted. Trying the alternatives with the most
// groups after "::" first, down to the fewest, then the leading-:: forms,
// and only then the trailing-::-with-nothing-after form last, means a
// shorter alternative only ever wins when no longer one could have matched.
const IPV6_GROUP = '[0-9a-fA-F]{1,4}';
const IPV6_ALTERNATIVES = [
  `(?:${IPV6_GROUP}:){7}${IPV6_GROUP}`,
  `(?:${IPV6_GROUP}:){1,2}(?::${IPV6_GROUP}){1,5}`,
  `(?:${IPV6_GROUP}:){1,3}(?::${IPV6_GROUP}){1,4}`,
  `(?:${IPV6_GROUP}:){1,4}(?::${IPV6_GROUP}){1,3}`,
  `(?:${IPV6_GROUP}:){1,5}(?::${IPV6_GROUP}){1,2}`,
  `(?:${IPV6_GROUP}:){1,6}:${IPV6_GROUP}`,
  `${IPV6_GROUP}:(?:(?::${IPV6_GROUP}){1,6})`,
  `:(?:(?::${IPV6_GROUP}){1,7}|:)`,
  `(?:${IPV6_GROUP}:){1,7}:`,
].join('|');
const IPV4 =
  '(?:(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP_REGEX = new RegExp(`\\b${IPV4}\\b|\\[?(?:${IPV6_ALTERNATIVES})\\]?`, 'g');

// Order matters: jwt before bearer before apikey (so "Authorization: Bearer
// eyJ..." is claimed by the more specific patterns first), and homepath last
// so it never eats a match one of the earlier patterns should have owned.
export const REDACTORS = [
  { name: 'jwt', regex: /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}/g },
  {
    name: 'bearer',
    regex: new RegExp(
      `\\bBearer\\s+${TOKEN_CHARS}|\\bAuthorization:\\s*[A-Za-z][A-Za-z0-9]*\\s+${TOKEN_CHARS}`,
      'gi'
    ),
  },
  {
    name: 'apikey',
    // The sk- branch allows interior hyphens. Without them it could not match
    // sk-ant-api03-... : the hyphen after "ant" ended the character class well short of
    // the length requirement. That is the Anthropic key format, which every AutoSupport
    // install must configure, making it the credential most likely of all to appear in a
    // user's logs and the one that must never be the one we miss. Same story for
    // OpenAI's sk-proj- keys.
    regex:
      /\bsk-[A-Za-z0-9-]{9,}[A-Za-z0-9]\b|\b[sprk]k_(?:live|test)_[A-Za-z0-9]{10,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]+\b|\b[0-9a-fA-F]{32,}\b/g,
  },
  { name: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'ip', regex: IP_REGEX },
  { name: 'creditcard', regex: /\b(?:\d[ -]?){12,18}\d\b/g },
  { name: 'phone', regex: /\+[1-9]\d{6,14}\b/g },
  {
    name: 'homepath',
    // Group 1 is the drive/prefix we keep; the username itself is discarded.
    // The negative lookahead stops this from ever re-matching a token this
    // same pattern already emitted (idempotency on a second redact() pass).
    regex: /([A-Za-z]:\\Users\\|\/home\/|\/Users\/)(?!\[REDACTED:)[^\\/]+/g,
  },
];

const luhnValid = (digits) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

// Most patterns replace the whole match outright.
const defaultApplier = (text, regex, name) => {
  let count = 0;
  const token = `[REDACTED:${name}]`;
  const out = text.replace(regex, () => {
    count += 1;
    return token;
  });
  return { text: out, count };
};

// homepath keeps everything but the username segment (group 1 is the
// drive/prefix, e.g. "C:\Users\").
const homepathApplier = (text, regex) => {
  let count = 0;
  const token = '[REDACTED:homepath]';
  const out = text.replace(regex, (_match, prefix) => {
    count += 1;
    return prefix + token;
  });
  return { text: out, count };
};

// creditcard only redacts candidates that pass Luhn; anything else (the
// "near miss") is left untouched and not counted.
const creditcardApplier = (text, regex) => {
  let count = 0;
  const token = '[REDACTED:creditcard]';
  const out = text.replace(regex, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      count += 1;
      return token;
    }
    return match;
  });
  return { text: out, count };
};

const APPLIERS = {
  homepath: homepathApplier,
  creditcard: creditcardApplier,
};

const ensureGlobal = (flags) => (flags.includes('g') ? flags : `${flags}g`);

// Ten times the largest field the report schema permits (attachments[].inline, 100000),
// and comfortably below the ~5-8M point where a single pathological match makes
// String.replace throw RangeError. The cap is deliberately on input length rather than on
// any one pattern: bounding the offending pattern instead would have meant a hex secret
// longer than the bound stops being redacted at all, trading a loud crash for a silent
// leak. A caller handing redact() a megabyte of text has a bug worth hearing about.
const MAX_INPUT_LENGTH = 1_000_000;

export function redact(input, options = {}) {
  if (typeof input !== 'string') {
    throw new RedactionError('redact() input must be a string');
  }
  if (input.length > MAX_INPUT_LENGTH) {
    throw new RedactionError(
      `redact() input is ${input.length} characters, over the ${MAX_INPUT_LENGTH} limit; ` +
        'size-check the field before redacting it'
    );
  }

  const patternNames = options.patterns ?? REDACTORS.map((r) => r.name);
  const selected = REDACTORS.filter((r) => patternNames.includes(r.name));
  const custom = (options.custom ?? []).map((c) => ({
    name: c.name,
    regex: new RegExp(c.regex, ensureGlobal(c.flags ?? 'g')),
  }));

  let text = input;
  const counts = {};

  for (const { name, regex } of [...selected, ...custom]) {
    const apply = APPLIERS[name] ?? defaultApplier;
    const result = apply(text, regex, name);
    text = result.text;
    if (result.count > 0) {
      counts[name] = (counts[name] ?? 0) + result.count;
    }
  }

  return { text, applied: Object.keys(counts).sort(), counts };
}
