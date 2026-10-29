import { createToolRunner } from './_support/createToolRunner.js';
import { readAgentJson } from './_support/agentStore.js';
import { sandboxRoot } from './_support/sandbox.js';

const TODOS_FILE = 'todos.json';

export const name = 'todo_read';

export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action_summary: { type: 'string' }
  }
};

export async function handler(input, context) {
  sandboxRoot(context);
  const stored = readAgentJson(context, TODOS_FILE, { todos: [] });
  const todos = stored && Array.isArray(stored.todos) ? stored.todos : [];
  const result = { ok: true, count: todos.length, todos: todos };
  if (stored && stored.updatedAt) result.updatedAt = stored.updatedAt;
  return result;
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
