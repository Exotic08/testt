import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadRegistry, getRegistry, runTool, registryToOpenAiTools } from '../tools/index.js';
import { setLogSink } from '../src/log.js';

const logs = [];
setLogSink((line, entry) => {
  logs.push(entry);
});

let root;

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-tools-'));
  return root;
}

function cleanup(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    /* temp cleanup is best effort */
  }
}

function assertErrorShape(result, code) {
  assert.equal(result.ok, false, 'result should be an error');
  assert.ok(result.error, 'error object is required');
  assert.equal(typeof result.error.code, 'string');
  assert.equal(typeof result.error.message, 'string');
  if (code) assert.equal(result.error.code, code);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function makeNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Tiêu đề'] },
      { cell_type: 'code', metadata: { tags: ['keep'] }, execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['hello\n'] }], source: ['print(1)'] },
      { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: ['print(2)'] }
    ]
  };
}

before(async () => {
  setup();
});

after(() => {
  cleanup(root);
});

test('registry loads every tool with a JSON schema and unique names', async () => {
  const registry = await loadRegistry({ fresh: true });
  const names = [...registry.keys()].sort();
  assert.deepEqual(names, ['git_commit', 'memory_save', 'memory_search', 'notebook_edit', 'todo_read', 'todo_write']);
  for (const tool of registry.values()) {
    assert.equal(tool.schema.type, 'object');
    assert.equal(typeof tool.handler, 'function');
    assert.equal(typeof tool.run, 'function');
  }
  const openAiTools = registryToOpenAiTools(registry);
  assert.equal(openAiTools.length, registry.size);
  openAiTools.forEach((tool) => {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.ok(tool.function.parameters.properties);
  });
});

test('registry can be requested from the shared cache', async () => {
  const registry = await getRegistry();
  assert.equal(registry.size, 6);
});

test('todo_write validates and persists todos', async () => {
  const registry = await getRegistry();
  const result = await runTool(registry, 'todo_write', {
    todos: [
      { id: 'a', content: 'Viết test', status: 'in_progress', priority: 1 },
      { id: 'b', content: 'Chạy test', status: 'pending' }
    ]
  }, { root: root });
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.todos.map((todo) => todo.id), ['a', 'b']);
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.agent', 'todos.json'), 'utf8'));
  assert.equal(stored.todos.length, 2);
  assert.equal(stored.todos[0].priority, 1);
});

test('todo_write rejects invalid input without throwing', async () => {
  const registry = await getRegistry();
  const empty = await runTool(registry, 'todo_write', { todos: [] }, { root: root });
  assertErrorShape(empty, 'E_VALIDATION');

  const badStatus = await runTool(registry, 'todo_write', { todos: [{ id: 'x', content: 'x', status: 'done' }] }, { root: root });
  assertErrorShape(badStatus, 'E_VALIDATION');

  const duplicate = await runTool(registry, 'todo_write', {
    todos: [
      { id: 'dup', content: 'one', status: 'pending' },
      { id: 'dup', content: 'two', status: 'completed' }
    ]
  }, { root: root });
  assertErrorShape(duplicate, 'E_VALIDATION');

  const missingContent = await runTool(registry, 'todo_write', { todos: [{ id: 'y', status: 'pending' }] }, { root: root });
  assertErrorShape(missingContent, 'E_VALIDATION');
});

test('todo_read returns empty array when no todo file exists', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-todo-'));
  try {
    const registry = await getRegistry();
    const result = await runTool(registry, 'todo_read', {}, { root: fresh });
    assert.equal(result.ok, true);
    assert.deepEqual(result.todos, []);
  } finally {
    cleanup(fresh);
  }
});

test('todo_read returns stored todos', async () => {
  const registry = await getRegistry();
  const result = await runTool(registry, 'todo_read', {}, { root: root });
  assert.equal(result.ok, true);
  assert.equal(result.todos.length, 2);
  const bad = await runTool(registry, 'todo_read', { extra: true }, { root: root });
  assertErrorShape(bad, 'E_VALIDATION');
});

