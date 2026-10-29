import { validationError, toErrorPayload, toolError, TIMEOUT_MS, defaultTimeoutMs } from '../../src/errors.js';
import { validate } from '../../src/validate.js';
import { log } from '../../src/log.js';

function runWithTimeout(fn, timeoutMs, toolName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(toolError('E_TIMEOUT', 'Tool "' + toolName + '" exceeded the ' + timeoutMs + 'ms timeout', { timeoutMs: timeoutMs }));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve()
      .then(fn)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

export function createToolRunner(options) {
  const settings = options || {};
  const toolName = settings.name || 'unknown';
  const schema = settings.schema || { type: 'object', properties: {} };

  return async function runTool(input, context) {
    let args = input;
    try {
      const checked = validate(schema, input === undefined ? {} : input);
      if (!checked.ok) {
        const error = validationError(checked.errors);
        const payload = toErrorPayload(error);
        log('warn', toolName, payload);
        return payload;
      }
      args = checked.value;
    } catch (err) {
      const payload = toErrorPayload(toolError(ERROR_CODES.VALIDATION, 'Invalid input', { cause: err && err.message }));
      log('error', toolName, payload);
      return payload;
    }

    const ctx = context || {};
    const timeoutMs = ctx.timeoutMs !== undefined ? defaultTimeoutMs(ctx.timeoutMs) : TIMEOUT_MS;
    const effectiveCtx = Object.assign({}, ctx, { timeoutMs: timeoutMs });

    try {
      const result = await runWithTimeout(() => settings.handler(args, effectiveCtx), timeoutMs, toolName);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        const payload = toErrorPayload(toolError(ERROR_CODES.IO, 'Tool returned an invalid result shape'));
        log('error', toolName, payload);
        return payload;
      }
      log(result.ok ? 'info' : 'warn', toolName, result);
      return result;
    } catch (err) {
      const payload = toErrorPayload(err);
      log('error', toolName, payload);
      return payload;
    }
  };
}

export default { createToolRunner };
