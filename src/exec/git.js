import { execFile } from 'node:child_process';
import { ERROR_CODES, defaultTimeoutMs, toolError } from '../errors.js';

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'rev-parse',
  'ls-files',
  'add',
  'commit',
  'checkout',
  'restore',
  'symbolic-ref'
]);

const FORBIDDEN_GIT_OPTIONS = new Set([
  '--hard',
  '--force',
  '-f',
  '--all',
  '-A',
  '--no-verify',
  '--amend',
  '--force-with-lease',
  '--mirror'
]);

function assertOptionAllowed(option) {
  const value = String(option || '');
  if (value.startsWith('-')) {
    if (FORBIDDEN_GIT_OPTIONS.has(value)) {
      throw toolError(ERROR_CODES.VALIDATION, 'Git option is not allowed: ' + value, { option: value });
    }
    return;
  }
}

export function runGit(args, options) {
  const settings = options || {};
  const list = Array.isArray(args) ? args : [];
  if (list.length === 0) {
    return Promise.reject(toolError(ERROR_CODES.VALIDATION, 'git arguments are required'));
  }
  const subcommand = list.find((item) => typeof item === 'string' && item.length > 0 && !item.startsWith('-'));
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(toolError(ERROR_CODES.VALIDATION, 'Git subcommand is not allowed: ' + String(subcommand), { subcommand: subcommand || null }));
  }
  try {
    list.forEach(assertOptionAllowed);
  } catch (err) {
    return Promise.reject(err);
  }
  const timeoutMs = defaultTimeoutMs(settings.timeoutMs);
  return new Promise((resolve) => {
    const child = execFile('git', list, {
      cwd: settings.cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })
    }, (error, stdout, stderr) => {
      let exitCode = 0;
      let timedOut = false;
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1;
        timedOut = Boolean(error.killed) || error.signal === 'SIGKILL';
      }
      resolve({
        exitCode: exitCode,
        timedOut: timedOut,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null
      });
    });
  });
}

export default { runGit };
