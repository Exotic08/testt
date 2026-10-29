import { createToolRunner } from './_support/createToolRunner.js';
import { readAgentJson, writeAgentJson } from './_support/agentStore.js';
import { sandboxRoot } from './_support/sandbox.js';
import { ERROR_CODES, toolError } from '../src/errors.js';

const STATUSES = ['pending', 'in_progress', 'completed'];
const TODOS_FILE = 'todos.json';

export const name = 'todo_write';

export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['todos'],
  properties: {
    todos: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'content', 'status'],
        properties: {
          id: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: STATUSES },
          priority: { type: 'number' }
        }
      }
    },
    action_summary: { type: 'string' }
  }
};

export async function handler(input, context) {
  sandboxRoot(context);
  const seen = new Set();
  const todos = input.todos.map((todo, index) => {
    const id = String(todo.id);
    if (seen.has(id)) {
      throw toolError(ERROR_CODES.VALIDATION, 'Duplicate todo id: ' + id, { index: index, id: id });
    }
    seen.add(id);
    const entry = {
      id: id,
      content: String(todo.content),
      status: todo.status
    };
    if (todo.priority !== undefined) entry.priority = todo.priority;
    return entry;
  });
  const stored = {
    updatedAt: new Date().toISOString(),
    todos: todos
  };
  writeAgentJson(context, TODOS_FILE, stored);
  return { ok: true, count: todos.length, todos: todos };
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