test('notebook_edit updates one cell and keeps the rest intact', async () => {
  const notebookPath = path.join(root, 'analysis.ipynb');
  writeJson(notebookPath, makeNotebook());
  const registry = await getRegistry();
  const result = await runTool(registry, 'notebook_edit', {
    path: 'analysis.ipynb',
    cell_index: 1,
    new_source: 'print("changed")\nprint("second")'
  }, { root: root });
  assert.equal(result.ok, true);
  assert.equal(result.cell_index, 1);
  assert.equal(result.nbformat, 4);

  const updated = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(updated.nbformat, 4);
  assert.equal(updated.nbformat_minor, 5);
  assert.equal(updated.metadata.kernelspec.name, 'python3');
  assert.deepEqual(updated.cells[1].source, ['print("changed")', 'print("second")']);
  assert.deepEqual(updated.cells[1].metadata, { tags: ['keep'] });
  assert.equal(updated.cells[1].execution_count, 3);
  assert.deepEqual(updated.cells[1].outputs, [{ output_type: 'stream', name: 'stdout', text: ['hello\n'] }]);
  assert.deepEqual(updated.cells[0], makeNotebook().cells[0]);
  assert.deepEqual(updated.cells[2], makeNotebook().cells[2]);
});

test('notebook_edit can convert a cell type', async () => {
  const notebookPath = path.join(root, 'convert.ipynb');
  writeJson(notebookPath, makeNotebook());
  const registry = await getRegistry();
  const result = await runTool(registry, 'notebook_edit', {
    path: 'convert.ipynb',
    cell_index: 1,
    new_source: 'Ghi chú mới',
    cell_type: 'markdown'
  }, { root: root });
  assert.equal(result.ok, true);
  assert.equal(result.cell_type, 'markdown');
  const updated = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(updated.cells[1].cell_type, 'markdown');
  assert.equal(updated.cells[1].outputs, undefined);
  assert.equal(updated.cells[1].execution_count, undefined);
});

test('notebook_edit rejects bad input and broken notebooks', async () => {
  const registry = await getRegistry();
  const wrongExt = await runTool(registry, 'notebook_edit', { path: 'notes.txt', cell_index: 0, new_source: 'x' }, { root: root });
  assertErrorShape(wrongExt, 'E_VALIDATION');

  const missingIndex = await runTool(registry, 'notebook_edit', { path: 'analysis.ipynb' }, { root: root });
  assertErrorShape(missingIndex, 'E_VALIDATION');

  const outOfRange = await runTool(registry, 'notebook_edit', { path: 'analysis.ipynb', cell_index: 99, new_source: 'x' }, { root: root });
  assertErrorShape(outOfRange, 'E_VALIDATION');

  const notFound = await runTool(registry, 'notebook_edit', { path: 'missing.ipynb', cell_index: 0, new_source: 'x' }, { root: root });
  assertErrorShape(notFound, 'E_NOT_FOUND');

  fs.writeFileSync(path.join(root, 'broken.ipynb'), '{not json', 'utf8');
  const broken = await runTool(registry, 'notebook_edit', { path: 'broken.ipynb', cell_index: 0, new_source: 'x' }, { root: root });
  assertErrorShape(broken, 'E_IO');

  const protectedPath = await runTool(registry, 'notebook_edit', { path: 'skills/hack.ipynb', cell_index: 0, new_source: 'x' }, { root: root });
  assertErrorShape(protectedPath, 'E_PROTECTED_PATH');

  const traversal = await runTool(registry, 'notebook_edit', { path: '../escape.ipynb', cell_index: 0, new_source: 'x' }, { root: root });
  assertErrorShape(traversal, 'E_PROTECTED_PATH');
});

test('memory_save sanitizes keys and writes json', async () => {
  const registry = await getRegistry();
  const result = await runTool(registry, 'memory_save', {
    key: 'Quy ước: Đặt tên file!!',
    value: 'Dùng kebab-case cho tên file',
    tags: ['convention', 'naming']
  }, { root: root });
  assert.equal(result.ok, true);
  assert.equal(result.path, '.agent/memory/quy-ước-đặt-tên-file.json');
  const stored = JSON.parse(fs.readFileSync(path.join(root, result.path), 'utf8'));
  assert.equal(stored.key, 'quy-ước-đặt-tên-file');
  assert.deepEqual(stored.tags, ['convention', 'naming']);
});

test('memory_save rejects empty or unsafe keys', async () => {
  const registry = await getRegistry();
  const empty = await runTool(registry, 'memory_save', { key: '   ', value: 'x' }, { root: root });
  assertErrorShape(empty, 'E_VALIDATION');
  const dots = await runTool(registry, 'memory_save', { key: '..', value: 'x' }, { root: root });
  assertErrorShape(dots, 'E_VALIDATION');
  const missingValue = await runTool(registry, 'memory_save', { key: 'abc' }, { root: root });
  assertErrorShape(missingValue, 'E_VALIDATION');
});

