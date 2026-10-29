import path from 'node:path';
import { createToolRunner } from './_support/createToolRunner.js';
import { writeAgentJson } from './_support/agentStore.js';
import { sandboxRoot } from './_support/sandbox.js';
import { relativePath } from '../src/fs/guard.js';
import { ERROR_CODES, toolError } from '../src/errors.js';

export const name = 'memory_save';

export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 200 },
    value: { type: 'string' },
    tags: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', minLength: 1, maxLength: 100 }
    },
    action_summary: { type: 'string' }
  }
};

export function sanitizeKey(rawKey) {
  const cleaned = String(rawKey)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_.]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  return cleaned;
}

export async function handler(input, context) {
  const base = sandboxRoot(context);
  const safeKey = sanitizeKey(input.key).replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  if (!safeKey || safeKey === '.' || safeKey === '..' || safeKey.includes('..')) {
    throw toolError(ERROR_CODES.VALIDATION, 'Key becomes empty or unsafe after sanitizing', { key: input.key });
  }
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0) : [];
  const record = {
    key: safeKey,
    originalKey: String(input.key),
    value: String(input.value),
    tags: tags,
    updatedAt: new Date().toISOString()
  };
  const target = writeAgentJson(context, path.join('memory', safeKey + '.json'), record);
  return {
    ok: true,
    key: safeKey,
    path: relativePath(target, base),
    tags: tags
  };
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
