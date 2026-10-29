import fs from 'node:fs';
import path from 'node:path';
import { ROOT, violation } from './paths.js';
import { ERROR_CODES, toolError } from '../errors.js';

export function resolvePath(input, root) {
  const base = path.resolve(root || ROOT);
  const raw = String(input === undefined || input === null ? '' : input);
  if (raw.includes('\u0000')) {
    throw toolError(ERROR_CODES.VALIDATION, 'Path contains a null byte', { path: raw });
  }
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  const relativeToBase = path.relative(base, absolute);
  if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
    throw toolError(ERROR_CODES.PROTECTED_PATH, 'Path escapes the workspace: ' + raw, { path: raw });
  }
  const protectedHit = violation(relativeToBase);
  if (protectedHit) {
    throw toolError(ERROR_CODES.PROTECTED_PATH, 'Path is protected: ' + protectedHit, { path: relativeToBase, protected: protectedHit });
  }
  return absolute;
}

export function relativePath(absolute, root) {
  const base = path.resolve(root || ROOT);
  const relative = path.relative(base, absolute);
  return relative.split(path.sep).join('/');
}

export function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    return true;
  } catch (err) {
    throw toolError(ERROR_CODES.IO, 'Cannot create directory: ' + directory, { cause: err.message, path: directory });
  }
}

export function readJsonFile(absolute, options) {
  const settings = options || {};
  if (!fs.existsSync(absolute)) {
    if (settings.missingDefault !== undefined) return settings.missingDefault;
    throw toolError(ERROR_CODES.NOT_FOUND, 'File not found: ' + absolute, { path: absolute });
  }
  let raw;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch (err) {
    throw toolError(ERROR_CODES.IO, 'Cannot read file: ' + absolute, { cause: err.message, path: absolute });
  }
  if (!settings.allowEmpty && raw.trim() === '') {
    if (settings.emptyDefault !== undefined) return settings.emptyDefault;
    throw toolError(ERROR_CODES.IO, 'File is empty: ' + absolute, { path: absolute });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw toolError(ERROR_CODES.IO, 'File is not valid JSON: ' + absolute, { cause: err.message, path: absolute });
  }
}

export function writeFileAtomic(absolute, content, options) {
  const settings = options || {};
  const directory = path.dirname(absolute);
  ensureDirectory(directory);
  const suffix = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const temporary = path.join(directory, '.' + path.basename(absolute) + '.' + suffix + '.tmp');
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: settings.mode || 0o644 });
    fs.renameSync(temporary, absolute);
  } catch (err) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch (cleanupErr) {
      /* temporary file cleanup is best effort */
    }
    throw toolError(ERROR_CODES.IO, 'Cannot write file: ' + absolute, { cause: err.message, path: absolute });
  }
  return absolute;
}

export function writeJsonAtomic(absolute, value) {
  return writeFileAtomic(absolute, JSON.stringify(value, null, 2) + '\n');
}

export function removeFile(absolute) {
  try {
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch (err) {
    throw toolError(ERROR_CODES.IO, 'Cannot remove file: ' + absolute, { cause: err.message, path: absolute });
  }
}

export default { resolvePath, relativePath, ensureDirectory, readJsonFile, writeFileAtomic, writeJsonAtomic, removeFile };
