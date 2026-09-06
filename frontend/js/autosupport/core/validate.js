// Hand-written mirror of schema/report.v1.schema.json and
// schema/config.v1.schema.json. This file must not read those files at
// runtime (core has to run in a browser) — schema-parity.test.js is what
// keeps this transcription honest against the real JSON.
//
// Each schema below is plain data (the subset of JSON Schema keywords the
// two files actually use); validateNode() is the one generic interpreter
// that walks it. Keywords not used by either schema (oneOf, $ref, ...) are
// intentionally not supported.

const REPORT_SCHEMA = {
  type: 'object',
  required: ['schema', 'kind', 'app', 'reporter', 'title', 'fingerprint', 'idempotency_key', 'created_at'],
  additionalProperties: false,
  properties: {
    schema: { const: 'autosupport/report@1' },
    kind: { enum: ['bug', 'feature', 'support'] },
    app: {
      type: 'object',
      required: ['id', 'version', 'platform'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
        name: { type: 'string', maxLength: 120 },
        version: { type: 'string', maxLength: 64 },
        build: { type: 'string', maxLength: 64 },
        platform: { enum: ['ios', 'android', 'web', 'windows', 'macos', 'linux', 'other'] },
        locale: { type: 'string', maxLength: 35 },
      },
    },
    reporter: {
      type: 'object',
      required: ['anon_id'],
      additionalProperties: false,
      properties: {
        anon_id: { type: 'string', minLength: 8, maxLength: 128 },
        contact_ref: { type: 'string', maxLength: 128 },
        channel: { enum: ['email', 'push', 'inapp', 'none'] },
        consent: {
          type: 'object',
          additionalProperties: false,
          properties: {
            logs: { type: 'boolean' },
            contact_ok: { type: 'boolean' },
          },
        },
      },
    },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string', maxLength: 20000 },
    context: {
      type: 'object',
      additionalProperties: false,
      properties: {
        route: { type: 'string', maxLength: 200 },
        last_actions: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
        device: {
          type: 'object',
          additionalProperties: false,
          properties: {
            os: { type: 'string', maxLength: 64 },
            model: { type: 'string', maxLength: 64 },
            memory_mb: { type: 'integer', minimum: 0 },
            screen: { type: 'string', maxLength: 32 },
          },
        },
        stack: { type: 'string', maxLength: 10000 },
      },
    },
    attachments: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['type', 'redacted'],
        additionalProperties: false,
        properties: {
          type: { enum: ['client_log', 'server_log', 'screenshot', 'har', 'other'] },
          ref: { type: 'string', maxLength: 512 },
          inline: { type: 'string', maxLength: 100000 },
          bytes: { type: 'integer', minimum: 0 },
          redacted: { type: 'boolean' },
        },
      },
    },
    redaction: {
      type: 'object',
      additionalProperties: false,
      properties: {
        applied: { type: 'array', items: { type: 'string' } },
        counts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      },
    },
    fingerprint: { type: 'string', pattern: '^[0-9a-f]{16}$' },
    idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
    created_at: { type: 'string' },
    sdk: { type: 'string', maxLength: 64 },
  },
};

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['version', 'app'],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    app: {
      type: 'object',
      required: ['id', 'repo'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
        name: { type: 'string', maxLength: 120 },
        repo: { type: 'string', pattern: '^[^/]+/[^/]+$' },
        platforms: {
          type: 'array',
          items: { enum: ['ios', 'android', 'web', 'windows', 'macos', 'linux', 'other'] },
        },
      },
    },
    model: {
      type: 'object',
      additionalProperties: false,
      properties: {
        triage: { type: 'string' },
        fix: { type: 'string' },
        respond: { type: 'string' },
        chat: { type: 'string' },
      },
    },
    policy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bug: {
          type: 'object',
          additionalProperties: false,
          properties: {
            auto_fix: { type: 'boolean' },
            auto_pr: { type: 'boolean' },
            require_approval: { type: 'boolean' },
            confidence_floor: { type: 'number', minimum: 0, maximum: 1 },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
        feature: {
          type: 'object',
          additionalProperties: false,
          properties: {
            auto_fix: { type: 'boolean' },
            notify_owner: { type: 'boolean' },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
        support: {
          type: 'object',
          additionalProperties: false,
          properties: {
            chatbot: { type: 'boolean' },
            escalate_after_turns: { type: 'integer', minimum: 1 },
            confidence_floor: { type: 'number', minimum: 0, maximum: 1 },
            labels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    redaction: {
      type: 'object',
      additionalProperties: false,
      properties: {
        patterns: {
          type: 'array',
          items: { enum: ['email', 'ip', 'jwt', 'apikey', 'bearer', 'homepath', 'creditcard', 'phone'] },
        },
        custom: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'regex'],
            additionalProperties: false,
            properties: {
              name: { type: 'string', pattern: '^[a-z0-9_]{1,32}$' },
              regex: { type: 'string' },
              flags: { type: 'string', pattern: '^[gimsuy]*$' },
            },
          },
        },
      },
    },
    dedup: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window_days: { type: 'integer', minimum: 1 },
        enabled: { type: 'boolean' },
      },
    },
    knowledge: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sources: { type: 'array', items: { type: 'string' } },
        include_closed_issues: { type: 'boolean' },
        include_discussions: { type: 'boolean' },
      },
    },
    reply: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tone: { enum: ['friendly-concise', 'formal', 'playful'] },
        languages: { type: 'array', items: { type: 'string' } },
        signature: { type: 'string', maxLength: 200 },
      },
    },
  },
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const checkType = (schema, value, pointer, errors) => {
  if (!schema.type) return true;
  const actual = typeOf(value);
  if (schema.type === 'integer') {
    if (actual !== 'number' || !Number.isInteger(value)) {
      errors.push({ path: pointer, message: `expected integer, got ${actual}` });
      return false;
    }
    return true;
  }
  if (actual !== schema.type) {
    errors.push({ path: pointer, message: `expected ${schema.type}, got ${actual}` });
    return false;
  }
  return true;
};

