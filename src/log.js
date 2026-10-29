const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
let sink = null;

function normalizeLevel(level) {
  const value = String(level || 'info').toLowerCase();
  return LEVELS.has(value) ? value : 'info';
}

function writeLine(entry) {
  const line = JSON.stringify(entry);
  if (sink) {
    sink(line, entry);
    return;
  }
  try {
    process.stderr.write(line + '\n');
  } catch (err) {
    /* logging must never throw */
  }
}

export function log(level, tool, result, details) {
  const normalized = normalizeLevel(level);
  const outcome = result && result.ok === true ? 'ok' : 'error';
  const errorCode = result && result.ok === false && result.error ? result.error.code : undefined;
  const entry = {
    ts: new Date().toISOString(),
    level: normalized,
    tool: tool ? String(tool) : 'unknown',
    result: outcome
  };
  if (errorCode) entry.code = errorCode;
  if (details && Object.keys(details).length > 0) entry.details = details;
  writeLine(entry);
}

export function createLogger(prefix) {
  return (result, details) => {
    const level = result && result.ok === true ? 'info' : 'error';
    log(level, prefix, result, details);
  };
}

export function setLogSink(fn) {
  sink = typeof fn === 'function' ? fn : null;
}

export default { log, createLogger, setLogSink };
