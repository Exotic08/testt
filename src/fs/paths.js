export const ROOT = process.env.CLAUDEX_ROOT || process.cwd();

export const PROTECTED_PATHS = Object.freeze([
  '.env.example',
  '.gitignore',
  'package.json',
  'package-lock.json',
  'server.js',
  'node_modules',
  'skills',
  '.npm',
  '.cache'
]);

function normalizeRelative(relative) {
  return String(relative || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function rootPath(root) {
  const value = root || ROOT;
  const absolute = value.startsWith('/') ? value : (process.cwd() + '/' + value);
  const normalized = absolute.split('/').filter((part) => part.length > 0);
  return '/' + normalized.join('/');
}

export function violation(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return PROTECTED_PATHS.find((protectedPath) => {
    const target = normalizeRelative(protectedPath);
    return normalized === target || normalized.startsWith(target + '/');
  }) || null;
}

export function isProtected(absolutePath, root) {
  const base = rootPath(root);
  const absolute = String(absolutePath || '');
  let relative = absolute;
  if (absolute === base) relative = '';
  else if (absolute.startsWith(base + '/')) relative = absolute.slice(base.length + 1);
  return Boolean(violation(relative));
}

export default { ROOT, PROTECTED_PATHS, violation, isProtected };