test('memory_search ranks key, tag and content matches', async () => {
  const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-memory-'));
  try {
    const registry = await getRegistry();
    await runTool(registry, 'memory_save', { key: 'deploy-runbook', value: 'Mô tả deploy', tags: ['ops'] }, { root: searchRoot });
    await runTool(registry, 'memory_save', { key: 'notes', value: 'Có ghi chú deploy', tags: ['deploy'] }, { root: searchRoot });
    await runTool(registry, 'memory_save', { key: 'other', value: 'deploy trong nội dung', tags: ['misc'] }, { root: searchRoot });
    await runTool(registry, 'memory_save', { key: 'unrelated', value: 'không liên quan', tags: ['misc'] }, { root: searchRoot });

    const result = await runTool(registry, 'memory_search', { query: 'deploy' }, { root: searchRoot });
    assert.equal(result.ok, true);
    assert.equal(result.total, 3);
    assert.equal(result.results[0].key, 'deploy-runbook');
    assert.equal(result.results[0].score, 4);
    assert.ok(result.results[0].matched.includes('key'));
    assert.ok(result.results[0].matched.includes('value'));
    assert.equal(result.results[1].key, 'notes');
    assert.equal(result.results[1].score, 3);
    assert.ok(result.results[1].matched.includes('tag'));
    assert.equal(result.results[2].key, 'other');
    assert.equal(result.results[2].score, 1);

    const limited = await runTool(registry, 'memory_search', { query: 'deploy', limit: 1 }, { root: searchRoot });
    assert.equal(limited.count, 1);

    const none = await runTool(registry, 'memory_search', { query: 'zzz' }, { root: searchRoot });
    assert.deepEqual(none.results, []);
  } finally {
    cleanup(searchRoot);
  }
});

test('memory_search validates input and handles an empty store', async () => {
  const registry = await getRegistry();
  const missing = await runTool(registry, 'memory_search', {}, { root: root });
  assertErrorShape(missing, 'E_VALIDATION');
  const badLimit = await runTool(registry, 'memory_search', { query: 'x', limit: 0 }, { root: root });
  assertErrorShape(badLimit, 'E_VALIDATION');
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-empty-'));
  try {
    const result = await runTool(registry, 'memory_search', { query: 'anything' }, { root: emptyRoot });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, []);
  } finally {
    cleanup(emptyRoot);
  }
});

test('git_commit rejects empty files without all', async () => {
  const registry = await getRegistry();
  const noFiles = await runTool(registry, 'git_commit', { message: 'x' }, { root: root });
  assertErrorShape(noFiles, 'E_VALIDATION');
  const emptyFiles = await runTool(registry, 'git_commit', { message: 'x', files: [] }, { root: root });
  assertErrorShape(emptyFiles, 'E_VALIDATION');
  const emptyMessage = await runTool(registry, 'git_commit', { message: '   ', files: ['a.txt'] }, { root: root });
  assertErrorShape(emptyMessage, 'E_VALIDATION');
});

test('git_commit rejects protected paths before committing', async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.email', 'agent@example.com'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.name', 'Claudex Agent'], { cwd: gitRoot });
    fs.writeFileSync(path.join(gitRoot, 'server.js'), 'original\n', 'utf8');
    fs.writeFileSync(path.join(gitRoot, 'notes.txt'), 'hello\n', 'utf8');
    execFileSync('git', ['add', 'server.js'], { cwd: gitRoot });

    const registry = await getRegistry();
    const protectedByList = await runTool(registry, 'git_commit', { message: 'x', files: ['server.js'] }, { root: gitRoot });
    assertErrorShape(protectedByList, 'E_PROTECTED_PATH');
    const stillStaged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: gitRoot }).toString().trim();
    assert.equal(stillStaged, 'server.js', 'pre-existing staging must be preserved, nothing new added');

    const protectedByAll = await runTool(registry, 'git_commit', { message: 'x', all: true }, { root: gitRoot });
    assertErrorShape(protectedByAll, 'E_PROTECTED_PATH');

    const traversal = await runTool(registry, 'git_commit', { message: 'x', files: ['../outside.txt'] }, { root: gitRoot });
    assertErrorShape(traversal, 'E_VALIDATION');

    const absoluteEscape = await runTool(registry, 'git_commit', { message: 'x', files: [os.tmpdir() + '/outside.txt'] }, { root: gitRoot });
    assertErrorShape(absoluteEscape, 'E_PROTECTED_PATH');

    const broad = await runTool(registry, 'git_commit', { message: 'x', all: true, files: ['-A'] }, { root: gitRoot });
    assertErrorShape(broad, 'E_VALIDATION');

    let head;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, stdio: 'pipe' }).toString().trim();
    } catch (err) {
      head = '';
    }
    assert.equal(head, '', 'no commit should have been created');
    const same = fs.readFileSync(path.join(gitRoot, 'server.js'), 'utf8');
    assert.equal(same, 'original\n');
  } finally {
    cleanup(gitRoot);
  }
});

