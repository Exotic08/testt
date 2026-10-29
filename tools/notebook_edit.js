import fs from 'node:fs';
import path from 'node:path';
import { createToolRunner } from './_support/createToolRunner.js';
import { sandboxRoot } from './_support/sandbox.js';
import { readJsonFile, resolvePath, relativePath, writeJsonAtomic } from '../src/fs/guard.js';
import { ERROR_CODES, toolError } from '../src/errors.js';

const CELL_TYPES = ['code', 'markdown', 'raw'];

export const name = 'notebook_edit';

export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'cell_index', 'new_source'],
  properties: {
    path: { type: 'string', minLength: 1 },
    cell_index: { type: 'integer', minimum: 0 },
    new_source: { type: 'string' },
    cell_type: { type: 'string', enum: CELL_TYPES },
    action_summary: { type: 'string' }
  }
};

function buildSourceLines(source) {
  if (source === '') return [];
  return source.split(/\r?\n/);
}

export async function handler(input, context) {
  const base = sandboxRoot(context);
  const requested = String(input.path);
  if (!requested.toLowerCase().endsWith('.ipynb')) {
    throw toolError(ERROR_CODES.VALIDATION, 'Notebook path must end with .ipynb', { path: requested });
  }
  const absolute = resolvePath(requested, base);
  if (!fs.existsSync(absolute)) {
    throw toolError(ERROR_CODES.NOT_FOUND, 'Notebook not found: ' + relativePath(absolute, base), { path: relativePath(absolute, base) });
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) {
    throw toolError(ERROR_CODES.VALIDATION, 'Path is not a file: ' + relativePath(absolute, base), { path: relativePath(absolute, base) });
  }

  const notebook = readJsonFile(absolute);
  if (!notebook || typeof notebook !== 'object' || Array.isArray(notebook)) {
    throw toolError(ERROR_CODES.IO, 'Notebook root must be a JSON object', { path: relativePath(absolute, base) });
  }
  if (!Array.isArray(notebook.cells)) {
    throw toolError(ERROR_CODES.IO, 'Notebook has no cells array', { path: relativePath(absolute, base) });
  }
  const index = input.cell_index;
  if (index < 0 || index >= notebook.cells.length) {
    throw toolError(ERROR_CODES.VALIDATION, 'cell_index is out of range (0-' + (notebook.cells.length - 1) + ')', { cell_index: index, cells: notebook.cells.length });
  }
  const cell = notebook.cells[index];
  if (!cell || typeof cell !== 'object') {
    throw toolError(ERROR_CODES.IO, 'Target cell is malformed', { cell_index: index });
  }

  const previousType = typeof cell.cell_type === 'string' ? cell.cell_type : 'code';
  const nextType = input.cell_type || previousType;
  const source = buildSourceLines(input.new_source);

  const updated = Object.assign({}, cell, {
    cell_type: nextType,
    source: source
  });

  if (nextType === 'code') {
    if (!Array.isArray(updated.outputs)) updated.outputs = [];
    if (updated.execution_count === undefined) updated.execution_count = null;
  } else {
    delete updated.outputs;
    delete updated.execution_count;
  }

  const nextCells = notebook.cells.slice();
  nextCells[index] = updated;
  const nextNotebook = Object.assign({}, notebook, {
    cells: nextCells,
    nbformat: typeof notebook.nbformat === 'number' ? notebook.nbformat : 4,
    nbformat_minor: typeof notebook.nbformat_minor === 'number' ? notebook.nbformat_minor : 5
  });
  if (!nextNotebook.metadata || typeof nextNotebook.metadata !== 'object') {
    nextNotebook.metadata = {};
  }

  writeJsonAtomic(absolute, nextNotebook);

  return {
    ok: true,
    path: relativePath(absolute, base),
    cell_index: index,
    previous_cell_type: previousType,
    cell_type: nextType,
    source_lines: source.length,
    cells: nextCells.length,
    nbformat: nextNotebook.nbformat,
    directory: path.dirname(absolute)
  };
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
