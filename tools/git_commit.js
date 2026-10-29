import fs from 'node:fs';
import path from 'node:path';
import { createToolRunner } from './_support/createToolRunner.js';
import { sandboxRoot } from './_support/sandbox.js';
import { runGit } from '../src/exec/git.js';
import { ERROR_CODES, toolError } from '../src/errors.js';
import { violation } from '../src/fs/paths.js';
import { resolvePath, relativePath } from '../src/fs/guard.js';

const FORBIDDEN_PATH_SPECS = new Set(['-A', '--all', '.', ':/', '*']);
function parseStagedNames(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.replace(/^[A-Z?][A-Z? ]? /, '').trim())
    .filter((line) => line.length > 0);
}

export const name = 'git_commit';

export const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1, maxLength: 5000 },
    files: {
      type: 'array',
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 500, format: 'path' }
    },
    all: { type: 'boolean' },
    action_summary: { type: 'string' }
  }
};

export async function handler(input, context) {
  const base = sandboxRoot(context);
  const message = String(input.message);
  if (message.trim().length === 0) {
    throw toolError(ERROR_CODES.VALIDATION, 'Commit message must not be empty', { field: 'message' });
  }
  const useAll = input.all === true;
  const files = Array.isArray(input.files) ? input.files.map((file) => String(file)) : [];
  if (files.length === 0 && !useAll) {
    throw toolError(ERROR_CODES.VALIDATION, 'Provide a non-empty files list, or set all=true explicitly', { field: 'files' });
  }

  const stageTargets = [];
  for (const file of files) {
    if (FORBIDDEN_PATH_SPECS.has(file)) {
      throw toolError(ERROR_CODES.VALIDATION, 'Refusing to stage broad pathspec: ' + file, { path: file });
    }
    const absolute = resolvePath(file, base);
    const relative = relativePath(absolute, base);
    if (!relative || relative.startsWith('..')) {
      throw toolError(ERROR_CODES.PROTECTED_PATH, 'Path escapes the workspace: ' + file, { path: file });
    }
    const hit = violation(relative);
    if (hit) {
      throw toolError(ERROR_CODES.PROTECTED_PATH, 'Path is protected: ' + hit, { path: relative, protected: hit });
    }
    stageTargets.push(relative);
  }

  const timeoutMs = context && context.timeoutMs;
  const runAdd = async (relativeTargets) => {
    if (!Array.isArray(relativeTargets) || relativeTargets.length === 0) {
      throw toolError(ERROR_CODES.VALIDATION, 'No stageable paths resolved for git add', { files: [] });
    }
    const addArgs = ['add', '--'].concat(relativeTargets);
    const addResult = await runGit(addArgs, { cwd: base, timeoutMs: timeoutMs });
    if (addResult.timedOut) {
      throw toolError(ERROR_CODES.TIMEOUT, 'git add timed out', { stage: 'add' });
    }
    if (addResult.exitCode !== 0) {
      throw toolError(ERROR_CODES.IO, 'git add failed', { stage: 'add', stderr: addResult.stderr.trim().slice(0, 2000) });
    }
  };

  const targets = stageTargets.slice();
  if (useAll) {
    const headCheck = await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: base, timeoutMs: timeoutMs });
    if (headCheck.timedOut) throw toolError(ERROR_CODES.TIMEOUT, 'git rev-parse timed out', { stage: 'inspect' });
    const hasHead = headCheck.exitCode === 0;
    const tracked = await runGit(hasHead ? ['diff', '--name-only', 'HEAD'] : ['ls-files'], { cwd: base, timeoutMs: timeoutMs });
    if (tracked.timedOut) throw toolError(ERROR_CODES.TIMEOUT, 'git diff timed out', { stage: 'inspect' });
    if (tracked.exitCode !== 0) {
      throw toolError(ERROR_CODES.IO, 'Cannot list tracked changes', { stage: 'inspect', stderr: tracked.stderr.trim().slice(0, 2000) });
    }
    const trackedNames = parseStagedNames(tracked.stdout);
    for (const name of trackedNames) {
      const hit = violation(name);
      if (hit) {
        throw toolError(ERROR_CODES.PROTECTED_PATH, 'Tracked change touches protected path: ' + hit, { path: name, protected: hit });
      }
      resolvePath(name, base);
      if (!targets.includes(name)) targets.push(name);
    }
  }
  if (targets.length === 0) {
    throw toolError(ERROR_CODES.VALIDATION, 'Nothing to stage', { files: [] });
  }
  const existing = [];
  const missing = [];
  for (const target of targets) {
    try {
      fs.statSync(path.join(base, target));
      existing.push(target);
    } catch (err) {
      missing.push(target);
    }
  }
  if (existing.length > 0) await runAdd(existing);
  if (missing.length > 0) await runAdd(missing);

  const stagedNames = await runGit(['diff', '--cached', '--name-only'], { cwd: base, timeoutMs: context && context.timeoutMs });
  if (stagedNames.timedOut) {
    throw toolError(ERROR_CODES.TIMEOUT, 'git diff timed out', { stage: 'inspect' });
  }
  if (stagedNames.exitCode !== 0) {
    throw toolError(ERROR_CODES.IO, 'Cannot inspect staged files', { stage: 'inspect', stderr: stagedNames.stderr.trim().slice(0, 2000) });
  }
  const staged = parseStagedNames(stagedNames.stdout);
  if (staged.length === 0) {
    throw toolError(ERROR_CODES.VALIDATION, 'Nothing staged to commit', { files: [] });
  }

  const blocked = staged.filter((file) => violation(file));
  if (blocked.length > 0) {
    const unstage = ['restore', '--staged', '--'];
    blocked.forEach((file) => unstage.push(file));
    await runGit(unstage, { cwd: base, timeoutMs: context && context.timeoutMs });
    throw toolError(ERROR_CODES.PROTECTED_PATH, 'Refusing to commit protected files: ' + blocked.join(', '), { files: blocked });
  }

  const commitResult = await runGit(['commit', '-m', message], { cwd: base, timeoutMs: context && context.timeoutMs });
  if (commitResult.timedOut) {
    throw toolError(ERROR_CODES.TIMEOUT, 'git commit timed out', { stage: 'commit' });
  }
  if (commitResult.exitCode !== 0) {
    throw toolError(ERROR_CODES.IO, 'git commit failed', { stage: 'commit', stderr: commitResult.stderr.trim().slice(0, 2000) });
  }

  const head = await runGit(['rev-parse', 'HEAD'], { cwd: base, timeoutMs: context && context.timeoutMs });
  const sha = String(head.stdout || '').trim().slice(0, 40) || null;
  return {
    ok: true,
    commit: sha,
    message: message,
    files: staged,
    all: useAll,
    output: commitResult.stdout.trim().slice(0, 2000)
  };
}

export const run = createToolRunner({ name, schema, handler });

export default { name, schema, handler, run };