const checkEnum = (schema, value, pointer, errors) => {
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path: pointer, message: `must be one of ${schema.enum.join(', ')}` });
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    errors.push({ path: pointer, message: `must equal ${JSON.stringify(schema.const)}` });
  }
};

const checkString = (schema, value, pointer, errors) => {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push({ path: pointer, message: `length must be >= ${schema.minLength}` });
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push({ path: pointer, message: `length must be <= ${schema.maxLength}` });
  }
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path: pointer, message: `must match pattern ${schema.pattern}` });
  }
};

const checkNumber = (schema, value, pointer, errors) => {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push({ path: pointer, message: `must be >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push({ path: pointer, message: `must be <= ${schema.maximum}` });
  }
};

const checkArray = (schema, value, pointer, errors) => {
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push({ path: pointer, message: `must have <= ${schema.maxItems} items` });
  }
  if (schema.items) {
    value.forEach((item, i) => validateNode(schema.items, item, `${pointer}/${i}`, errors));
  }
};

const checkObject = (schema, value, pointer, errors) => {
  for (const key of schema.required ?? []) {
    if (!(key in value)) {
      errors.push({ path: `${pointer}/${key}`, message: 'is required' });
    }
  }
  const props = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    const childPointer = `${pointer}/${key}`;
    if (Object.prototype.hasOwnProperty.call(props, key)) {
      validateNode(props[key], value[key], childPointer, errors);
    } else if (schema.additionalProperties === false) {
      errors.push({ path: childPointer, message: 'additional property not allowed' });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validateNode(schema.additionalProperties, value[key], childPointer, errors);
    }
  }
};

function validateNode(schema, value, pointer, errors) {
  if (value === undefined) return;
  if (!checkType(schema, value, pointer, errors)) return;
  checkEnum(schema, value, pointer, errors);
  const actual = typeOf(value);
  if (actual === 'string') checkString(schema, value, pointer, errors);
  if (actual === 'number') checkNumber(schema, value, pointer, errors);
  if (actual === 'object') checkObject(schema, value, pointer, errors);
  if (actual === 'array') checkArray(schema, value, pointer, errors);
}

const runValidation = (schema, obj) => {
  const errors = [];
  validateNode(schema, obj, '', errors);
  return { valid: errors.length === 0, errors };
};

export const validateReport = (obj) => runValidation(REPORT_SCHEMA, obj);
export const validateConfig = (obj) => runValidation(CONFIG_SCHEMA, obj);
