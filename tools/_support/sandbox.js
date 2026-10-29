import path from 'node:path';
import { ROOT } from '../../src/fs/paths.js';
import { ERROR_CODES, toolError } from '../../src/errors.js';
import { resolvePath } from '../../src/fs/guard.js';

const MINIMUM_TIMEOUT_MS = 50;

export function assertRootUsable(root) {
  const base = path.resolve(root || ROOT);
  if (!path.isAbsolute(base)) {
    throw toolError(ERROR_CODES.IO, 'Root path must be absolute', { root: base });
  }
  return base;
}

export function sandboxRoot(context) {
  const candidate = context && context.root ? context.root : ROOT;
  return assertRootUsable(candidate);
}

export function withinSandbox(context, target) {
  const base = sandboxRoot(context);
  const resolved = resolvePath(target, base);
  return { base: base, absolute: resolved };
}

export function timeoutFor(context, fallback) {
  const value = context && Number(context.timeoutMs);
  if (Number.isFinite(value) && value >= MINIMUM_TIMEOUT_MS) return value;
  return fallback;
}

export function withTimeout(promise, timeoutMs, message, details) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, error: toolError(ERROR_CODES.TIMEOUT, message || 'Operation timed out', details) });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value: value });
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, error: err });
    });
  });
}

export default { assertRootUsable, sandboxRoot, withinSandbox, timeoutFor, withTimeout };
