export const ERROR_CODES = Object.freeze({
  VALIDATION: 'E_VALIDATION',
  TIMEOUT: 'E_TIMEOUT',
  PROTECTED_PATH: 'E_PROTECTED_PATH',
  NOT_FOUND: 'E_NOT_FOUND',
  IO: 'E_IO'
});

const DEFAULT_TIMEOUT_MS = 10000;

export class ToolError extends Error {
  constructor(code, message, details, extra) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
    this.extra = extra || {};
  }
}

export function toolError(code, message, details, extra) {
  return new ToolError(code, message, details, extra);
}

export function validationError(errors, message) {
  const list = Array.isArray(errors) ? errors : [String(errors)];
  return new ToolError(ERROR_CODES.VALIDATION, message || list[0] || 'Invalid input', { errors: list });
}

export function toErrorPayload(err, fallbackCode) {
  if (err instanceof ToolError) {
    const payload = { code: err.code, message: err.message };
    if (err.details !== undefined) payload.details = err.details;
    const extraKeys = Object.keys(err.extra || {});
    extraKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(payload, key)) payload[key] = err.extra[key];
    });
    return Object.assign({ ok: false, error: payload }, err.extra || {});
  }
  const code = fallbackCode || ERROR_CODES.IO;
  const message = err && err.message ? err.message : String(err);
  const payload = { code: code, message: message };
  if (err && Array.isArray(err.details && err.details.errors)) {
    payload.details = err.details;
  }
  if (err && err.code && typeof err.code === 'string' && err.code.startsWith('E_')) {
    payload.details = { syscall: err.syscall || null, path: err.path || null, errno: err.errno || null };
  }
  return { ok: false, error: payload };
}

export function isToolSuccess(result) {
  return Boolean(result && result.ok === true);
}

export function defaultTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

export const TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export default { ERROR_CODES, ToolError, toolError, validationError, toErrorPayload, defaultTimeoutMs, TIMEOUT_MS };
