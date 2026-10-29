import fs from 'node:fs';
import path from 'node:path';
import { createToolRunner } from './_support/createToolRunner.js';
import { agentDirectory, readAgentJson } from './_support/agentStore.js';
import { sandboxRoot } from './_support/sandbox.js';

const MEMORY_DIR = 'memory';

export const name = 'memory_search';

export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 10 },
    action_summary: { type: 'string' }
  }
};

export async function handler(input, context) {
  sandboxRoot(context);
  const query = String(input.query).toLowerCase();
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 10;
  const directory = path.join(agentDirectory(context), MEMORY_DIR);
  let files = [];
  try {
    if (fs.existsSync(directory)) {
      files = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
    }
  } catch (err) {
    files = [];
  }

  const results = [];
  files.forEach((fileName) => {
    let record;
    try {
      record = readAgentJson(context, path.join(MEMORY_DIR, fileName), null);
    } catch (err) {
      record = null;
    }
    if (!record || typeof record !== 'object') return;
    const key = String(record.key || fileName.replace(/\.json$/, ''));
    const value = String(record.value || '');
    const tags = Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [];
    let score = 0;
    const matched = [];
    if (key.toLowerCase().includes(query)) {
      score += 3;
      matched.push('key');
    }
    const tagHits = tags.filter((tag) => tag.toLowerCase().includes(query));
    if (tagHits.length > 0) {
      score += 2 * tagHits.length;
      matched.push('tag');
    }
    if (value.toLowerCase().includes(query)) {
      score += 1;
      matched.push('value');
    }
    if (score <= 0) return;
    results.push({
      key: key,
      value: value,
      tags: tags,
      path: fileName,
      score: score,
      matched: matched,
      updatedAt: record.updatedAt || null
    });
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });

  const limited = results.slice(0, limit);
  return {
    ok: true,
    query: input.query,
    total: results.length,
    count: limited.length,
    results: limited
  };
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