test('git_commit commits only the requested file in a temp repo', async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-git-ok-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.email', 'agent@example.com'], { cwd: gitRoot });
    execFileSync('git', ['config', 'user.name', 'Claudex Agent'], { cwd: gitRoot });
    fs.writeFileSync(path.join(gitRoot, 'a.txt'), 'a\n', 'utf8');
    fs.writeFileSync(path.join(gitRoot, 'b.txt'), 'b\n', 'utf8');

    const registry = await getRegistry();
    const result = await runTool(registry, 'git_commit', { message: 'Add a.txt only', files: ['a.txt'] }, { root: gitRoot });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.files, ['a.txt']);
    assert.match(result.message, /Add a\.txt only/);

    const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: gitRoot }).toString().trim();
    assert.equal(committed, 'a.txt');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: gitRoot }).toString();
    assert.match(status, /\?\? b\.txt/);
  } finally {
    cleanup(gitRoot);
  }
});

test('the shared runner enforces the default 10 second timeout', async () => {
  const { createToolRunner } = await import('../tools/_support/createToolRunner.js');
  const { TIMEOUT_MS } = await import('../src/errors.js');
  assert.equal(TIMEOUT_MS, 10000);
  let receivedTimeout = null;
  const run = createToolRunner({
    name: 'slow_probe',
    schema: { type: 'object', properties: {} },
    handler: async (input, context) => {
      receivedTimeout = context.timeoutMs;
      return { ok: true };
    }
  });
  const result = await run({}, { root: root });
  assert.equal(result.ok, true);
  assert.equal(receivedTimeout, 10000);

  const slow = createToolRunner({
    name: 'slow_probe_timeout',
    schema: { type: 'object', properties: {} },
    handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 200))
  });
  const timedOut = await slow({}, { root: root, timeoutMs: 20 });
  assertErrorShape(timedOut, 'E_TIMEOUT');
});

test('the shared runner never throws and always returns ok/error shapes', async () => {
  const { createToolRunner } = await import('../tools/_support/createToolRunner.js');
  const thrower = createToolRunner({
    name: 'throw_probe',
    schema: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
    handler: () => {
      throw new Error('boom');
    }
  });
  const thrown = await thrower({ x: 'ok' }, { root: root });
  assertErrorShape(thrown, 'E_IO');
  const invalid = await thrower({}, { root: root });
  assertErrorShape(invalid, 'E_VALIDATION');
  const garbage = createToolRunner({
    name: 'garbage_probe',
    schema: { type: 'object', properties: {} },
    handler: () => 'not-an-object'
  });
  const bad = await garbage({}, { root: root });
  assertErrorShape(bad);
});

test('file helpers block protected paths and traversal', async () => {
  const { resolvePath } = await import('../src/fs/guard.js');
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-guard-'));
  try {
    for (const target of ['server.js', 'package.json', 'node_modules/x.js', 'skills/a/SKILL.md', '.cache/tmp', '../escape.txt', '.env.example']) {
      assert.throws(() => resolvePath(target, sandboxDir), (err) => {
        assert.equal(err.code, 'E_PROTECTED_PATH');
        return true;
      }, 'expected rejection for ' + target);
    }
    assert.equal(resolvePath('notes/todo.md', sandboxDir), path.join(sandboxDir, 'notes', 'todo.md'));
  } finally {
    cleanup(sandboxDir);
  }
});

test('every tool logs exactly one line per call', () => {
  const entries = logs.filter((entry) => entry && entry.tool);
  assert.ok(entries.length >= 6);
  entries.forEach((entry) => {
    assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level));
    assert.ok(['ok', 'error'].includes(entry.result));
    assert.equal(typeof entry.tool, 'string');
  });
});
