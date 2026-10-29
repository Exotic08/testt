import path from 'node:path';
import { ROOT } from '../../src/fs/paths.js';
import { readJsonFile, writeJsonAtomic, writeFileAtomic } from '../../src/fs/guard.js';
import { sandboxRoot } from './sandbox.js';

export function agentDirectory(context) {
  return path.join(sandboxRoot(context), '.agent');
}

export function agentFile(context, relative) {
  const base = agentDirectory(context);
  const resolved = path.resolve(base, relative);
  const relativeToSandbox = path.relative(sandboxRoot(context), resolved);
  if (relativeToSandbox.startsWith('..') || path.isAbsolute(relativeToSandbox)) {
    const err = new Error('Agent state path escapes the workspace');
    err.code = 'E_PROTECTED_PATH';
    throw err;
  }
  return resolved;
}

export function readAgentJson(context, relative, fallback) {
  const target = agentFile(context, relative);
  return readJsonFile(target, { missingDefault: fallback, emptyDefault: fallback });
}

export function writeAgentJson(context, relative, value) {
  const target = agentFile(context, relative);
  try {
    writeJsonAtomic(target, value);
  } catch (err) {
    if (err && typeof err.path === 'string') throw err;
    const wrapped = new Error(err && err.message ? err.message : 'Cannot write agent state');
    wrapped.code = 'E_IO';
    throw wrapped;
  }
  return target;
}

export function writeAgentText(context, relative, content) {
  const target = agentFile(context, relative);
  writeFileAtomic(target, content);
  return target;
}

export { ROOT };
export default { agentDirectory, agentFile, readAgentJson, writeAgentJson, writeAgentText };
