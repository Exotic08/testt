import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execSync } from 'child_process';
import { getOpenAiTools, getRegistry } from './tools/index.js';

dotenv.config();

const DEFAULT_WORKSPACE_ROOT = fs.existsSync('/home/container') ? '/home/container' : process.cwd();
const PORT = parseInt(process.env.SERVER_PORT || '3000', 10);
const HOST = '0.0.0.0';
const DEFAULT_TIMEOUT = 45000;
const MAX_BUFFER = 1024 * 1024;
const MAX_STEPS_DEFAULT = 12;
const IGNORED_DIRS = new Set(['node_modules', '.git']);
const PROCESS_START = Date.now();
const DEFAULT_MODEL = 'claudex-3-5-sonnet-20241022';

let externalToolRegistry = new Map();
let externalToolSpecs = [];
try {
  externalToolRegistry = await getRegistry({ fresh: true });
  externalToolSpecs = await getOpenAiTools();
  console.log('External tools loaded: ' + Array.from(externalToolRegistry.keys()).join(', '));
} catch (err) {
  externalToolRegistry = new Map();
  externalToolSpecs = [];
  console.error('External tool registry failed to load:', err);
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const WORKSPACE_MODES = ['auto', 'picker', 'root'];
const SKILLS_DIR_NAME = 'skills';
const SKILLS_ROOT = path.join(DEFAULT_WORKSPACE_ROOT, SKILLS_DIR_NAME);
const AGENTS_FILE_NAME = 'AGENTS.md';
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

function ensureSkillsRoot() {
  try {
    fs.mkdirSync(SKILLS_ROOT, { recursive: true });
  } catch (err) {
    /* skills folder is created lazily when possible */
  }
  return SKILLS_ROOT;
}

function normalizeSkillName(name) {
  return String(name === undefined || name === null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

function isSafeSkillSlug(slug) {
  return SKILL_NAME_PATTERN.test(slug) && !slug.includes('..');
}

function parseSkillFrontmatter(text) {
  const meta = {};
  let body = String(text || '');
  if (body.startsWith('---')) {
    const end = body.indexOf('---', 3);
    if (end !== -1) {
      const rawHeader = body.slice(3, end);
      rawHeader.split(/\r?\n/).forEach((line) => {
        const idx = line.indexOf(':');
        if (idx === -1) return;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (key) meta[key] = value;
      });
      body = body.slice(end + 3).replace(/^\r?\n/, '');
    }
  }
  return { meta: meta, body: body };
}

function skillFilePath(name) {
  return path.join(SKILLS_ROOT, name, 'SKILL.md');
}

function listSkills() {
  const dir = ensureSkillsRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const skills = [];
  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    const manifest = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(manifest)) return;
    let raw = '';
    let stat = null;
    try {
      raw = fs.readFileSync(manifest, 'utf8');
      stat = fs.statSync(manifest);
    } catch (err) {
      return;
    }
    const parsed = parseSkillFrontmatter(raw);
    const firstLine = parsed.body.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
    skills.push({
      name: entry.name,
      title: parsed.meta.name || entry.name,
      description: parsed.meta.description || firstLine.replace(/^#+\s*/, '').slice(0, 140),
      path: SKILLS_DIR_NAME + '/' + entry.name + '/SKILL.md',
      size: stat ? stat.size : raw.length,
      updatedAt: stat ? stat.mtime.toISOString() : null
    });
  });
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function readSkill(name) {
  const slug = normalizeSkillName(name);
  if (!slug || !isSafeSkillSlug(slug)) {
    const err = new Error('Tên skill không hợp lệ: ' + name);
    err.statusCode = 400;
    throw err;
  }
  const manifest = skillFilePath(slug);
  if (!fs.existsSync(manifest)) {
    const err = new Error('Không tìm thấy skill: ' + slug);
    err.statusCode = 404;
    throw err;
  }
  const raw = fs.readFileSync(manifest, 'utf8');
  const parsed = parseSkillFrontmatter(raw);
  return {
    name: slug,
    title: parsed.meta.name || slug,
    description: parsed.meta.description || '',
    body: parsed.body,
    content: raw,
    path: SKILLS_DIR_NAME + '/' + slug + '/SKILL.md'
  };
}

function agentsFilePath(root) {
  return path.join(root || DEFAULT_WORKSPACE_ROOT, AGENTS_FILE_NAME);
}

function readAgentsFile(root) {
  const target = agentsFilePath(root);
  try {
    if (!fs.existsSync(target)) return '';
    return fs.readFileSync(target, 'utf8');
  } catch (err) {
    return '';
  }
}

function writeAgentsFile(root, content) {
  const target = agentsFilePath(root);
  fs.writeFileSync(target, String(content || ''), 'utf8');
  return target;
}

const DEFAULT_AGENTS_TEMPLATE = [
  '# AGENTS.md',
  '',
  'Hướng dẫn cho agent Claudex khi làm việc trong workspace này.',
  '',
  '## Ngữ cảnh',
  '- Mục tiêu của dự án: (mô tả ngắn)',
  '- Ngôn ngữ và framework: (ví dụ Node.js, Express)',
  '',
  '## Quy ước',
  '- Viết code đầy đủ, không dùng TODO hay placeholder.',
  '- Chạy kiểm tra cú pháp và test trước khi báo hoàn thành.',
  '- Không sửa các file hệ thống nằm ngoài workspace.',
  '',
  '## Lệnh thường dùng',
  '- Cài đặt: npm install',
  '- Chạy: npm start',
  ''
].join('\n');


function normalizeRootPath(relPath) {
  return String(relPath === undefined || relPath === null ? '' : relPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function assertInsideRoot(root, abs) {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(abs);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    const err = new Error('Path traversal detected: ' + abs);
    err.statusCode = 400;
    throw err;
  }
  return resolved;
}

function normalizeWorkspaceMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return WORKSPACE_MODES.includes(value) ? value : 'root';
}

function resolveWorkspaceRoot(input) {
  const raw = (input === undefined || input === null) ? '' : String(input).trim();
  if (!raw || raw === '.' || raw === './' || raw === '/') return DEFAULT_WORKSPACE_ROOT;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(DEFAULT_WORKSPACE_ROOT, raw);
  assertInsideRoot(DEFAULT_WORKSPACE_ROOT, candidate);
  if (!fs.existsSync(candidate)) {
    throw new Error('Workspace không tồn tại: ' + raw);
  }
  if (!fs.statSync(candidate).isDirectory()) {
    throw new Error('Workspace phải là thư mục: ' + raw);
  }
  return candidate;
}

function prepareWorkspace(input) {
  const mode = normalizeWorkspaceMode(input && input.mode);
  const requested = input && input.workspaceRoot ? String(input.workspaceRoot).trim() : '';
  let relative = '';
  let created = false;
  let selection = '';

  if (mode === 'auto') {
    relative = requested || 'workspace-' + new Date().toISOString().slice(0, 10);
    relative = normalizeRootPath(relative);
    if (!relative) {
      throw new Error('Tên workspace tự tạo không hợp lệ');
    }
    const abs = assertInsideRoot(DEFAULT_WORKSPACE_ROOT, path.join(DEFAULT_WORKSPACE_ROOT, relative));
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created = true;
    } else if (!fs.statSync(abs).isDirectory()) {
      throw new Error('Đường dẫn đã tồn tại và không phải thư mục: ' + relative);
    }
    if (!fs.existsSync(agentsFilePath(abs))) {
      try {
        writeAgentsFile(abs, DEFAULT_AGENTS_TEMPLATE.replace('# AGENTS.md', '# AGENTS.md (' + relative + ')'));
      } catch (err) {
        /* guide creation is best effort */
      }
    }
    selection = relative;
  } else if (mode === 'picker') {
    relative = normalizeRootPath(requested);
    if (!relative) {
      throw new Error('Hãy chọn hoặc nhập workspace trước khi gửi, hoặc chuyển sang chế độ tự tạo.');
    }
    const abs = resolveWorkspaceRoot(relative);
    relative = toRelativeAt(abs, DEFAULT_WORKSPACE_ROOT);
    selection = relative;
  } else {
    relative = '';
    selection = '.';
  }

  return {
    mode: mode,
    root: resolveWorkspaceRoot(relative),
    relative: relative,
    label: relative || 'thư mục gốc',
    created: created,
    selection: selection
  };
}

const PROTECTED_ROOT_ENTRIES = new Set([
  'server.js',
  'package.json',
  'package-lock.json',
  'node_modules',
  '.git',
  '.env',
  '.env.example',
  '.gitignore'
]);

function isProtectedRootEntry(entryName) {
  const name = String(entryName || '').replace(/^\/+/, '').split('/')[0];
  return PROTECTED_ROOT_ENTRIES.has(name);
}

class GuardedDeleteError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function guardedDelete(abs, root) {
  if (path.resolve(abs) === path.resolve(root)) {
    throw new GuardedDeleteError('Không thể xóa thư mục gốc của workspace', 400);
  }
  const relToDefault = toRelativeAt(abs, DEFAULT_WORKSPACE_ROOT);
  if (path.resolve(abs) === path.resolve(DEFAULT_WORKSPACE_ROOT)) {
    throw new GuardedDeleteError('Không thể xóa thư mục gốc của ứng dụng', 400);
  }
  if (isProtectedRootEntry(relToDefault)) {
    throw new GuardedDeleteError('File hệ thống của ứng dụng không thể xóa ở chế độ không workspace: ' + relToDefault, 403);
  }
  fs.rmSync(abs, { recursive: true, force: true });
}

function toRelativeAt(absPath, root) {
  const rel = path.relative(root || DEFAULT_WORKSPACE_ROOT, absPath);
  return rel.split(path.sep).join('/');
}

function safePath(relPath, root) {
  const base = root || DEFAULT_WORKSPACE_ROOT;
  const raw = (relPath === undefined || relPath === null) ? '' : String(relPath);
  const cleaned = raw.replace(/^[/\\]+/, '');
  return assertInsideRoot(base, path.resolve(base, cleaned));
}

function toRelative(absPath, root) {
  return toRelativeAt(absPath, root || DEFAULT_WORKSPACE_ROOT);
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return (idx === 0 ? val.toFixed(0) : val.toFixed(2)) + ' ' + units[idx];
}

function errorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function truncateText(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n...[truncated ' + (text.length - max) + ' chars]';
}

function clampLines(totalLines, startLine, endLine) {
  let start = Number.isFinite(Number(startLine)) && Number(startLine) > 0 ? Math.floor(Number(startLine)) : 1;
  let end = Number.isFinite(Number(endLine)) && Number(endLine) > 0 ? Math.floor(Number(endLine)) : totalLines;
  if (start < 1) start = 1;
  if (end > totalLines) end = totalLines;
  if (end < start) end = start;
  return { start, end };
}

function humanDuration(seconds) {
  let s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

function walkDirectory(absDir, baseLabel, recursive, results, depth) {
  if (depth > 24) return results;
  let entries = [];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    results.push({ name: baseLabel, path: baseLabel, type: 'error', size: 0, sizeHuman: '0 B', error: errorMessage(err) });
    return results;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    const childAbs = path.join(absDir, entry.name);
    const childRel = baseLabel ? baseLabel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (recursive && IGNORED_DIRS.has(entry.name)) continue;
      results.push({ name: entry.name, path: childRel, type: 'dir', size: 0, sizeHuman: '-' });
      if (recursive) walkDirectory(childAbs, childRel, recursive, results, depth + 1);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      let size = 0;
      try {
        size = fs.statSync(childAbs).size;
      } catch (e) {
        size = 0;
      }
      results.push({ name: entry.name, path: childRel, type: 'file', size, sizeHuman: formatSize(size) });
    }
  }
  return results;
}

function listDirectory(absDir, recursive) {
  return walkDirectory(absDir, '', recursive, [], 0);
}

function buildTree(list) {
  const root = { name: '/', path: '', type: 'dir', children: [], size: 0, sizeHuman: '-' };
  const index = new Map();
  index.set('', root);
  for (const item of list) {
    if (!item.path) continue;
    const parts = item.path.split('/');
    let parentPath = '';
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parentPath ? parentPath + '/' + part : part;
      if (index.has(currentPath)) {
        parentPath = currentPath;
        continue;
      }
      const node = {
        name: part,
        path: currentPath,
        type: isLast ? item.type : 'dir',
        size: isLast ? item.size : 0,
        sizeHuman: isLast ? item.sizeHuman : '-',
        children: []
      };
      const parent = index.get(parentPath) || root;
      parent.children.push(node);
      index.set(currentPath, node);
      parentPath = currentPath;
    }
  }
  return root;
}

function toolExecuteCommand(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const command = String((args && args.command) || '').trim();
  if (!command) {
    return Promise.resolve({ ok: false, stdout: '', stderr: 'Empty command', exitCode: 1, command: '' });
  }
  let timeoutMs = parseInt((args && args.timeoutMs) || DEFAULT_TIMEOUT, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT;
  if (timeoutMs > 300000) timeoutMs = 300000;
  return new Promise((resolve) => {
    exec(command, { cwd: root, timeout: timeoutMs, maxBuffer: MAX_BUFFER, shell: '/bin/bash', env: process.env }, (error, stdout, stderr) => {
      let exitCode = 0;
      let out = stdout || '';
      let errOut = stderr || '';
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1;
        if (error.killed) {
          errOut += (errOut ? '\n' : '') + '[process terminated after ' + timeoutMs + 'ms]';
        }
        if (!errOut && error.message) errOut = error.message;
      }
      resolve({
        ok: exitCode === 0,
        stdout: truncateText(out, 60000),
        stderr: truncateText(errOut, 60000),
        exitCode,
        command,
        cwd: root
      });
    });
  });
}

function toolWriteFile(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const filepath = String((args && args.filepath) || '').trim();
  if (!filepath) return { ok: false, error: 'filepath is required' };
  const content = typeof (args && args.content) === 'string' ? args.content : String((args && args.content) || '');
  try {
    const abs = safePath(filepath, root);
    if (abs === path.resolve(root)) return { ok: false, error: 'Cannot write to the workspace root' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    return {
      ok: true,
      filepath: toRelative(abs),
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      lines: content.split('\n').length,
      message: 'File written successfully'
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function toolEditFile(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const filepath = String((args && args.filepath) || '').trim();
  const search = (args && args.search !== undefined) ? String(args.search) : '';
  const replace = (args && args.replace !== undefined) ? String(args.replace) : '';
  if (!filepath) return { ok: false, error: 'filepath is required' };
  if (!search) return { ok: false, error: 'search string is required' };
  try {
    const abs = safePath(filepath, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'File not found: ' + filepath };
    const original = fs.readFileSync(abs, 'utf8');
    const occurrences = original.split(search).length - 1;
    if (occurrences === 0) {
      const head = original.slice(0, 400).replace(/\n/g, ' ');
      return { ok: false, error: 'Search text not found in file: ' + filepath + ' | file starts with: ' + head };
    }
    const updated = original.split(search).join(replace);
    fs.writeFileSync(abs, updated, 'utf8');
    const stat = fs.statSync(abs);
    const searchLines = search.split('\n');
    const replaceLines = replace.split('\n');
    const diffLines = [];
    searchLines.forEach((line) => diffLines.push({ type: 'del', text: line }));
    replaceLines.forEach((line) => diffLines.push({ type: 'add', text: line }));
    return {
      ok: true,
      filepath: toRelative(abs),
      replacements: occurrences,
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      diff: {
        search: truncateText(search, 20000),
        replace: truncateText(replace, 20000),
        removedLines: searchLines.length,
        addedLines: replaceLines.length,
        lines: diffLines.slice(0, 400)
      },
      message: 'Edited ' + occurrences + ' occurrence(s)'
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function toolReadFile(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const filepath = String((args && args.filepath) || '').trim();
  if (!filepath) return { ok: false, error: 'filepath is required' };
  try {
    const abs = safePath(filepath, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'File not found: ' + filepath };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const list = listDirectory(abs, false);
      return { ok: true, filepath: toRelative(abs), isDirectory: true, entries: list };
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const allLines = raw.split('\n');
    const hasRange = (args && (args.startLine !== undefined || args.endLine !== undefined));
    if (hasRange) {
      const range = clampLines(allLines.length, args.startLine, args.endLine);
      const slice = allLines.slice(range.start - 1, range.end);
      return {
        ok: true,
        filepath: toRelative(abs),
        startLine: range.start,
        endLine: range.end,
        totalLines: allLines.length,
        size: stat.size,
        sizeHuman: formatSize(stat.size),
        content: slice.join('\n')
      };
    }
    return {
      ok: true,
      filepath: toRelative(abs),
      startLine: 1,
      endLine: allLines.length,
      totalLines: allLines.length,
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      content: truncateText(raw, 120000)
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function toolListDirectory(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const dirpath = String((args && args.dirpath) || '.').trim() || '.';
  const recursive = Boolean(args && args.recursive);
  try {
    const abs = safePath(dirpath, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'Directory not found: ' + dirpath };
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      return {
        ok: true,
        dirpath: toRelative(abs),
        recursive,
        entries: [{ name: path.basename(abs), path: toRelative(abs), type: 'file', size: stat.size, sizeHuman: formatSize(stat.size) }]
      };
    }
    const entries = listDirectory(abs, recursive);
    return { ok: true, dirpath: toRelative(abs) || '.', recursive, count: entries.length, entries };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function toolDeletePath(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const targetPath = String((args && (args.targetPath !== undefined ? args.targetPath : args.filepath)) || '').trim();
  if (!targetPath) return { ok: false, error: 'targetPath is required' };
  try {
    const abs = safePath(targetPath, root);
    if (abs === path.resolve(root)) {
      return { ok: false, error: 'Refusing to delete the workspace root directory' };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: 'Path not found: ' + targetPath };
    const stat = fs.statSync(abs);
    const type = stat.isDirectory() ? 'dir' : 'file';
    guardedDelete(abs, root);
    return { ok: true, targetPath: toRelativeAt(abs, root), type, message: 'Deleted successfully' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function copyPathRecursive(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function replaceInFile(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const filepath = String((args && args.filepath) || '').trim();
  const search = (args && args.search !== undefined) ? String(args.search) : '';
  const replace = (args && args.replace !== undefined) ? String(args.replace) : '';
  const flags = String((args && args.flags) || '').replace(/[^gimsuy]/g, '');
  if (!filepath) return { ok: false, error: 'filepath is required' };
  if (!search) return { ok: false, error: 'search is required' };
  try {
    const abs = safePath(filepath, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'File not found: ' + filepath };
    const original = fs.readFileSync(abs, 'utf8');
    let regex;
    try {
      regex = new RegExp(search, flags.includes('g') ? flags : flags + 'g');
    } catch (err) {
      return { ok: false, error: 'Invalid regex: ' + errorMessage(err) };
    }
    const matches = original.match(regex);
    const count = matches ? matches.length : 0;
    if (count === 0) {
      return { ok: false, error: 'No match for pattern in ' + filepath };
    }
    const updated = original.replace(regex, replace);
    fs.writeFileSync(abs, updated, 'utf8');
    const stat = fs.statSync(abs);
    return {
      ok: true,
      filepath: toRelativeAt(abs, root),
      matches: count,
      replacements: count,
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      message: 'Replaced ' + count + ' match(es)'
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function listDirectoryTree(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const dirpath = String((args && args.dirpath) || '.').trim() || '.';
  const maxEntries = Math.min(Math.max(parseInt((args && args.maxEntries) || 600, 10) || 600, 10), 5000);
  try {
    const abs = safePath(dirpath, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'Directory not found: ' + dirpath };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: 'Not a directory: ' + dirpath };
    const lines = [];
    const walk = (dir, prefix, depth) => {
      if (lines.length >= maxEntries || depth > 12) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return;
      }
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      entries.forEach((entry, index) => {
        if (lines.length >= maxEntries) return;
        if (IGNORED_DIRS.has(entry.name)) return;
        const last = index === entries.length - 1;
        lines.push(prefix + (last ? '└── ' : '├── ') + entry.name + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory()) walk(path.join(dir, entry.name), prefix + (last ? '    ' : '│   '), depth + 1);
      });
    };
    walk(abs, '', 0);
    return {
      ok: true,
      dirpath: toRelativeAt(abs, root) || '.',
      tree: lines.join('\n') || '(empty)',
      count: lines.length,
      truncated: lines.length >= maxEntries
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function globToRegex(segment) {
  let out = '^';
  for (const ch of segment) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '.';
    else if ('\\^$.|+()[]{}'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp(out + '$');
}

function matchGlob(relPath, patternParts) {
  const fileParts = relPath.split('/');
  let fi = 0;
  let pi = 0;
  while (pi < patternParts.length) {
    const segment = patternParts[pi];
    if (segment === '**') {
      if (pi === patternParts.length - 1) return true;
      for (let skip = fi; skip <= fileParts.length; skip += 1) {
        if (matchGlob(fileParts.slice(skip).join('/'), patternParts.slice(pi + 1))) return true;
      }
      return false;
    }
    if (fi >= fileParts.length) return false;
    if (!globToRegex(segment).test(fileParts[fi])) return false;
    fi += 1;
    pi += 1;
  }
  return fi === fileParts.length;
}

function globFiles(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const pattern = String((args && args.pattern) || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pattern) return { ok: false, error: 'pattern is required' };
  const maxResults = Math.min(Math.max(parseInt((args && args.maxResults) || 400, 10) || 400, 10), 3000);
  const patternParts = pattern.split('/').filter(Boolean);
  const prefixParts = [];
  for (const part of patternParts) {
    if (/[*?]/.test(part)) break;
    prefixParts.push(part);
  }
  const baseRel = prefixParts.length === patternParts.length ? prefixParts.slice(0, -1).join('/') : prefixParts.join('/');
  const results = [];
  try {
    const baseAbs = safePath(baseRel || '.', root);
    if (!fs.existsSync(baseAbs)) return { ok: false, error: 'Base path not found: ' + (baseRel || '.') };
    const walk = (dir, depth) => {
      if (results.length >= maxResults || depth > 16) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return;
      }
      entries.forEach((entry) => {
        if (results.length >= maxResults) return;
        if (IGNORED_DIRS.has(entry.name)) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          return;
        }
        const rel = toRelativeAt(full, root);
        if (matchGlob(rel, patternParts)) {
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch (err) {
            size = 0;
          }
          results.push({ path: rel, size: formatSize(size) });
        }
      });
    };
    walk(baseAbs, 0);
    return { ok: true, pattern: pattern, count: results.length, files: results, truncated: results.length >= maxResults };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function grepSearch(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const pattern = String((args && args.pattern) || '');
  if (!pattern) return { ok: false, error: 'pattern is required' };
  const dirpath = String((args && args.dirpath) || '.').trim() || '.';
  const include = String((args && args.include) || '').trim();
  const caseSensitive = Boolean(args && args.caseSensitive);
  const maxResults = Math.min(Math.max(parseInt((args && args.maxResults) || 120, 10) || 120, 5), 600);
  let regex;
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch (err) {
    return { ok: false, error: 'Invalid regex: ' + errorMessage(err) };
  }
  let includeRegex = null;
  if (include) {
    const escaped = include.replace(/[.+^$()|[\]{}]/g, (ch) => '\\' + ch).replace(/\*/g, '.*').replace(/\?/g, '.');
    includeRegex = new RegExp('^' + escaped + '$');
  }
  const results = [];
  try {
    const baseAbs = safePath(dirpath, root);
    if (!fs.existsSync(baseAbs)) return { ok: false, error: 'Directory not found: ' + dirpath };
    const walk = (dir, depth) => {
      if (results.length >= maxResults || depth > 12) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return;
      }
      entries.forEach((entry) => {
        if (results.length >= maxResults) return;
        if (IGNORED_DIRS.has(entry.name)) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          return;
        }
        if (includeRegex && !includeRegex.test(entry.name)) return;
        const ext = path.extname(entry.name).replace('.', '').toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext)) return;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch (err) {
          return;
        }
        if (stat.size > 1024 * 1024) return;
        let lines = [];
        try {
          lines = fs.readFileSync(full, 'utf8').split('\n');
        } catch (err) {
          return;
        }
        lines.forEach((line, index) => {
          if (results.length >= maxResults) return;
          if (regex.test(line)) {
            results.push({ file: toRelativeAt(full, root), line: index + 1, text: line.trim().slice(0, 240) });
          }
        });
      });
    };
    walk(baseAbs, 0);
    return { ok: true, pattern: pattern, count: results.length, matches: results, truncated: results.length >= maxResults };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function fileInfo(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const target = String((args && (args.targetPath !== undefined ? args.targetPath : args.filepath)) || '').trim();
  if (!target) return { ok: false, error: 'targetPath is required' };
  try {
    const abs = safePath(target, root);
    if (!fs.existsSync(abs)) return { ok: false, error: 'Path not found: ' + target };
    const stat = fs.statSync(abs);
    const info = {
      ok: true,
      path: toRelativeAt(abs, root),
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      mode: '0' + (stat.mode & 0o777).toString(8),
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString()
    };
    if (stat.isFile()) {
      const ext = path.extname(abs).replace('.', '').toLowerCase();
      info.kind = fileKind(abs);
      if (TEXT_EXTENSIONS.has(ext)) {
        const raw = fs.readFileSync(abs, 'utf8');
        info.lines = raw.split('\n').length;
        info.preview = truncateText(raw, 800);
      }
    } else {
      info.entries = fs.readdirSync(abs).length;
    }
    return info;
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function createDirectory(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const dirpath = String((args && (args.dirpath || args.path)) || '').trim();
  if (!dirpath) return { ok: false, error: 'dirpath is required' };
  try {
    const abs = safePath(dirpath, root);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true, dirpath: toRelativeAt(abs, root), existed: existed, message: existed ? 'Directory already exists' : 'Directory created' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function movePath(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const from = String((args && (args.source || args.from)) || '').trim();
  const to = String((args && (args.destination || args.to)) || '').trim();
  if (!from || !to) return { ok: false, error: 'source and destination are required' };
  try {
    const srcAbs = safePath(from, root);
    const destAbs = safePath(to, root);
    if (!fs.existsSync(srcAbs)) return { ok: false, error: 'Source not found: ' + from };
    if (srcAbs === path.resolve(root)) return { ok: false, error: 'Cannot move the workspace root' };
    const overwrite = Boolean(args && args.overwrite);
    if (fs.existsSync(destAbs) && !overwrite) {
      return { ok: false, error: 'Destination already exists: ' + to };
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    if (fs.existsSync(destAbs)) fs.rmSync(destAbs, { recursive: true, force: true });
    try {
      fs.renameSync(srcAbs, destAbs);
    } catch (err) {
      copyPathRecursive(srcAbs, destAbs);
      fs.rmSync(srcAbs, { recursive: true, force: true });
    }
    return { ok: true, source: toRelativeAt(srcAbs, root), destination: toRelativeAt(destAbs, root), message: 'Moved successfully' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function copyPath(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const from = String((args && (args.source || args.from)) || '').trim();
  const to = String((args && (args.destination || args.to)) || '').trim();
  if (!from || !to) return { ok: false, error: 'source and destination are required' };
  try {
    const srcAbs = safePath(from, root);
    const destAbs = safePath(to, root);
    if (!fs.existsSync(srcAbs)) return { ok: false, error: 'Source not found: ' + from };
    if (fs.existsSync(destAbs) && !Boolean(args && args.overwrite)) {
      return { ok: false, error: 'Destination already exists: ' + to };
    }
    copyPathRecursive(srcAbs, destAbs);
    return { ok: true, source: toRelativeAt(srcAbs, root), destination: toRelativeAt(destAbs, root), message: 'Copied successfully' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function multiReadFiles(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const filepaths = Array.isArray(args && args.filepaths) ? args.filepaths : [];
  if (filepaths.length === 0) return { ok: false, error: 'filepaths array is required' };
  if (filepaths.length > 20) return { ok: false, error: 'Too many files (max 20)' };
  const files = filepaths.map((filepath) => {
    const result = toolReadFile({ filepath: filepath }, ctx);
    return {
      filepath: String(filepath),
      ok: Boolean(result.ok),
      error: result.error || null,
      totalLines: result.totalLines || 0,
      content: result.ok ? truncateText(result.content || '', 20000) : ''
    };
  });
  return { ok: files.some((file) => file.ok), count: files.length, files: files, root: toRelativeAt(root, root) || '.' };
}

function writeManyFiles(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const files = Array.isArray(args && args.files) ? args.files : [];
  if (files.length === 0) return { ok: false, error: 'files array is required' };
  if (files.length > 40) return { ok: false, error: 'Too many files (max 40)' };
  const written = [];
  const failed = [];
  files.forEach((item) => {
    const result = toolWriteFile({ filepath: item.filepath, content: item.content }, ctx);
    if (result.ok) written.push({ filepath: result.filepath, size: result.size, sizeHuman: result.sizeHuman });
    else failed.push({ filepath: item && item.filepath, error: result.error });
  });
  return { ok: failed.length === 0, written: written, failed: failed };
}

function findFiles(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const name = String((args && (args.name || args.pattern)) || '').trim();
  if (!name) return { ok: false, error: 'name is required' };
  const abs = safePath(String((args && args.dirpath) || '.'), root);
  try {
    const out = execSync('find . -maxdepth 8 -name ' + JSON.stringify(name) + ' -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -n 200', {
      cwd: abs,
      encoding: 'utf8',
      timeout: 15000,
      shell: '/bin/bash',
      maxBuffer: MAX_BUFFER
    });
    const matches = out.split('\n').filter(Boolean).map((line) => line.replace(/^\.\//, ''));
    return { ok: true, name: name, count: matches.length, matches: matches };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function readSkillTool(args, ctx) {
  const name = String((args && args.name) || '').trim();
  try {
    const skill = readSkill(name);
    return { ok: true, name: skill.name, title: skill.title, description: skill.description, path: skill.path, content: truncateText(skill.body, 60000) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function listSkillsTool() {
  const skills = listSkills();
  return { ok: true, count: skills.length, skills: skills };
}

function readAgentsTool(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const content = readAgentsFile(root);
  return { ok: true, path: toRelativeAt(agentsFilePath(root), root), exists: content.length > 0, content: truncateText(content, 60000) };
}

function writeAgentsTool(args, ctx) {
  const root = (ctx && ctx.root) || DEFAULT_WORKSPACE_ROOT;
  const content = typeof (args && args.content) === 'string' ? args.content : '';
  if (!content.trim()) return { ok: false, error: 'content is required' };
  try {
    writeAgentsFile(root, content);
    return { ok: true, path: AGENTS_FILE_NAME, size: Buffer.byteLength(content, 'utf8'), message: 'AGENTS.md saved' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function webFetchTool(args) {
  const url = String((args && args.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: 'url must start with http:// or https://' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  return fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'ClaudexAgentWorkspace/1.0' } })
    .then((resp) => resp.text().then((text) => {
      const clean = String(text || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { ok: true, url: resp.url, status: resp.status, contentType: resp.headers.get('content-type') || '', content: truncateText(clean || text, 40000) };
    }))
    .catch((err) => ({ ok: false, error: errorMessage(err) }))
    .finally(() => clearTimeout(timer));
}

const ACTION_SUMMARY_SCHEMA = {
  type: 'string',
  description: 'Bắt buộc. Một câu tiếng Việt ngắn gọn, tự nhiên mô tả chính xác việc bạn đang làm (ví dụ: "Đang kiểm tra cấu trúc thư mục hiện tại", "Tạo file cấu hình server_config.json").'
};

function stringProp(description) {
  return { type: 'string', description: description };
}

function boolProp(description) {
  return { type: 'boolean', description: description };
}

function numProp(description) {
  return { type: 'number', description: description };
}

function toolSpec(name, description, properties, required) {
  const props = Object.assign({ action_summary: ACTION_SUMMARY_SCHEMA }, properties);
  return {
    type: 'function',
    function: {
      name: name,
      description: description,
      parameters: { type: 'object', properties: props, required: ['action_summary'].concat(required || []) }
    }
  };
}

const TOOLS = [
  toolSpec('execute_command', 'Execute a bash/Linux shell command inside the workspace container. Use for installing packages, running scripts, git, builds and tests.', {
    command: stringProp('The bash command to execute.'),
    timeoutMs: numProp('Optional timeout in milliseconds (default 45000, max 300000).')
  }, ['command']),
  toolSpec('write_file', 'Create a new file or overwrite an existing file with UTF-8 content. Parent directories are created automatically.', {
    filepath: stringProp('Relative path of the file inside the workspace.'),
    content: stringProp('Full UTF-8 content of the file.')
  }, ['filepath', 'content']),
  toolSpec('edit_file', 'Replace an exact chunk of text inside an existing file. Faster and safer than rewriting whole large files.', {
    filepath: stringProp('Relative path of the file inside the workspace.'),
    search: stringProp('Exact text to find (must match literally, including whitespace).'),
    replace: stringProp('Replacement text.')
  }, ['filepath', 'search', 'replace']),
  toolSpec('read_file', 'Read UTF-8 content of a file. Optionally read only a range of lines (1-indexed).', {
    filepath: stringProp('Relative path of the file inside the workspace.'),
    startLine: numProp('Optional first line to read (1-indexed).'),
    endLine: numProp('Optional last line to read (inclusive).')
  }, ['filepath']),
  toolSpec('list_directory', 'List files and directories with sizes and types. Recursive mode skips node_modules and .git.', {
    dirpath: stringProp('Relative directory path (defaults to workspace root).'),
    recursive: boolProp('Whether to walk sub-directories.')
  }, []),
  toolSpec('list_directory_tree', 'Print a compact ASCII tree of a directory, skipping node_modules and .git. Better than a flat list for understanding structure.', {
    dirpath: stringProp('Relative directory path (defaults to workspace root).'),
    maxEntries: numProp('Maximum number of lines (default 600).')
  }, []),
  toolSpec('read_multiple_files', 'Read several files in one call and return each file with line numbers metadata. Max 20 files.', {
    filepaths: { type: 'array', items: { type: 'string' }, description: 'Relative paths of the files to read.' }
  }, ['filepaths']),
  toolSpec('write_multiple_files', 'Create or overwrite several files in one call. Max 40 files.', {
    files: { type: 'array', items: { type: 'object', properties: { filepath: stringProp('Relative path.'), content: stringProp('File content.') }, required: ['filepath', 'content'] }, description: 'List of files to write.' }
  }, ['files']),
  toolSpec('replace_in_file', 'Regex-based search and replace inside a file, optionally with flags. Use when the exact match string is too long.', {
    filepath: stringProp('Relative path of the file.'),
    search: stringProp('Regular expression to match.'),
    replace: stringProp('Replacement text (supports $1 groups).'),
    flags: stringProp('Optional regex flags, for example "gi".')
  }, ['filepath', 'search', 'replace']),
  toolSpec('delete_path', 'Delete a file or directory recursively inside the workspace.', {
    targetPath: stringProp('Relative path of the file or directory to delete.')
  }, ['targetPath']),
  toolSpec('create_directory', 'Create a directory (and any missing parents) inside the workspace.', {
    dirpath: stringProp('Relative directory path to create.')
  }, ['dirpath']),
  toolSpec('move_path', 'Move or rename a file or directory inside the workspace.', {
    source: stringProp('Existing relative path.'),
    destination: stringProp('Target relative path.'),
    overwrite: boolProp('Overwrite destination when it already exists.')
  }, ['source', 'destination']),
  toolSpec('copy_path', 'Copy a file or directory inside the workspace.', {
    source: stringProp('Existing relative path.'),
    destination: stringProp('Target relative path.'),
    overwrite: boolProp('Overwrite destination when it already exists.')
  }, ['source', 'destination']),
  toolSpec('file_info', 'Return metadata for a path: type, size, permissions, timestamps, line count and a short preview.', {
    targetPath: stringProp('Relative path of the file or directory.')
  }, ['targetPath']),
  toolSpec('glob_files', 'Find files by glob pattern such as "**/*.js" or "src/**/*.css". Ignores node_modules and .git.', {
    pattern: stringProp('Glob pattern relative to the workspace root.'),
    maxResults: numProp('Maximum number of results (default 400).')
  }, ['pattern']),
  toolSpec('find_files', 'Find files by exact name using the system find command.', {
    name: stringProp('File name pattern, for example "*.json".'),
    dirpath: stringProp('Directory to search in (default workspace root).')
  }, ['name']),
  toolSpec('grep_search', 'Search text or regex across text files and return matching lines with file and line number.', {
    pattern: stringProp('Text or regular expression to search for.'),
    include: stringProp('Optional file name glob filter, for example "*.md".'),
    dirpath: stringProp('Directory to search in (default workspace root).'),
    caseSensitive: boolProp('Match case when true.'),
    maxResults: numProp('Maximum number of matches (default 120).')
  }, ['pattern']),
  toolSpec('list_skills', 'List every skill stored under the skills folder and their descriptions. Use before invoking a skill.', {}, []),
  toolSpec('read_skill', 'Load the full instructions of a skill by name. Always call this before applying a skill.', {
    name: stringProp('Skill folder name, for example "web-testing".')
  }, ['name']),
  toolSpec('read_agents_file', 'Read the AGENTS.md guide of the current workspace for project specific instructions.', {}, []),
  toolSpec('write_agents_file', 'Create or update the AGENTS.md guide of the current workspace with instructions for future runs.', {
    content: stringProp('Full Markdown content of AGENTS.md.')
  }, ['content']),
  toolSpec('web_fetch', 'Fetch an http(s) URL and return its visible text content, for reading docs or references.', {
    url: stringProp('Absolute http or https URL.')
  }, ['url'])
];

const TOOL_EXECUTORS = {
  execute_command: toolExecuteCommand,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  read_file: toolReadFile,
  read_multiple_files: multiReadFiles,
  write_multiple_files: writeManyFiles,
  replace_in_file: replaceInFile,
  list_directory: toolListDirectory,
  list_directory_tree: listDirectoryTree,
  create_directory: createDirectory,
  move_path: movePath,
  copy_path: copyPath,
  file_info: fileInfo,
  glob_files: globFiles,
  find_files: findFiles,
  grep_search: grepSearch,
  delete_path: toolDeletePath,
  list_skills: listSkillsTool,
  read_skill: readSkillTool,
  read_agents_file: readAgentsTool,
  write_agents_file: writeAgentsTool,
  web_fetch: webFetchTool
};

const DEFAULT_SYSTEM_PROMPT = [
  'You are Claudex, a brilliant autonomous software engineering agent operating inside a live Linux container workspace.',
  'You have a complete toolset: execute_command, write_file, edit_file, read_file, read_multiple_files, write_multiple_files, replace_in_file, list_directory, list_directory_tree, create_directory, move_path, copy_path, file_info, glob_files, find_files, grep_search, delete_path, list_skills, read_skill, read_agents_file, write_agents_file and web_fetch.',
  'Skills live in the root "skills" folder as skills/<name>/SKILL.md and AGENTS.md describes each workspace. Users can invoke a skill with "/<skill-name>" at the start of a message; when that happens, call read_skill first and follow its instructions exactly.',
  'Rules:',
  '1. Every tool call MUST include the required parameter action_summary: one short, natural Vietnamese sentence describing exactly what you are doing right now (for example "Đang kiểm tra các gói phụ thuộc trong package.json" or "Tạo giao diện trang chủ đầy đủ").',
  '2. Read AGENTS.md and relevant skills before large changes, and always inspect files before editing them.',
  '3. Prefer edit_file / replace_in_file for surgical edits and write_file for new files.',
  '4. Use execute_command to run builds, tests and quick checks so that the work is verified. Keep commands short and targeted.',
  '5. Never use placeholder snippets such as "// TODO" or "// ... rest of code" - always output complete, runnable code.',
  '6. When you finish, reply with a concise Markdown summary of what you built, where the files live and how to run them.',
  '7. Prefer modern, production-quality code and keep explanations tight and useful.'
].join('\n');

function extractArtifactCandidates(toolName, args) {
  const list = [];
  if (!args) return list;
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_in_file') {
    if (args.filepath) list.push(String(args.filepath));
  }
  if (toolName === 'write_multiple_files' && Array.isArray(args.files)) {
    args.files.forEach((file) => {
      if (file && file.filepath) list.push(String(file.filepath));
    });
  }
  return list;
}

function fileKind(filepath) {
  const ext = path.extname(filepath).replace('.', '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'HTML';
  if (ext === 'svg') return 'SVG';
  if (ext === 'md') return 'Markdown';
  if (ext === 'json') return 'JSON';
  if (ext === 'css') return 'CSS';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'JavaScript';
  if (ext === 'ts' || ext === 'tsx') return 'TypeScript';
  if (ext === 'py') return 'Python';
  if (ext === 'sh' || ext === 'bash') return 'Shell';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') return 'Image';
  if (ext === 'txt') return 'Text';
  if (!ext) return 'File';
  return ext.toUpperCase();
}

function buildArtifact(absRel, fallbackContent) {
  let content = typeof fallbackContent === 'string' ? fallbackContent : '';
  let size = content.length;
  try {
    const abs = safePath(absRel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const stat = fs.statSync(abs);
      size = stat.size;
      if (!content) content = truncateText(fs.readFileSync(abs, 'utf8'), 200000);
    }
  } catch (err) {
    size = content.length;
  }
  const filename = path.basename(absRel);
  const ext = path.extname(absRel).replace('.', '').toLowerCase();
  return {
    filepath: absRel,
    filename,
    content,
    ext,
    kind: fileKind(absRel),
    size,
    sizeHuman: formatSize(size)
  };
}

function fallbackSummary(toolName, args) {
  const a = args || {};
  if (toolName === 'execute_command') return 'Đang chạy lệnh ' + String(a.command || '').split(String.fromCharCode(10))[0].slice(0, 60);
  if (toolName === 'write_file') return 'Đang tạo file ' + String(a.filepath || '');
  if (toolName === 'edit_file' || toolName === 'replace_in_file') return 'Đang sửa file ' + String(a.filepath || '');
  if (toolName === 'read_file' || toolName === 'read_multiple_files') return 'Đang đọc nội dung file';
  if (toolName === 'write_multiple_files') return 'Đang tạo nhiều file cùng lúc';
  if (toolName === 'list_directory' || toolName === 'list_directory_tree') return 'Đang kiểm tra thư mục ' + String(a.dirpath || '.');
  if (toolName === 'create_directory') return 'Đang tạo thư mục ' + String(a.dirpath || '');
  if (toolName === 'delete_path') return 'Đang xóa ' + String(a.targetPath || '');
  if (toolName === 'move_path') return 'Đang di chuyển ' + String(a.source || '') + ' → ' + String(a.destination || '');
  if (toolName === 'copy_path') return 'Đang sao chép ' + String(a.source || '') + ' → ' + String(a.destination || '');
  if (toolName === 'file_info') return 'Đang xem thông tin ' + String(a.targetPath || '');
  if (toolName === 'glob_files') return 'Đang tìm file theo mẫu ' + String(a.pattern || '');
  if (toolName === 'find_files') return 'Đang tìm file tên ' + String(a.name || '');
  if (toolName === 'grep_search') return 'Đang tìm nội dung ' + String(a.pattern || '');
  if (toolName === 'list_skills') return 'Đang xem danh sách skill';
  if (toolName === 'read_skill') return 'Đang nạp skill ' + String(a.name || '');
  if (toolName === 'read_agents_file') return 'Đang đọc AGENTS.md của workspace';
  if (toolName === 'write_agents_file') return 'Đang cập nhật AGENTS.md';
  if (toolName === 'web_fetch') return 'Đang đọc nội dung ' + String(a.url || '');
  return 'Đang thực hiện ' + toolName;
}

function normalizeStepArgs(toolName, parsedArgs) {
  const args = (parsedArgs && typeof parsedArgs === 'object') ? Object.assign({}, parsedArgs) : {};
  if (typeof args.action_summary !== 'string' || args.action_summary.trim() === '') {
    args.action_summary = fallbackSummary(toolName, args);
  }
  args.action_summary = String(args.action_summary).trim();
  return args;
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function createSseWriter(res) {
  let closed = false;
  let seq = 0;
  res.on('close', () => {
    closed = true;
  });
  return {
    get closed() {
      return closed;
    },
    markClosed() {
      closed = true;
    },
    send(event, data) {
      if (closed) return false;
      seq += 1;
      try {
        const payload = JSON.stringify({ seq: seq, event: event, data: data });
        res.write('id: ' + seq + '\n');
        res.write('event: ' + event + '\n');
        res.write('data: ' + payload + '\n\n');
        return true;
      } catch (err) {
        closed = true;
        return false;
      }
    },
    close() {
      if (closed) {
        try {
          res.end();
        } catch (err) {
          /* stream already closed */
        }
        return;
      }
      closed = true;
      try {
        res.end();
      } catch (err) {
        /* stream already closed */
      }
    }
  };
}

function chunkText(text, size) {
  const out = [];
  const limits = ['\n\n', '. ', '\n', ' '];
  let rest = String(text || '');
  while (rest.length > 0) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    let cut = -1;
    for (const sep of limits) {
      const idx = rest.lastIndexOf(sep, size);
      if (idx > size * 0.45) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStepDetail(toolName, args, result, status, resultPreview) {
  if (status === 'error') {
    return { kind: 'log', resultPreview: resultPreview, error: true };
  }
  if (toolName === 'execute_command') {
    return {
      kind: 'command',
      command: result.command || args.command || '',
      cwd: result.cwd || workspace.root,
      exitCode: result.exitCode != null ? result.exitCode : null,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  }
  if (toolName === 'edit_file' && result && result.diff) {
    return { kind: 'diff', lines: result.diff.lines || [], filepath: result.filepath || args.filepath || '' };
  }
  if (toolName === 'list_directory' && result && Array.isArray(result.entries)) {
    return { kind: 'list', entries: result.entries.slice(0, 300), dirpath: result.dirpath || args.dirpath || '.' };
  }
  if (toolName === 'read_file' && result && typeof result.content === 'string') {
    return {
      kind: 'read',
      filepath: result.filepath || args.filepath || '',
      startLine: result.startLine || 1,
      endLine: result.endLine || null,
      totalLines: result.totalLines || null,
      content: truncateText(result.content, 20000)
    };
  }
  if (toolName === 'list_skills' && result && Array.isArray(result.skills)) {
    return { kind: 'list', dirpath: 'skills', entries: result.skills.map((skill) => ({ path: skill.name + ' - ' + (skill.description || ''), type: 'file', size: skill.size, sizeHuman: formatSize(skill.size || 0) })) };
  }
  if ((toolName === 'read_skill' || toolName === 'read_agents_file' || toolName === 'web_fetch') && result && typeof result.content === 'string') {
    return { kind: 'read', filepath: result.path || result.url || toolName, startLine: 1, endLine: null, totalLines: null, content: truncateText(result.content, 20000) };
  }
  if (toolName === 'list_directory_tree' && result && typeof result.tree === 'string') {
    return { kind: 'read', filepath: result.dirpath || '.', startLine: 1, endLine: null, totalLines: result.count || null, content: result.tree };
  }
  if (toolName === 'glob_files' && result && Array.isArray(result.files)) {
    return { kind: 'list', dirpath: result.pattern || '.', entries: result.files.map((file) => ({ path: file.path, type: 'file', size: 0, sizeHuman: file.size || '' })) };
  }
  if (toolName === 'find_files' && result && Array.isArray(result.matches)) {
    return { kind: 'list', dirpath: result.name || '.', entries: result.matches.map((match) => ({ path: match, type: 'file', size: 0, sizeHuman: '' })) };
  }
  if ((toolName === 'grep_search' || toolName === 'replace_in_file') && result && (Array.isArray(result.matches) || result.matches)) {
    const matches = result.matches || [];
    const lines = matches.map((match) => ({ type: 'add', text: (match.file || '') + ':' + (match.line || '') + '  ' + (match.text || '') }));
    return { kind: 'diff', filepath: result.pattern || args.pattern || '', lines: lines };
  }
  if (toolName === 'write_multiple_files' && result && Array.isArray(result.written)) {
    return { kind: 'list', dirpath: '.', entries: result.written.map((file) => ({ path: file.filepath, type: 'file', size: 0, sizeHuman: file.sizeHuman || '' })) };
  }
  if (String(toolName).indexOf('file') !== -1 && result && result.filepath && typeof result.content === 'string') {
    return {
      kind: 'read',
      filepath: result.filepath,
      startLine: result.startLine || 1,
      endLine: result.endLine || null,
      totalLines: result.totalLines || null,
      content: truncateText(result.content, 20000)
    };
  }
  return { kind: 'log', resultPreview: resultPreview };
}

function stepFileTarget(toolName, args) {
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file' || toolName === 'replace_in_file') return String(args.filepath || '');
  if (toolName === 'delete_path' || toolName === 'file_info') return String(args.targetPath || '');
  if (toolName === 'list_directory' || toolName === 'list_directory_tree' || toolName === 'create_directory') return String(args.dirpath || '');
  if (toolName === 'move_path' || toolName === 'copy_path') return String(args.destination || args.source || '');
  if (toolName === 'glob_files') return String(args.pattern || '');
  if (toolName === 'find_files') return String(args.name || '');
  if (toolName === 'grep_search') return String(args.include || '');
  if (toolName === 'read_skill') return String(args.name || '');
  if (toolName === 'read_agents_file' || toolName === 'write_agents_file') return 'AGENTS.md';
  if (toolName === 'web_fetch') return String(args.url || '');
  return '';
}

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const messagesIn = Array.isArray(body.messages) ? body.messages : [];
  const config = body.config || {};
  const apiKey = String(config.apiKey || process.env.AI_API_KEY || '').trim();
  const baseURL = String(config.baseURL || process.env.AI_BASE_URL || 'https://api.openai.com/v1').trim();
  const model = String(config.model || process.env.AI_MODEL || DEFAULT_MODEL).trim();
  const systemPrompt = String(config.systemPrompt || DEFAULT_SYSTEM_PROMPT);
  let maxSteps = parseInt(config.maxSteps || MAX_STEPS_DEFAULT, 10);
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) maxSteps = MAX_STEPS_DEFAULT;
  if (maxSteps > 40) maxSteps = 40;

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'Missing API key. Add one in Settings or .env (AI_API_KEY).' });
  }
  if (messagesIn.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array is required' });
  }

  let workspace;
  try {
    workspace = prepareWorkspace({ mode: config.workspaceMode, workspaceRoot: config.workspaceRoot });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ ok: false, error: errorMessage(err) });
  }
  const toolCtx = { root: workspace.root };

  sseHeaders(res);
  const sse = createSseWriter(res);

  const client = new OpenAI({ apiKey: apiKey, baseURL: baseURL, dangerouslyAllowBrowser: false });
  const agentsGuide = readAgentsFile(workspace.root);
  const skills = listSkills();
  const skillIndex = skills.length
    ? skills.map((skill) => '- ' + skill.name + ': ' + (skill.description || skill.title)).join(String.fromCharCode(10))
    : '- (chưa có skill nào)';
  const workspaceNote = [
    '',
    'Working directory for this conversation: ' + workspace.root + ' (' + (workspace.relative || 'workspace root / thư mục gốc') + '). All relative paths you pass to tools are resolved inside that directory.',
    'Available skills (skills/<name>/SKILL.md) - call read_skill before using one:',
    skillIndex,
    agentsGuide
      ? 'Project guide from AGENTS.md of this workspace:' + String.fromCharCode(10) + truncateText(agentsGuide, 12000)
      : 'This workspace has no AGENTS.md yet. If the task is substantial, create one with write_agents_file describing conventions for future runs.'
  ].join(String.fromCharCode(10));
  const conversation = [{ role: 'system', content: systemPrompt + workspaceNote }];
  for (const m of messagesIn) {
    if (!m || !m.role) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = typeof m.content === 'string' ? m.content : '';
    if (text.length === 0) continue;
    conversation.push({ role: m.role, content: text });
  }

  const toolSteps = [];
  const artifactsMap = new Map();
  const presentedFiles = new Set();
  let stepCount = 0;

  sse.send('start', {
    model: model,
    workspaceRoot: workspace.relative || '.',
    workspaceRootAbsolute: workspace.root,
    workspaceMode: workspace.mode,
    workspaceLabel: workspace.label,
    workspaceCreated: workspace.created,
    maxSteps: maxSteps
  });

  try {
    let finalContent = '';
    for (let step = 0; step < maxSteps; step += 1) {
      if (sse.closed) return;
      const completion = await client.chat.completions.create({
        model: model,
        messages: conversation,
        tools: TOOLS.concat(externalToolSpecs),
        tool_choice: 'auto',
        temperature: 0.2
      });
      if (sse.closed) return;
      const choice = completion && completion.choices && completion.choices[0];
      const msg = choice ? choice.message : null;
      if (!msg) throw new Error('Empty response from model provider');

      const assistantMsg = { role: 'assistant', content: msg.content || '' };
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (hasToolCalls) {
        assistantMsg.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function ? tc.function.name : '',
            arguments: tc.function ? (tc.function.arguments || '{}') : '{}'
          }
        }));
      }
      conversation.push(assistantMsg);

      if (!hasToolCalls) {
        finalContent = msg.content || '';
        break;
      }

      for (const tc of msg.tool_calls) {
        if (sse.closed) return;
        stepCount += 1;
        const toolName = (tc.function && tc.function.name) || '';
        const rawArgs = (tc.function && tc.function.arguments) || '{}';
        let parsedArgs;
        try {
          parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
        } catch (parseErr) {
          parsedArgs = { __raw: rawArgs, action_summary: 'Đang thực hiện ' + toolName };
        }
        const args = normalizeStepArgs(toolName, parsedArgs);
        const stepId = tc.id || ('step-' + stepCount + '-' + Date.now());

        sse.send('step_start', {
          id: stepId,
          index: stepCount,
          name: toolName,
          summary: args.action_summary,
          file: stepFileTarget(toolName, args),
          args: args
        });
        await sleep(25);

        const started = Date.now();
        let result;
        let status = 'success';
        const executor = TOOL_EXECUTORS[toolName];
        const externalTool = executor ? null : externalToolRegistry.get(toolName);
        if (!executor && !externalTool) {
          result = { ok: false, error: 'Unknown tool: ' + toolName };
          status = 'error';
        } else {
          try {
            if (executor) {
              result = await executor(args, toolCtx);
            } else {
              const externalArgs = Object.assign({}, args, {
                action_summary: args.action_summary || ('Đang thực hiện ' + toolName)
              });
              delete externalArgs.action_summary;
              result = await externalTool.run(externalArgs, {
                root: workspace.root,
                timeoutMs: 10000
              });
            }
            if (result && result.ok === false) status = 'error';
          } catch (toolErr) {
            result = { ok: false, error: errorMessage(toolErr) };
            status = 'error';
          }
        }
        const durationMs = Date.now() - started;
        let resultText;
        try {
          resultText = JSON.stringify(result);
        } catch (stringifyErr) {
          resultText = JSON.stringify({ ok: false, error: 'Result not serializable' });
        }
        const resultPreview = truncateText(resultText, 80000);
        const detail = buildStepDetail(toolName, args, result || {}, status, truncateText(resultText, 20000));
        const fileTarget = stepFileTarget(toolName, args);

        toolSteps.push({
          id: stepId,
          index: stepCount,
          name: toolName,
          summary: args.action_summary,
          file: fileTarget,
          args: args,
          result: result,
          resultPreview: truncateText(resultText, 20000),
          detail: detail,
          durationMs: durationMs,
          status: status
        });

        sse.send('step_done', {
          id: stepId,
          index: stepCount,
          name: toolName,
          summary: args.action_summary,
          file: fileTarget,
          status: status,
          durationMs: durationMs,
          detail: detail
        });
        await sleep(25);

        if (status === 'success') {
          const candidates = extractArtifactCandidates(toolName, args);
          for (const candidate of candidates) {
            try {
              const abs = safePath(candidate, workspace.root);
              if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                const rel = toRelativeAt(abs, workspace.root);
                const fallback = toolName === 'write_file' && typeof args.content === 'string' ? args.content : '';
                const artifact = buildArtifact(rel, fallback);
                artifactsMap.set(rel, artifact);
                sse.send('artifact_update', {
                  stepId: stepId,
                  action: toolName === 'edit_file' ? 'edited' : 'created',
                  artifact: artifact
                });
              }
            } catch (artifactErr) {
              /* unresolvable artifact path */
            }
          }
          if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_in_file') && fileTarget) {
            presentedFiles.add(fileTarget.replace(/^\.\//, ''));
          }
          if (toolName === 'write_multiple_files' && result && Array.isArray(result.written)) {
            result.written.forEach((file) => presentedFiles.add(file.filepath));
          }
        }

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id || ('call-' + stepCount),
          content: resultPreview
        });
      }

      if (step === maxSteps - 1 && !finalContent) {
        finalContent = 'Agent reached the maximum number of steps (' + maxSteps + '). Increase "Max Agent Steps" in Settings to continue.';
      }
    }

    if (sse.closed) return;

    if (!finalContent) {
      finalContent = 'The agent finished without a final textual answer.';
    }

    for (const file of presentedFiles) {
      sse.send('presented_file', { filepath: file, kind: fileKind(file) });
    }

    const pieces = chunkText(finalContent, 60);
    let accumulated = '';
    for (const piece of pieces) {
      if (sse.closed) return;
      accumulated += piece;
      sse.send('text_delta', { delta: piece, text: accumulated });
      await sleep(14);
    }

    sse.send('final_reply', {
      content: finalContent,
      toolSteps: toolSteps,
      artifacts: Array.from(artifactsMap.values()),
      presentedFiles: Array.from(presentedFiles),
      model: model,
      steps: stepCount
    });
    sse.send('done', { ok: true, steps: stepCount });
    sse.close();
  } catch (err) {
    if (!sse.closed) {
      sse.send('error', {
        error: errorMessage(err),
        status: typeof err.status === 'number' ? err.status : 500,
        toolSteps: toolSteps,
        artifacts: Array.from(artifactsMap.values())
      });
      sse.markClosed();
      sse.close();
    }
  }
});

app.post('/api/terminal', async (req, res) => {
  const body = req.body || {};
  const command = String(body.command || '').trim();
  let timeoutMs = parseInt(body.timeoutMs || DEFAULT_TIMEOUT, 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT;
  if (timeoutMs > 300000) timeoutMs = 300000;
  if (!command) {
    return res.status(400).json({ ok: false, error: 'command is required' });
  }
  const started = Date.now();
  let terminalRoot;
  try {
    terminalRoot = resolveWorkspaceRoot(body.workspaceRoot || req.query.ws || '');
  } catch (err) {
    return res.status(err.statusCode || 400).json({ ok: false, error: errorMessage(err) });
  }
  const result = await toolExecuteCommand({ command: command, timeoutMs: timeoutMs }, { root: terminalRoot });
  return res.json({
    ok: result.ok,
    command: command,
    cwd: result.cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: Date.now() - started
  });
});

app.get('/api/skills', (req, res) => {
  try {
    ensureSkillsRoot();
    const skills = listSkills();
    res.json({ ok: true, root: SKILLS_DIR_NAME, dir: SKILLS_ROOT, count: skills.length, skills: skills });
  } catch (err) {
    res.status(500).json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/skills', (req, res) => {
  try {
    const body = req.body || {};
    ensureSkillsRoot();
    const rawSkillName = String(body.name || '').trim();
    if (rawSkillName.includes('..') || /[\\/]/.test(rawSkillName)) {
      return res.status(400).json({ ok: false, error: 'Tên skill không được chứa đường dẫn' });
    }
    const slug = normalizeSkillName(rawSkillName);
    if (!slug || !isSafeSkillSlug(slug)) {
      return res.status(400).json({ ok: false, error: 'Tên skill chỉ gồm chữ thường, số, dấu gạch ngang (2-64 ký tự)' });
    }
    const dir = path.join(SKILLS_ROOT, slug);
    const manifest = path.join(dir, 'SKILL.md');
    const exists = fs.existsSync(manifest);
    if (exists && !body.overwrite) {
      return res.status(409).json({ ok: false, error: 'Skill đã tồn tại: ' + slug });
    }
    const title = String(body.title || slug).trim();
    const description = String(body.description || '').trim();
    const content = String(body.content || '').trim();
    if (!content) {
      return res.status(400).json({ ok: false, error: 'Nội dung skill (content) không được để trống' });
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = '---' + String.fromCharCode(10) + 'name: ' + title + String.fromCharCode(10) + 'description: ' + description.replace(/[\r\n]+/g, ' ') + String.fromCharCode(10) + '---' + String.fromCharCode(10, 10) + content + String.fromCharCode(10);
    fs.writeFileSync(manifest, file, 'utf8');
    res.json({ ok: true, name: slug, path: SKILLS_DIR_NAME + '/' + slug + '/SKILL.md', overwritten: exists });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/api/skills/:name', (req, res) => {
  try {
    const skill = readSkill(req.params.name);
    res.json({ ok: true, name: skill.name, title: skill.title, description: skill.description, path: skill.path, content: skill.body });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.delete('/api/skills/:name', (req, res) => {
  try {
    const rawName = String(req.params.name || '');
    const slug = normalizeSkillName(rawName);
    if (!slug || rawName.includes('..') || /[\\/]/.test(rawName) || !isSafeSkillSlug(slug)) {
      return res.status(400).json({ ok: false, error: 'Tên skill không hợp lệ' });
    }
    const dir = path.join(SKILLS_ROOT, slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, error: 'Không tìm thấy skill: ' + slug });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true, name: slug, message: 'Skill đã xóa' });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/api/agents', (req, res) => {
  try {
    const root = resolveWorkspaceRoot(req.query.ws || '');
    const content = readAgentsFile(root);
    res.json({ ok: true, workspace: toRelativeAt(root, DEFAULT_WORKSPACE_ROOT) || '.', path: AGENTS_FILE_NAME, exists: content.length > 0, content: content });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/agents', (req, res) => {
  try {
    const body = req.body || {};
    const root = resolveWorkspaceRoot(body.workspaceRoot || req.query.ws || '');
    const action = String(body.action || 'save');
    if (action === 'create') {
      const target = agentsFilePath(root);
      if (fs.existsSync(target) && !body.overwrite) {
        return res.status(409).json({ ok: false, error: 'AGENTS.md đã tồn tại trong workspace này' });
      }
      writeAgentsFile(root, body.content !== undefined ? String(body.content) : DEFAULT_AGENTS_TEMPLATE);
      return res.json({ ok: true, path: AGENTS_FILE_NAME, created: true });
    }
    if (typeof body.content !== 'string') {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }
    writeAgentsFile(root, body.content);
    res.json({ ok: true, path: AGENTS_FILE_NAME, saved: true, size: Buffer.byteLength(body.content, 'utf8') });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/api/workspaces', (req, res) => {
  try {
    const all = listDirectory(DEFAULT_WORKSPACE_ROOT, false);
    const dirs = all
      .filter((entry) => entry.type === 'dir' && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: entry.path }));
    res.json({ ok: true, root: DEFAULT_WORKSPACE_ROOT, workspaces: dirs, defaultAutoName: 'workspace-' + new Date().toISOString().slice(0, 10) });
  } catch (err) {
    res.status(500).json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/workspaces', (req, res) => {
  try {
    const body = req.body || {};
    const name = normalizeRootPath(body.name || '');
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    if (name.includes('..')) return res.status(400).json({ ok: false, error: 'Tên workspace không hợp lệ' });
    const abs = assertInsideRoot(DEFAULT_WORKSPACE_ROOT, path.join(DEFAULT_WORKSPACE_ROOT, name));
    if (fs.existsSync(abs)) {
      if (!fs.statSync(abs).isDirectory()) {
        return res.status(409).json({ ok: false, error: 'Đã tồn tại file trùng tên: ' + name });
      }
      return res.json({ ok: true, workspace: name, root: abs, existed: true });
    }
    fs.mkdirSync(abs, { recursive: true });
    res.json({ ok: true, workspace: name, root: abs, existed: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/api/files', (req, res) => {
  try {
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const root = resolveWorkspaceRoot(req.query.ws || '');
    const entries = listDirectory(root, recursive);
    res.json({
      ok: true,
      root: root,
      workspaceRoot: toRelativeAt(root, DEFAULT_WORKSPACE_ROOT) || '.',
      agentsFile: fs.existsSync(agentsFilePath(root)),
      count: entries.length,
      entries: entries,
      tree: buildTree(entries)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: errorMessage(err) });
  }
});

const MIME_MAP = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm'
};

const TEXT_EXTENSIONS = new Set([
  '', 'txt', 'md', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm',
  'svg', 'xml', 'yml', 'yaml', 'sh', 'bash', 'py', 'env', 'example', 'log', 'ini', 'toml',
  'conf', 'lock', 'gitignore', 'dockerfile'
]);

app.get('/api/file', (req, res) => {
  try {
    const root = resolveWorkspaceRoot(req.query.ws || '');
    const wsQuery = req.query.ws ? '&ws=' + encodeURIComponent(String(req.query.ws)) : '';
    const relPath = String(req.query.path || '').trim();
    if (!relPath) return res.status(400).json({ ok: false, error: 'path is required' });
    const abs = safePath(relPath, root);
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'File not found' });
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = listDirectory(abs, false);
      return res.json({ ok: true, filepath: toRelativeAt(abs, root), isDirectory: true, entries: entries, workspaceRoot: toRelativeAt(root, DEFAULT_WORKSPACE_ROOT) || '.' });
    }
    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(abs)) + '"');
      return fs.createReadStream(abs).pipe(res);
    }
    const ext = path.extname(abs).replace('.', '').toLowerCase();
    if (req.query.raw === '1' || req.query.raw === 'true') {
      res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      return fs.createReadStream(abs).pipe(res);
    }
    const statInfo = {
      ok: true,
      filepath: toRelativeAt(abs, root),
      workspaceRoot: toRelativeAt(root, DEFAULT_WORKSPACE_ROOT) || '.',
      filename: path.basename(abs),
      ext: ext,
      kind: fileKind(abs),
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      modifiedAt: stat.mtime.toISOString()
    };
    if (!TEXT_EXTENSIONS.has(ext)) {
      statInfo.binary = true;
      statInfo.content = '';
      return res.json(statInfo);
    }
    statInfo.binary = false;
    statInfo.content = fs.readFileSync(abs, 'utf8');
    return res.json(statInfo);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/file', (req, res) => {
  try {
    const body = req.body || {};
    const root = resolveWorkspaceRoot(body.workspaceRoot || req.query.ws || '');
    const relPath = String(body.path || body.filepath || '').trim();
    if (!relPath) return res.status(400).json({ ok: false, error: 'path is required' });
    const abs = safePath(relPath, root);
    if (body.type === 'dir' || body.isDirectory === true) {
      fs.mkdirSync(abs, { recursive: true });
      return res.json({ ok: true, filepath: toRelativeAt(abs, root), type: 'dir', message: 'Directory created' });
    }
    if (abs === path.resolve(root)) {
      return res.status(400).json({ ok: false, error: 'Cannot write to the workspace root' });
    }
    const content = typeof body.content === 'string' ? body.content : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    return res.json({
      ok: true,
      filepath: toRelativeAt(abs, root),
      filename: path.basename(abs),
      kind: fileKind(abs),
      size: stat.size,
      sizeHuman: formatSize(stat.size),
      message: 'File saved'
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.delete('/api/file', (req, res) => {
  try {
    const relPath = String(req.query.path || (req.body && req.body.path) || '').trim();
    if (!relPath) return res.status(400).json({ ok: false, error: 'path is required' });
    const deleteRoot = resolveWorkspaceRoot(req.query.ws || (req.body && req.body.workspaceRoot) || '');
    const result = toolDeletePath({ targetPath: relPath }, { root: deleteRoot });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: errorMessage(err) });
  }
});

app.post('/api/upload', (req, res) => {
  try {
    const body = req.body || {};
    const uploadRoot = resolveWorkspaceRoot(body.workspaceRoot || req.query.ws || '');
    const files = Array.isArray(body.files) ? body.files : (body.filepath ? [{ filepath: body.filepath, base64Data: body.base64Data }] : []);
    if (files.length === 0) return res.status(400).json({ ok: false, error: 'files array is required' });
    if (files.length > 200) return res.status(400).json({ ok: false, error: 'Too many files in one request' });
    const saved = [];
    const failed = [];
    for (const f of files) {
      const filepath = String((f && f.filepath) || '').trim();
      const base64Data = String((f && f.base64Data) || '');
      if (!filepath) {
        failed.push({ filepath: filepath, error: 'filepath is required' });
        continue;
      }
      if (!base64Data) {
        failed.push({ filepath: filepath, error: 'base64Data is required' });
        continue;
      }
      try {
        const abs = safePath(filepath, uploadRoot);
        const cleaned = base64Data.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(cleaned, 'base64');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buffer);
        saved.push({ filepath: toRelativeAt(abs, uploadRoot), size: buffer.length, sizeHuman: formatSize(buffer.length) });
      } catch (err) {
        failed.push({ filepath: filepath, error: errorMessage(err) });
      }
    }
    return res.json({ ok: failed.length === 0, saved: saved, failed: failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: errorMessage(err) });
  }
});

function getDiskUsage(targetPath) {
  const target = targetPath || DEFAULT_WORKSPACE_ROOT;
  const usage = { filesystem: '-', size: '-', used: '-', avail: '-', usePercent: '-', mounted: target };
  try {
    const out = execSync('df -h ' + JSON.stringify(target), { encoding: 'utf8', timeout: 8000, shell: '/bin/bash' });
    const lines = out.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length >= 6) {
        usage.filesystem = parts[0];
        usage.size = parts[1];
        usage.used = parts[2];
        usage.avail = parts[3];
        usage.usePercent = parts[4];
        usage.mounted = parts.slice(5).join(' ');
      }
    }
  } catch (err) {
    usage.error = errorMessage(err);
  }
  return usage;
}

app.get('/api/stats', (req, res) => {
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const disk = getDiskUsage();
    res.json({
      ok: true,
      process: {
        pid: process.pid,
        node: process.version,
        rss: mem.rss,
        rssHuman: formatSize(mem.rss),
        heapUsed: mem.heapUsed,
        heapUsedHuman: formatSize(mem.heapUsed),
        heapTotal: mem.heapTotal,
        heapTotalHuman: formatSize(mem.heapTotal),
        external: mem.external
      },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMem: totalMem,
        totalMemHuman: formatSize(totalMem),
        freeMem: freeMem,
        freeMemHuman: formatSize(freeMem),
        usedMem: usedMem,
        usedMemHuman: formatSize(usedMem),
        memPercent: totalMem > 0 ? parseFloat(((usedMem / totalMem) * 100).toFixed(1)) : 0,
        loadavg: os.loadavg(),
        hostname: os.hostname()
      },
      uptime: {
        processSeconds: Math.floor((Date.now() - PROCESS_START) / 1000),
        osSeconds: Math.floor(os.uptime()),
        processHuman: humanDuration(Math.floor((Date.now() - PROCESS_START) / 1000)),
        osHuman: humanDuration(Math.floor(os.uptime()))
      },
      disk: disk,
      workspaceRoot: DEFAULT_WORKSPACE_ROOT
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: errorMessage(err) });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

const INDEX_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Claudex Workspace</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23D97757'/%3E%3C/svg%3E" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/styles/atom-one-dark.min.css" />
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg-chat: #191918;
    --bg-side: #141413;
    --bg-input: #262624;
    --border-outer: #2A2927;
    --border-row: #222220;
    --border-card: #2E2E2B;
    --text-main: #ECECEC;
    --text-row: #B5B3AD;
    --text-summary: #8E8C84;
    --accent: #D97757;
    --accent-hover: #C9663F;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg-chat);
    color: var(--text-main);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
  button { font-family: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
  input, textarea { font-family: inherit; }
  .is-hidden { display: none !important; }
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #34342f; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #45453f; }

  .app { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

  .sidebar {
    width: 262px;
    flex-shrink: 0;
    background: var(--bg-side);
    border-right: 1px solid var(--border-outer);
    display: flex;
    flex-direction: column;
    transition: all 0.28s var(--ease);
    overflow: hidden;
  }
  .sidebar.is-collapsed { width: 62px; }
  .sidebar-top { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px; gap: 8px; }
  .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .brand-mark {
    width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
    background: var(--accent); display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600; color: #1b1b19;
  }
  .brand-name { font-size: 13.5px; font-weight: 500; letter-spacing: -0.01em; white-space: nowrap; }
  .icon-btn {
    width: 26px; height: 26px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;
    transition: all 0.28s var(--ease); color: var(--text-summary);
  }
  .icon-btn:hover { background: var(--bg-input); color: var(--text-main); }
  .icon-btn svg { width: 15px; height: 15px; }
  .sidebar-new { padding: 0 12px 10px; }
  .btn-new {
    width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
    background: var(--accent); color: #fff; border-radius: 8px; padding: 8px 10px;
    font-size: 13px; font-weight: 500; white-space: nowrap;
    transition: all 0.28s var(--ease);
  }
  .btn-new:hover { background: var(--accent-hover); }
  .btn-new svg { width: 13px; height: 13px; }
  .sidebar-section { padding: 8px 12px 4px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-summary); white-space: nowrap; }
  .chat-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
  .chat-item {
    display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 7px;
    font-size: 13px; cursor: pointer; color: var(--text-row);
    transition: all 0.28s var(--ease);
  }
  .chat-item:hover { background: #1d1d1b; color: var(--text-main); }
  .chat-item.is-active { background: #212120; color: var(--text-main); }
  .chat-item-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--text-summary); flex-shrink: 0; }
  .chat-item.is-active .chat-item-dot { background: var(--accent); width: 4px; height: 4px; }
  .chat-item-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-item-delete {
    opacity: 0; font-size: 15px; line-height: 1; color: var(--text-summary); padding: 0 3px;
    transition: all 0.28s var(--ease);
  }
  .chat-item:hover .chat-item-delete { opacity: 1; }
  .chat-item-delete:hover { color: var(--accent); }
  .sidebar-foot { border-top: 1px solid var(--border-outer); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .stats-box {
    background: var(--bg-input); border-radius: 7px; padding: 8px 9px;
    font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary);
    display: flex; flex-direction: column; gap: 5px; white-space: nowrap; overflow: hidden;
  }
  .stat-line { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .stat-line span:last-child { color: var(--text-main); }
  .ram-track { height: 2px; background: #1b1b19; border-radius: 2px; overflow: hidden; }
  .ram-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.28s var(--ease); }
  .btn-settings {
    display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 7px;
    font-size: 13px; color: var(--text-row); white-space: nowrap;
    transition: all 0.28s var(--ease);
  }
  .btn-settings:hover { background: var(--bg-input); color: var(--text-main); }
  .btn-settings svg { width: 15px; height: 15px; flex-shrink: 0; }

  .center { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; background: var(--bg-chat); }
  .center-head {
    height: 46px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px; border-bottom: 1px solid var(--border-outer);
  }
  .chat-title { font-size: 13px; color: var(--text-row); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .center-head-right { display: flex; align-items: center; gap: 6px; }
  .model-badge {
    font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary);
    border: 1px solid var(--border-outer); border-radius: 6px; padding: 3px 7px; max-width: 240px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chat-scroll { flex: 1; overflow-y: auto; scroll-behavior: smooth; }
  .welcome { max-width: 720px; margin: 0 auto; padding: 64px 24px 24px; }
  .welcome-mark {
    width: 32px; height: 32px; border-radius: 8px; background: var(--accent);
    display: flex; align-items: center; justify-content: center; color: #1b1b19; font-weight: 600; font-size: 14px; margin-bottom: 22px;
  }
  .welcome h1 { font-family: 'Newsreader', Georgia, serif; font-size: 30px; font-weight: 400; margin: 0 0 6px; letter-spacing: -0.01em; }
  .welcome p { color: var(--text-summary); font-size: 13.5px; margin: 0 0 28px; }
  .quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .quick-prompt {
    text-align: left; border: 1px solid var(--border-outer); border-radius: 9px; padding: 12px 13px;
    background: #1d1d1b; transition: all 0.28s var(--ease);
  }
  .quick-prompt:hover { border-color: #3E3E3A; background: #202020; }
  .quick-prompt-title { display: block; font-size: 13px; color: var(--text-main); margin-bottom: 3px; }
  .quick-prompt-sub { display: block; font-size: 11.5px; color: var(--text-summary); line-height: 1.45; }
  .messages { max-width: 760px; margin: 0 auto; padding: 26px 24px 190px; display: flex; flex-direction: column; gap: 26px; }

  .turn { display: flex; flex-direction: column; gap: 12px; }
  .fade-in { animation: fadeIn 0.32s var(--ease) both; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .user-row { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
  .user-bubble {
    background: var(--bg-input); border: 1px solid var(--border-outer); border-radius: 14px;
    padding: 10px 14px; max-width: 84%; font-size: 14.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word;
  }
  .user-attachments { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary); }

  .timeline { display: flex; flex-direction: column; gap: 8px; }
  .timeline-header {
    display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
    font-size: 13px; color: var(--text-summary); padding: 2px 0;
    transition: all 0.28s var(--ease);
  }
  .timeline-header:hover { color: var(--text-row); }
  .timeline-summary { font-size: 13px; }
  .timeline-arrow { display: inline-flex; transition: transform 0.28s var(--ease); }
  .chevron { display: block; }
  .action-stack {
    border: 1px solid var(--border-outer); border-radius: 8px; background: var(--bg-side);
    overflow: hidden;
    max-height: 0; opacity: 0;
    transition: max-height 0.28s var(--ease), opacity 0.28s var(--ease), margin 0.28s var(--ease);
  }
  .action-stack.is-open { max-height: 3200px; opacity: 1; }
  .action-more {
    width: 100%; text-align: left; padding: 7px 14px; font-size: 11.5px;
    color: var(--text-summary); border-top: 1px solid var(--border-row);
    transition: color 0.28s var(--ease);
  }
  .action-more:hover { color: var(--text-main); }
  .action-more.is-hidden { display: none; }
  .action-pending {
    display: flex; align-items: center; padding: 7px 14px; font-size: 12px;
    color: var(--text-row); border-top: 1px solid var(--border-row);
  }
  .action-pending.is-hidden { display: none; }
  .action-pending-text { font-family: 'Inter', sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action-children .action-row:last-child { border-bottom: none; }
  .action-stack-inner { display: flex; flex-direction: column; }
  .action-row { border-bottom: 1px solid var(--border-row); }
  .action-row:last-child { border-bottom: none; }
  .action-row-head {
    width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 14px; text-align: left;
    color: var(--text-row); font-size: 13px; transition: background 0.28s var(--ease);
  }
  .action-row-head:hover { background: #191918; }
  .action-row-text { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; }
  .row-lead { color: var(--text-row); }
  .row-file {
    color: #D4D2CD; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px;
    cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px;
  }
  .row-file:hover { color: #fff; }
  .row-file.row-command { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; cursor: default; }
  .row-summary { color: var(--text-summary); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-meta { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #6f6d67; flex-shrink: 0; }
  .row-arrow { color: #6f6d67; display: inline-flex; flex-shrink: 0; transition: transform 0.28s var(--ease); }
  .action-row.is-error .action-row-head { color: #c98a7c; }
  .action-row-detail {
    display: grid; grid-template-rows: 0fr;
    transition: grid-template-rows 0.28s var(--ease);
    background: #0D0D0C;
  }
  .action-row.is-open .action-row-detail { grid-template-rows: 1fr; }
  .action-row-detail-inner { overflow: hidden; min-height: 0; }
  .action-row.is-open .action-row-detail-inner { padding: 2px 14px 12px; }
  .detail-meta {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #6f6d67; padding: 6px 0 5px;
  }
  .detail-cwd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-exit { color: #7f9d80; }
  .detail-exit.is-error { color: #c97564; }
  .detail-code {
    margin: 0; background: #0D0D0C; color: #B5B3AD; font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
    max-height: 260px; overflow: auto; padding: 6px 0;
  }
  .detail-code.is-error { color: #c97564; }
  .detail-prompt { color: var(--accent); }
  .detail-diff { max-height: 280px; overflow: auto; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.6; padding: 4px 0; }
  .diff-line { white-space: pre-wrap; word-break: break-word; padding: 0 4px; }
  .diff-line.is-add { color: #8fae8c; background: rgba(143, 174, 140, 0.06); }
  .diff-line.is-del { color: #c08a7c; background: rgba(192, 138, 124, 0.06); }
  .detail-list { max-height: 260px; overflow: auto; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; }
  .detail-row { display: flex; gap: 10px; padding: 2px 0; color: #B5B3AD; }
  .detail-type { color: #6f6d67; width: 30px; flex-shrink: 0; }
  .detail-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-size { color: #6f6d67; flex-shrink: 0; }

  .shimmer {
    background: linear-gradient(90deg, #6f6d67 0%, #ECECEC 45%, #6f6d67 90%);
    background-size: 220% 100%;
    -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.75s linear infinite;
  }
  @keyframes shimmer { from { background-position: 180% 0; } to { background-position: -80% 0; } }

  .md-body { font-family: 'Newsreader', Georgia, serif; font-size: 16.5px; line-height: 1.7; color: var(--text-main); }
  .md-body.is-streaming::after { content: ''; display: inline-block; width: 7px; height: 15px; background: var(--accent); opacity: 0.7; margin-left: 3px; vertical-align: -2px; animation: caret 1s steps(1) infinite; }
  @keyframes caret { 50% { opacity: 0; } }
  .md-body p { margin: 0 0 0.9em; }
  .md-body h1, .md-body h2, .md-body h3, .md-body h4 { font-family: 'Inter', sans-serif; font-weight: 600; margin: 1.3em 0 0.55em; line-height: 1.32; }
  .md-body h1 { font-size: 1.4em; }
  .md-body h2 { font-size: 1.22em; }
  .md-body h3 { font-size: 1.08em; }
  .md-body ul, .md-body ol { padding-left: 1.4em; margin: 0 0 0.9em; }
  .md-body li { margin: 0.28em 0; }
  .md-body a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .md-body blockquote { border-left: 2px solid var(--border-outer); padding-left: 14px; color: var(--text-row); margin: 1em 0; }
  .md-body :not(pre) > code { background: #242422; padding: 0.12em 0.4em; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.8em; }
  .md-body table { border-collapse: collapse; margin: 1em 0; width: 100%; font-family: 'Inter', sans-serif; font-size: 0.86em; }
  .md-body th, .md-body td { border: 1px solid var(--border-outer); padding: 6px 10px; text-align: left; }
  .md-body th { background: #1d1d1b; }
  .md-body pre { margin: 0; }
  .code-block { background: #0D0D0C; border: 1px solid var(--border-outer); border-radius: 8px; overflow: hidden; margin: 1em 0; }
  .code-head {
    display: flex; align-items: center; justify-content: space-between; padding: 5px 11px;
    background: #161614; border-bottom: 1px solid var(--border-row);
    font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary);
  }
  .code-copy { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary); transition: color 0.28s var(--ease); }
  .code-copy:hover { color: var(--text-main); }
  .code-body { overflow-x: auto; padding: 11px 13px; font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.62; }
  .code-body code { background: transparent !important; padding: 0 !important; }

  .artifact-grid { display: flex; flex-wrap: wrap; gap: 9px; }
  .artifact-card {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    border: 1px solid var(--border-card); background: #21211F; border-radius: 8px;
    padding: 10px 12px; min-width: 260px; max-width: 100%; text-align: left;
    transition: all 0.28s var(--ease);
  }
  .artifact-card:hover { border-color: #3E3E3A; background: #242422; }
  .artifact-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .artifact-action { font-size: 10.5px; color: var(--text-summary); }
  .artifact-name { font-size: 13px; color: var(--text-main); font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artifact-kind { font-size: 10.5px; color: var(--text-summary); font-family: 'JetBrains Mono', monospace; }
  .artifact-open { font-size: 11.5px; color: var(--accent); flex-shrink: 0; }
  .turn-error {
    border: 1px solid #4a2f2a; background: #241a18; color: #d99b8b;
    border-radius: 8px; padding: 9px 12px; font-size: 12.5px; line-height: 1.5;
  }

  .composer-wrap {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 26px 18px 14px;
    background: linear-gradient(to top, #191918 55%, rgba(25, 25, 24, 0));
  }
  .composer-shell { max-width: 760px; margin: 0 auto; }
  .attachment-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
  .attach-chip {
    display: flex; align-items: center; gap: 5px; background: var(--bg-input);
    border: 1px solid var(--border-outer); border-radius: 6px; padding: 3px 7px;
    font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-row);
  }
  .attach-chip-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attach-chip-remove { color: var(--text-summary); font-size: 13px; line-height: 1; }
  .attach-chip-remove:hover { color: var(--accent); }
  .composer {
    background: var(--bg-input); border: 1px solid var(--border-outer); border-radius: 13px;
    padding: 8px 10px 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    transition: border-color 0.28s var(--ease), box-shadow 0.28s var(--ease);
  }
  .composer:focus-within { border-color: #3E3E3A; }
  .composer.dragover { border-color: var(--accent); }
  .composer textarea {
    width: 100%; background: transparent; border: none; outline: none; color: var(--text-main);
    font-size: 14.5px; line-height: 1.55; resize: none; padding: 4px 5px; max-height: 216px; overflow-y: auto;
  }
  .composer textarea::placeholder { color: #77756f; }
  .composer-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
  .composer-left { display: flex; align-items: center; gap: 2px; }
  .ws-chip {
    display: inline-flex; align-items: center; gap: 5px; max-width: 210px;
    border: 1px solid var(--border-outer); border-radius: 999px; padding: 3px 9px 3px 7px;
    font-size: 10.5px; color: var(--text-row); background: transparent;
    transition: all 0.28s var(--ease);
  }
  .ws-chip:hover { border-color: #3E3E3A; color: var(--text-main); }
  .ws-chip.is-root { color: var(--accent); border-color: rgba(217, 119, 87, 0.45); }
  .ws-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
  .ws-options { display: flex; flex-direction: column; gap: 7px; }
  .ws-option {
    display: flex; flex-direction: column; gap: 3px; text-align: left;
    border: 1px solid var(--border-outer); border-radius: 8px; padding: 9px 11px;
    background: #1d1d1b; transition: all 0.28s var(--ease);
  }
  .ws-option:hover { border-color: #3E3E3A; }
  .ws-option.is-active { border-color: var(--accent); background: #241d19; }
  .ws-option-title { font-size: 12.5px; color: var(--text-main); }
  .modal-wide { max-width: 760px; }
  .skill-layout { display: grid; grid-template-columns: 210px 1fr; gap: 14px; margin-top: 12px; }
  .skill-list-col { border: 1px solid var(--border-outer); border-radius: 8px; display: flex; flex-direction: column; min-height: 260px; max-height: 420px; }
  .skill-list-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 9px; border-bottom: 1px solid var(--border-row); font-size: 11px; color: var(--text-summary); }
  .skill-list { overflow: auto; padding: 5px; display: flex; flex-direction: column; gap: 3px; }
  .skill-row { text-align: left; padding: 6px 8px; border-radius: 6px; display: flex; flex-direction: column; gap: 2px; transition: background 0.28s var(--ease); }
  .skill-row:hover { background: var(--bg-input); }
  .skill-row.is-active { background: #241d19; }
  .skill-row-name { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-main); }
  .skill-row.is-active .skill-row-name { color: var(--accent); }
  .skill-row-desc { font-size: 10px; color: var(--text-summary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .skill-form-col { min-width: 0; }
  .skill-form-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .skill-form-actions .modal-actions { margin-top: 0; }
  .skill-form-actions .ws-hint { margin-top: 0; }
  .slash-menu {
    margin-bottom: 7px; background: var(--bg-side); border: 1px solid var(--border-outer);
    border-radius: 9px; max-height: 240px; overflow: auto; box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
    animation: fadeIn 0.24s var(--ease) both;
  }
  .slash-menu-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-summary); padding: 7px 10px 4px; }
  .slash-menu-list { display: flex; flex-direction: column; padding: 0 5px 5px; }
  .slash-item { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; border-radius: 6px; text-align: left; transition: background 0.28s var(--ease); }
  .slash-item:hover, .slash-item.is-active { background: var(--bg-input); }
  .slash-item-name { font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--accent); flex-shrink: 0; }
  .slash-item-desc { font-size: 11px; color: var(--text-summary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slash-empty { padding: 8px 10px; font-size: 11px; color: var(--text-summary); }
  .skill-chip { border-color: rgba(217, 119, 87, 0.5); color: var(--accent); }
  @media (max-width: 720px) {
    .skill-layout { grid-template-columns: 1fr; }
  }
  .ws-option.is-active .ws-option-title { color: var(--accent); }
  .ws-option-desc { font-size: 11px; color: var(--text-summary); line-height: 1.45; }
  .ws-picker { margin-top: 12px; }
  .ws-picker-actions { display: flex; gap: 7px; align-items: center; }
  .ws-select {
    flex: 1; min-width: 0; background: var(--bg-input); border: 1px solid var(--border-outer);
    border-radius: 7px; color: var(--text-main); font-size: 11.5px; padding: 6px 8px; outline: none;
    font-family: 'JetBrains Mono', monospace; transition: border-color 0.28s var(--ease);
  }
  .ws-select:focus { border-color: #4a4a44; }
  .ws-hint { font-size: 10.5px; color: var(--text-summary); margin-top: 6px; min-height: 14px; }
  .ws-hint.is-error { color: #c97564; }
  .ws-warning {
    margin-top: 12px; border: 1px solid #4a2f2a; background: #241a18; color: #d99b8b;
    border-radius: 8px; padding: 9px 11px; font-size: 11px; line-height: 1.55;
  }
  .send-btn {
    width: 30px; height: 30px; border-radius: 7px; background: var(--accent); color: #fff;
    display: inline-flex; align-items: center; justify-content: center;
    transition: all 0.28s var(--ease);
  }
  .send-btn:hover { background: var(--accent-hover); }
  .send-btn svg { width: 15px; height: 15px; }
  .composer-foot { text-align: center; font-size: 10.5px; color: #6f6d67; margin: 8px 0 0; }

  .right-panel {
    width: 540px; flex-shrink: 0; background: var(--bg-side); border-left: 1px solid var(--border-outer);
    display: flex; flex-direction: column;
    transition: all 0.28s var(--ease);
  }
  .right-head {
    height: 46px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 0 10px 0 14px; border-bottom: 1px solid var(--border-outer);
  }
  .right-tabs { display: flex; align-items: center; gap: 2px; }
  .right-tab {
    font-size: 12px; color: var(--text-summary); padding: 5px 9px; border-radius: 6px;
    transition: all 0.28s var(--ease);
  }
  .right-tab:hover { color: var(--text-main); background: #1d1d1b; }
  .right-tab.is-active { color: var(--accent); background: #1d1d1b; }
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 7px 12px; border-bottom: 1px solid var(--border-outer); flex-shrink: 0;
  }
  .pane-title { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; color: var(--text-summary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pane-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  .btn-small {
    font-size: 10.5px; color: var(--text-summary); padding: 3px 7px; border-radius: 5px;
    transition: all 0.28s var(--ease);
  }
  .btn-small:hover { color: var(--text-main); background: var(--bg-input); }
  .btn-primary {
    font-size: 10.5px; color: #fff; background: var(--accent); padding: 4px 10px; border-radius: 5px;
    font-weight: 500; transition: background 0.28s var(--ease);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .preview-host { flex: 1; min-height: 0; background: #fff; position: relative; }
  .preview-empty {
    width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    background: var(--bg-side); color: var(--text-summary); font-size: 12px; text-align: center; padding: 24px;
  }
  #previewFrame { width: 100%; height: 100%; border: 0; display: block; }
  #previewFrame.is-hidden { display: none; }
  #codeEditor {
    flex: 1; width: 100%; background: #111110; color: #d8d6d0; border: none; outline: none; resize: none;
    font-family: 'JetBrains Mono', monospace; font-size: 12px; line-height: 1.65; padding: 12px 14px;
  }
  #fileTree { flex: 1; overflow: auto; padding: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; }
  .tree-row {
    display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 5px;
    color: var(--text-row); transition: background 0.28s var(--ease);
  }
  .tree-row:hover { background: #1d1d1b; }
  .tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .tree-name.is-dir { color: var(--text-main); }
  .tree-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.28s var(--ease); }
  .tree-row:hover .tree-actions { opacity: 1; }
  .tree-action { font-size: 10px; color: var(--text-summary); }
  .tree-action:hover { color: var(--accent); }
  .tree-empty, .tree-error { padding: 10px 12px; font-size: 11.5px; color: var(--text-summary); font-family: 'Inter', sans-serif; }
  .tree-error { color: #c97564; }
  .drop-hint { border-top: 1px solid var(--border-outer); padding: 7px 12px; font-size: 10.5px; color: var(--text-summary); }
  .pane.is-dropping { outline: 1px dashed var(--accent); outline-offset: -6px; }
  #terminalOut { flex: 1; overflow: auto; background: #0D0D0C; padding: 10px 12px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; line-height: 1.6; color: var(--text-row); }
  .term-line { color: var(--text-main); padding: 1px 0; }
  .term-prompt { color: var(--accent); }
  .term-out { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .term-out.is-error { color: #c97564; }
  .term-meta { color: #6f6d67; font-size: 10px; padding: 1px 0 7px; }
  .terminal-input-row { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-top: 1px solid var(--border-outer); }
  .terminal-prefix { color: var(--accent); font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  #terminalInput {
    flex: 1; background: transparent; border: none; outline: none; color: var(--text-main);
    font-family: 'JetBrains Mono', monospace; font-size: 12px;
  }

  .modal { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, 0.62); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 18px; }
  .modal-card {
    width: 100%; max-width: 480px; background: var(--bg-side); border: 1px solid var(--border-outer);
    border-radius: 12px; padding: 18px 18px 16px; animation: fadeIn 0.28s var(--ease) both;
  }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .modal-title { font-size: 13.5px; font-weight: 500; }
  .field { display: block; margin-bottom: 11px; }
  .field-label { display: block; font-size: 10.5px; letter-spacing: 0.02em; color: var(--text-summary); margin-bottom: 4px; }
  .field input, .field textarea {
    width: 100%; background: var(--bg-input); border: 1px solid var(--border-outer); border-radius: 7px;
    color: var(--text-main); font-size: 12px; padding: 7px 9px; outline: none;
    font-family: 'JetBrains Mono', monospace; transition: border-color 0.28s var(--ease);
  }
  .field textarea { font-family: 'Inter', sans-serif; line-height: 1.5; resize: vertical; }
  .field input:focus, .field textarea:focus { border-color: #4a4a44; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 15px; }
  .btn-ghost { font-size: 12px; color: var(--text-summary); padding: 6px 12px; border-radius: 7px; transition: color 0.28s var(--ease); }
  .btn-ghost:hover { color: var(--text-main); }
  .btn-confirm { font-size: 12px; color: #fff; background: var(--accent); padding: 6px 14px; border-radius: 7px; font-weight: 500; transition: background 0.28s var(--ease); }
  .btn-confirm:hover { background: var(--accent-hover); }
  .server-file-row {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 6px 8px; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--text-row);
    transition: background 0.28s var(--ease); text-align: left;
  }
  .server-file-row:hover { background: var(--bg-input); color: var(--text-main); }
  .server-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .server-file-size { color: var(--text-summary); flex-shrink: 0; }
  #serverFileList { max-height: 280px; overflow: auto; }

  @media (max-width: 1180px) {
    .right-panel { width: 420px; }
  }
  @media (max-width: 900px) {
    .sidebar { width: 62px; }
    .sidebar .sidebar-label { display: none; }
    .right-panel { width: 360px; }
    .quick-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="app">

  <aside id="sidebar" class="sidebar">
    <div class="sidebar-top">
      <div class="brand">
        <div class="brand-mark">C</div>
        <span class="brand-name sidebar-label">Claudex</span>
      </div>
      <button id="toggleSidebar" class="icon-btn" title="Đóng/mở thanh bên" aria-label="Đóng mở thanh bên">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"></rect><path d="M6.2 3v10" stroke="currentColor" stroke-width="1.2"></path></svg>
      </button>
    </div>
    <div class="sidebar-new">
      <button id="newChatBtn" class="btn-new" title="Cuộc trò chuyện mới">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>
        <span class="sidebar-label">New chat</span>
      </button>
    </div>
    <div class="sidebar-section sidebar-label">Chats</div>
    <div id="chatList" class="chat-list"></div>
    <div class="sidebar-foot">
      <div class="stats-box sidebar-label">
        <div class="stat-line"><span>RAM</span><span id="statRam">--</span></div>
        <div class="ram-track"><div id="ramBar" class="ram-fill"></div></div>
        <div class="stat-line"><span>Disk</span><span id="statDisk">--</span></div>
        <div class="stat-line"><span>Uptime</span><span id="statUptime">--</span></div>
      </div>
      <button id="settingsBtn" class="btn-settings">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2"></circle><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>
        <span class="sidebar-label">Settings</span>
      </button>
      <button id="skillsBtn" class="btn-settings">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9l2 1.2 2.3-.2.6 2.2 1.9 1.3-1 2.1.4 2.3-2.2.7-1.3 1.9-2.1-1-2.3.4-.7-2.2-1.9-1.3 1-2.1-.4-2.3 2.2-.7z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"></path><circle cx="8" cy="8" r="1.7" fill="none" stroke="currentColor" stroke-width="1.1"></circle></svg>
        <span class="sidebar-label">Skills</span>
      </button>
      <button id="agentsBtn" class="btn-settings">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 1.8h5.1l3.1 3.1v9.3H3.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path><path d="M8.5 1.8v3.1h3.1M5.2 8.4h4.6M5.2 10.6h4.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"></path></svg>
        <span class="sidebar-label">AGENTS.md</span>
      </button>
    </div>
  </aside>

  <main class="center">
    <div class="center-head">
      <span id="chatTitle" class="chat-title">New chat</span>
      <div class="center-head-right">
        <span id="modelBadge" class="model-badge">mặc định</span>
        <button id="openRightBtn" class="icon-btn" title="Đóng/mở khung Artifact" aria-label="Đóng mở khung Artifact">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="10" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"></rect><path d="M9.6 3v10" stroke="currentColor" stroke-width="1.2"></path></svg>
        </button>
      </div>
    </div>

    <div id="chatScroll" class="chat-scroll">
      <div id="welcome" class="welcome">
        <div class="welcome-mark">C</div>
        <h1>Chào bạn, mình là Claudex.</h1>
        <p>Agent đang chạy trực tiếp trong container Linux này. Giao việc, nó sẽ đọc, viết, sửa file và chạy lệnh ngay tại đây.</p>
        <div class="quick-grid">
          <button type="button" class="quick-prompt" data-prompt="Tạo một landing page hiện đại, responsive cho quán cà phê trong file index.html với hero section ấn tượng, dùng CSS thuần.">
            <span class="quick-prompt-title">Dựng một landing page</span>
            <span class="quick-prompt-sub">Tạo index.html hoàn chỉnh với thiết kế responsive.</span>
          </button>
          <button type="button" class="quick-prompt" data-prompt="Kiểm tra workspace hiện tại, sau đó tạo một script Node.js đọc file JSON và in ra bản tóm tắt dữ liệu. Tạo file dữ liệu mẫu và chạy thử để xác nhận.">
            <span class="quick-prompt-title">Viết và chạy script xử lý dữ liệu</span>
            <span class="quick-prompt-sub">Tạo file, chạy thử và xác nhận kết quả.</span>
          </button>
          <button type="button" class="quick-prompt" data-prompt="Liệt kê toàn bộ file trong workspace và giải thích dự án này làm gì dựa trên mã nguồn.">
            <span class="quick-prompt-title">Khám phá workspace</span>
            <span class="quick-prompt-sub">Đọc và giải thích mã nguồn hiện có.</span>
          </button>
          <button type="button" class="quick-prompt" data-prompt="Kiểm tra tài nguyên container (phiên bản node, dung lượng ổ cứng, RAM) và đề xuất tối ưu cho cấu hình 1 CPU và 1GB RAM.">
            <span class="quick-prompt-title">Kiểm tra tài nguyên container</span>
            <span class="quick-prompt-sub">Xem CPU, RAM, Disk và đề xuất tối ưu.</span>
          </button>
        </div>
      </div>
      <div id="messages" class="messages is-hidden"></div>
    </div>

    <div class="composer-wrap">
      <div class="composer-shell">
        <div id="slashMenu" class="slash-menu is-hidden">
          <div class="slash-menu-title">Skill</div>
          <div id="slashMenuList" class="slash-menu-list"></div>
        </div>
        <div id="skillChipBar" class="attachment-bar is-hidden"></div>
        <div id="attachmentBar" class="attachment-bar is-hidden"></div>
        <div id="composer" class="composer">
          <textarea id="input" rows="1" placeholder="How can I help you today?" aria-label="Nhập tin nhắn"></textarea>
          <div class="composer-actions">
            <div class="composer-left">
              <button id="attachBtn" class="icon-btn" title="Tải file từ máy lên" aria-label="Tải file từ máy lên">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8.4 3.4l3.9 3.9a2.7 2.7 0 0 1-3.8 3.8L4.4 7.2a1.8 1.8 0 0 1 2.6-2.6l4.1 4.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>
              </button>
              <button id="serverAttachBtn" class="icon-btn" title="Đính kèm file có sẵn trên server" aria-label="Đính kèm file trên server">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.4 1.8h5.1l3.1 3.1v9.3H3.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"></path><path d="M8.5 1.8v3.1h3.1M8 7.6v4M6 9.6h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path></svg>
              </button>
              <input id="fileInput" type="file" multiple class="is-hidden" />
            </div>
            <div class="composer-left">
              <button id="wsBtn" class="ws-chip" type="button" title="Chọn workspace cho hội thoại">
                <svg class="chevron" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 10.5 L8 6 L12.5 10.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>
                <span id="wsLabel" class="ws-chip-label">Auto workspace</span>
              </button>
              <button id="stopBtn" class="icon-btn is-hidden" title="Dừng" aria-label="Dừng yêu cầu">
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.2" fill="currentColor"></rect></svg>
              </button>
              <button id="sendBtn" class="send-btn" title="Gửi" aria-label="Gửi tin nhắn">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.6V3.6M4.2 7.2L8 3.4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>
              </button>
            </div>
          </div>
        </div>
        <p class="composer-foot">Claudex có thể mắc lỗi. Hãy kiểm tra các file quan trọng trước khi triển khai.</p>
      </div>
    </div>
  </main>

  <aside id="rightPanel" class="right-panel is-hidden">
    <div class="right-head">
      <div class="right-tabs">
        <button type="button" class="right-tab is-active" data-tab="preview">Preview</button>
        <button type="button" class="right-tab" data-tab="code">Code</button>
        <button type="button" class="right-tab" data-tab="files">Files</button>
        <button type="button" class="right-tab" data-tab="terminal">Terminal</button>
      </div>
      <button id="closeRightBtn" class="icon-btn" title="Đóng khung Artifact" aria-label="Đóng khung Artifact">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>

    <div id="panePreview" class="pane">
      <div class="pane-head">
        <span id="previewName" class="pane-title">Chưa chọn file</span>
        <div class="pane-actions">
          <button id="previewRefresh" class="btn-small" type="button">Refresh</button>
          <button id="previewOpen" class="btn-small" type="button">Tab mới</button>
        </div>
      </div>
      <div class="preview-host">
        <div id="previewEmpty" class="preview-empty">Chọn một file trong chat hoặc File Explorer để xem trước.</div>
        <iframe id="previewFrame" class="is-hidden" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      </div>
    </div>

    <div id="paneCode" class="pane is-hidden">
      <div class="pane-head">
        <span id="codeName" class="pane-title">Chưa chọn file</span>
        <div class="pane-actions">
          <button id="codeCopy" class="btn-small" type="button">Copy</button>
          <button id="codeDownload" class="btn-small" type="button">Download</button>
          <button id="codeSave" class="btn-primary" type="button" title="Lưu (Ctrl+S)">Save</button>
        </div>
      </div>
      <textarea id="codeEditor" spellcheck="false" aria-label="Trình soạn thảo code"></textarea>
    </div>

    <div id="paneFiles" class="pane is-hidden">
      <div class="pane-head">
        <span class="pane-title">Workspace</span>
        <div class="pane-actions">
          <button id="newFileBtn" class="btn-small" type="button">Tạo file</button>
          <button id="newDirBtn" class="btn-small" type="button">Tạo thư mục</button>
          <button id="refreshFilesBtn" class="btn-small" type="button">Refresh</button>
          <button id="uploadFilesBtn" class="btn-small" type="button">Upload</button>
          <input id="uploadFileInput" type="file" multiple class="is-hidden" />
        </div>
      </div>
      <div id="fileTree"></div>
      <div class="drop-hint">Kéo thả file vào đây để tải lên workspace root.</div>
    </div>

    <div id="paneTerminal" class="pane is-hidden">
      <div id="terminalOut"></div>
      <div class="terminal-input-row">
        <span class="terminal-prefix">$</span>
        <input id="terminalInput" type="text" autocomplete="off" spellcheck="false" placeholder="Nhập lệnh bash rồi Enter" aria-label="Lệnh bash" />
        <button id="terminalClear" class="btn-small" type="button">Clear</button>
      </div>
    </div>
  </aside>
</div>

<div id="skillsModal" class="modal is-hidden">
  <div class="modal-card modal-wide">
    <div class="modal-head">
      <span class="modal-title">Skills</span>
      <button id="skillsClose" class="icon-btn" type="button" aria-label="Đóng">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <p class="ws-hint">Skill lưu tại <span class="font-mono">skills/&lt;tên&gt;/SKILL.md</span> ở thư mục gốc. Gõ <span class="font-mono">/</span> trong ô soạn tin để gọi nhanh.</p>
    <div class="skill-layout">
      <div class="skill-list-col">
        <div class="skill-list-head">
          <span>Danh sách</span>
          <button id="skillNewBtn" class="btn-small" type="button">Thêm skill</button>
        </div>
        <div id="skillList" class="skill-list"></div>
      </div>
      <div class="skill-form-col">
        <label class="field">
          <span class="field-label">Tên skill (chữ thường, gạch ngang)</span>
          <input id="skillName" type="text" placeholder="web-testing" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">Tiêu đề</span>
          <input id="skillTitle" type="text" placeholder="Kiểm thử giao diện web" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">Mô tả ngắn</span>
          <input id="skillDesc" type="text" placeholder="Dùng khi cần kiểm thử UI bằng trình duyệt" autocomplete="off" />
        </label>
        <label class="field">
          <span class="field-label">Nội dung SKILL.md</span>
          <textarea id="skillContent" rows="9" class="font-mono" placeholder="# Hướng dẫn&#10;1. Bước một...&#10;2. Bước hai..."></textarea>
        </label>
        <div class="skill-form-actions">
          <span id="skillHint" class="ws-hint"></span>
          <div class="modal-actions">
            <button id="skillDeleteBtn" class="btn-ghost" type="button">Xóa</button>
            <button id="skillSaveBtn" class="btn-confirm" type="button">Lưu skill</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="agentsModal" class="modal is-hidden">
  <div class="modal-card modal-wide">
    <div class="modal-head">
      <span class="modal-title">AGENTS.md của workspace</span>
      <button id="agentsClose" class="icon-btn" type="button" aria-label="Đóng">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <p id="agentsMeta" class="ws-hint"></p>
    <label class="field">
      <span class="field-label">Nội dung AGENTS.md</span>
      <textarea id="agentsContent" rows="14" class="font-mono"></textarea>
    </label>
    <div class="modal-actions">
      <button id="agentsCreateBtn" class="btn-ghost" type="button">Tạo mẫu</button>
      <button id="agentsCancel" class="btn-ghost" type="button">Hủy</button>
      <button id="agentsSave" class="btn-confirm" type="button">Lưu</button>
    </div>
  </div>
</div>

<div id="wsModal" class="modal is-hidden">
  <div class="modal-card">
    <div class="modal-head">
      <span class="modal-title">Workspace cho cuộc trò chuyện</span>
      <button id="wsClose" class="icon-btn" type="button" aria-label="Đóng">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <div class="ws-options">
      <button class="ws-option" type="button" data-mode="auto">
        <span class="ws-option-title">Auto workspace</span>
        <span class="ws-option-desc">Tự tạo thư mục riêng cho phiên này rồi làm việc bên trong. An toàn nhất.</span>
      </button>
      <button class="ws-option" type="button" data-mode="picker">
        <span class="ws-option-title">Chọn workspace hoặc tự tạo</span>
        <span class="ws-option-desc">Chỉ định thư mục con hiện có hoặc tạo mới ngay tại đây.</span>
      </button>
      <button class="ws-option" type="button" data-mode="root">
        <span class="ws-option-title">Không workspace (thư mục gốc)</span>
        <span class="ws-option-desc">Agent đọc/ghi trực tiếp ngay trong thư mục gốc của ứng dụng.</span>
      </button>
    </div>
    <div id="wsPickerBox" class="ws-picker is-hidden">
      <label class="field">
        <span class="field-label">Tên hoặc đường dẫn thư mục</span>
        <input id="wsNameInput" type="text" placeholder="my-project" autocomplete="off" />
      </label>
      <div class="ws-picker-actions">
        <select id="wsSelect" class="ws-select"></select>
        <button id="wsCreateBtn" class="btn-small" type="button">Tạo thư mục</button>
      </div>
      <div id="wsPickerHint" class="ws-hint"></div>
    </div>
    <div id="wsRootWarning" class="ws-warning is-hidden">
      Cảnh báo: ở chế độ không workspace, agent làm việc trực tiếp trong thư mục gốc / nơi chứa server.js, package.json, node_modules và .env. Thao tác sai có thể ghi đè hoặc xóa chính ứng dụng. Các file hệ thống được bảo vệ khỏi lệnh xóa, nhưng hãy sao lưu trước khi dùng.
    </div>
    <div class="modal-actions">
      <button id="wsCancel" class="btn-ghost" type="button">Hủy</button>
      <button id="wsApply" class="btn-confirm" type="button">Áp dụng</button>
    </div>
  </div>
</div>

<div id="settingsModal" class="modal is-hidden">
  <div class="modal-card">
    <div class="modal-head">
      <span class="modal-title">Settings</span>
      <button id="closeSettings" class="icon-btn" type="button" aria-label="Đóng">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <label class="field">
      <span class="field-label">API Key</span>
      <input id="setApiKey" type="password" placeholder="sk-..." autocomplete="off" />
    </label>
    <label class="field">
      <span class="field-label">Base URL (Custom Provider)</span>
      <input id="setBaseURL" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
    </label>
    <label class="field">
      <span class="field-label">Model Name</span>
      <input id="setModel" type="text" placeholder="claudex-3-5-sonnet-20241022" autocomplete="off" />
    </label>
    <label class="field">
      <span class="field-label">Custom System Prompt</span>
      <textarea id="setSystemPrompt" rows="4"></textarea>
    </label>
    <div class="field-row">
      <label class="field">
        <span class="field-label">Max Agent Steps</span>
        <input id="setMaxSteps" type="number" min="1" max="40" value="12" />
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <input id="setPassword" type="password" placeholder="tùy chọn" autocomplete="off" />
      </label>
    </div>
    <div class="modal-actions">
      <button id="cancelSettings" class="btn-ghost" type="button">Hủy</button>
      <button id="saveSettings" class="btn-confirm" type="button">Lưu</button>
    </div>
  </div>
</div>

<div id="serverFileModal" class="modal is-hidden">
  <div class="modal-card">
    <div class="modal-head">
      <span class="modal-title">Đính kèm file trên server</span>
      <button id="closeServerFile" class="icon-btn" type="button" aria-label="Đóng">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>
      </button>
    </div>
    <label class="field">
      <span class="field-label">Tìm theo đường dẫn</span>
      <input id="serverFileSearch" type="text" placeholder="filter path..." autocomplete="off" />
    </label>
    <div id="serverFileList"></div>
  </div>
</div>

<script>
const DEFAULT_SETTINGS = {
  apiKey: '',
  baseURL: '',
  model: '',
  systemPrompt: '',
  maxSteps: 12,
  password: ''
};
const STORAGE_KEY = 'claudex_workspace_settings_v2';
const CHATS_KEY = 'claudex_workspace_chats_v2';
const state = {
  settings: Object.assign({}, DEFAULT_SETTINGS),
  chats: [],
  activeChatId: null,
  rightOpen: false,
  sidebarOpen: true,
  activeTab: 'preview',
  currentFile: null,
  currentFileContent: '',
  codeDirty: false,
  attachments: [],
  sending: false,
  abortController: null,
  serverFiles: [],
  workspace: { mode: 'auto', root: '', label: 'Auto workspace', active: '', created: false },
  skills: [],
  skillMenuIndex: 0,
  skillMenuItems: [],
  pendingSkill: null
};

function wsQuery() {
  const root = state.workspace && state.workspace.active ? state.workspace.active : '';
  return root && root !== '.' ? 'ws=' + encodeURIComponent(root) : '';
}

function wsParam(prefix) {
  const query = wsQuery();
  if (!query) return '';
  return (prefix === '?' ? '?' : '&') + query;
}

function applyWorkspaceBadge() {
  const chip = el('wsBtn');
  const label = el('wsLabel');
  if (!chip || !label) return;
  const workspace = state.workspace || {};
  if (workspace.mode === 'root') {
    label.textContent = 'Không workspace · thư mục gốc';
    chip.classList.add('is-root');
    chip.title = 'Agent làm việc trực tiếp trong thư mục gốc của ứng dụng';
  } else if (workspace.mode === 'picker') {
    label.textContent = workspace.active || 'Chọn workspace';
    chip.classList.remove('is-root');
    chip.title = 'Workspace đang dùng: ' + (workspace.active || '(chưa chọn)');
  } else {
    label.textContent = workspace.created ? 'Auto · ' + (workspace.active || 'mới') : 'Auto workspace';
    chip.classList.remove('is-root');
    chip.title = workspace.created ? 'Đã tạo workspace: ' + workspace.active : 'Tự tạo workspace mới cho phiên này';
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function styledMarkdown(text) {
  let html = '';
  try {
    html = marked.parse(text || '', { breaks: true, gfm: true });
  } catch (err) {
    html = '<p>' + escapeHtml(text || '') + '</p>';
  }
  return html;
}

function decorateCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code').forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (err) {
      /* highlighting is best effort */
    }
    const pre = block.parentElement;
    if (!pre || !pre.parentElement) return;
    if (pre.parentElement.classList.contains('code-block')) return;
    const langClass = Array.from(block.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : 'text';
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.textContent = lang;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      const text = block.innerText || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
          }, 1400);
        });
      } else {
        copyBtn.textContent = 'Copy unavailable';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 1400);
      }
    });
    head.appendChild(label);
    head.appendChild(copyBtn);
    const body = document.createElement('div');
    body.className = 'code-body';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(head);
    body.appendChild(pre);
    wrapper.appendChild(body);
  });
}

function verbTense(name) {
  if (name === 'write_file') return { past: 'tạo file', ing: 'đang tạo file' };
  if (name === 'edit_file') return { past: 'sửa file', ing: 'đang sửa file' };
  if (name === 'read_file') return { past: 'đọc file', ing: 'đang đọc file' };
  if (name === 'list_directory') return { past: 'kiểm tra thư mục', ing: 'đang kiểm tra thư mục' };
  if (name === 'delete_path') return { past: 'xóa', ing: 'đang xóa' };
  if (name === 'execute_command') return { past: 'chạy lệnh', ing: 'đang chạy lệnh' };
  return { past: 'thực hiện', ing: 'đang thực hiện' };
}

const LABELS = {
  created: 'Tạo file',
  edited: 'Sửa file',
  ran: 'Chạy lệnh',
  read: 'Đọc file',
  listed: 'Liệt kê thư mục',
  deleted: 'Xóa',
  presented: 'Presented file'
};

function stepCategory(entry) {
  const name = entry && entry.name;
  if (name === 'write_file' || name === 'write_multiple_files') return 'create';
  if (name === 'edit_file' || name === 'replace_in_file') return 'edit';
  if (name === 'execute_command' || name === 'find_files') return 'command';
  if (name === 'read_file' || name === 'read_multiple_files') return 'read';
  if (name === 'list_directory' || name === 'list_directory_tree' || name === 'glob_files' || name === 'grep_search') return 'list';
  if (name === 'delete_path') return 'remove';
  if (name === 'move_path' || name === 'copy_path') return 'move';
  if (name === 'present') return 'present';
  if (name === 'read_skill' || name === 'list_skills') return 'skill';
  return 'other';
}

const CATEGORY_LABELS = {
  create: ['Tạo file', 'tạo %s file'],
  edit: ['Sửa file', 'sửa %s file'],
  command: ['Chạy lệnh', 'chạy %s lệnh'],
  read: ['Đọc file', 'đọc %s file'],
  list: ['Duyệt thư mục', 'duyệt %s thư mục'],
  remove: ['Xóa', 'xóa %s mục'],
  move: ['Di chuyển file', 'di chuyển %s mục'],
  present: ['Chia sẻ file', 'chia sẻ %s file'],
  skill: ['Dùng skill', 'dùng %s skill'],
  other: ['Dùng công cụ', 'dùng %s công cụ']
};

const CATEGORY_ORDER = ['create', 'edit', 'command', 'read', 'list', 'move', 'remove', 'present', 'skill', 'other'];

function buildSummaryText(entries, running) {
  if (running) return 'Đang thực hiện...';
  if (!entries || !entries.length) return 'Không có hành động';
  const counts = {};
  const files = [];
  for (const entry of entries) {
    const category = stepCategory(entry);
    counts[category] = (counts[category] || 0) + 1;
    if ((category === 'create' || category === 'edit' || category === 'present') && entry.file && files.length < 3 && !files.includes(entry.file)) {
      files.push(entry.file);
    }
  }
  const parts = [];
  CATEGORY_ORDER.forEach((category) => {
    const count = counts[category];
    if (!count) return;
    const labels = CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
    parts.push(count === 1 ? labels[0] : labels[1].replace('%s', String(count)));
  });
  let text = capitalizeFirst(parts.join(', '));
  if (files.length) {
    const suffix = files.length < 3 ? files.join(', ') : files.slice(0, 2).join(', ') + '…';
    text += ' · ' + suffix;
  }
  return text;
}

function capitalizeFirst(text) {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function chevronSvg(open) {
  const path = open ? 'M6 3.5 L10.5 8 L6 12.5' : 'M3.5 10.5 L8 6 L12.5 10.5';
  return '<svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="' + path + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
}


function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function statusLabel(status) {
  if (status === 'running') return 'đang chạy';
  if (status === 'error') return 'lỗi';
  return 'xong';
}

function stepRowLabel(step) {
  const base = LABELS[step.kind] || 'Hành động';
  return base + (step.file ? ' ' : '');
}

function stepToolLabel(step) {
  if (!step) return '';
  const text = String(step.summary || '').trim();
  if (text) return text;
  return String(step.name || '');
}

function buildDetailHtml(step) {
  const detail = step.detail || {};
  if (detail.kind === 'command') {
    const exit = detail.exitCode != null ? detail.exitCode : '?';
    return '<div class="detail-meta"><span class="detail-cwd">' + escapeHtml(detail.cwd || '') + '</span><span class="detail-exit' + (exit === 0 ? '' : ' is-error') + '">exit ' + escapeHtml(String(exit)) + '</span></div>' +
      '<pre class="detail-code"><span class="detail-prompt">$</span> ' + escapeHtml(detail.command || '') + '</pre>' +
      (detail.stdout ? '<pre class="detail-code">' + escapeHtml(detail.stdout) + '</pre>' : '') +
      (detail.stderr ? '<pre class="detail-code is-error">' + escapeHtml(detail.stderr) + '</pre>' : '');
  }
  if (detail.kind === 'diff') {
    const lines = (detail.lines || []).map((line) => {
      const prefix = line.type === 'add' ? '+' : '-';
      return '<div class="diff-line ' + (line.type === 'add' ? 'is-add' : 'is-del') + '">' + escapeHtml(prefix + ' ' + line.text) + '</div>';
    }).join('');
    return '<div class="detail-meta"><span class="detail-cwd">' + escapeHtml(detail.filepath || '') + '</span></div><div class="detail-diff">' + (lines || '<div class="diff-line">Không có thay đổi chi tiết</div>') + '</div>';
  }
  if (detail.kind === 'list') {
    const rows = (detail.entries || []).map((entry) => {
      const type = entry.type === 'dir' ? 'dir' : 'file';
      return '<div class="detail-row"><span class="detail-type">' + escapeHtml(type) + '</span><span class="detail-path">' + escapeHtml(entry.path) + '</span><span class="detail-size">' + escapeHtml(entry.sizeHuman || '') + '</span></div>';
    }).join('');
    return '<div class="detail-meta"><span class="detail-cwd">' + escapeHtml(detail.dirpath || '.') + '</span></div><div class="detail-list">' + (rows || '<div class="detail-row">Thư mục trống</div>') + '</div>';
  }
  if (detail.kind === 'read') {
    const range = 'dòng ' + (detail.startLine || 1) + '-' + (detail.endLine || detail.totalLines || 0);
    return '<div class="detail-meta"><span class="detail-cwd">' + escapeHtml(detail.filepath || '') + '</span><span class="detail-exit">' + escapeHtml(range) + '</span></div><pre class="detail-code">' + escapeHtml(detail.content || '') + '</pre>';
  }
  return '<pre class="detail-code' + (detail.error ? ' is-error' : '') + '">' + escapeHtml(detail.resultPreview || JSON.stringify(step.args || {}, null, 2)) + '</pre>';
}

function syncStepRowDetail(row, step) {
  const detailInner = row.querySelector('.action-row-detail-inner');
  if (!detailInner) return;
  const marker = (step.status || '') + '|' + (step.durationMs || 0) + '|' + (step.open ? '1' : '0');
  if (detailInner.dataset.marker === marker) return;
  detailInner.dataset.marker = marker;
  if (step.status === 'running') {
    detailInner.innerHTML = '<pre class="detail-code">' + escapeHtml(JSON.stringify(step.args || {}, null, 2)) + '</pre>';
  } else {
    detailInner.innerHTML = buildDetailHtml(step);
  }
}

function applyStepRowState(row, step) {
  row.dataset.stepId = step.id;
  row.classList.toggle('is-running', step.status === 'running');
  row.classList.toggle('is-error', step.status === 'error');
  row.classList.toggle('is-open', Boolean(step.open));

  const textWrap = row.querySelector('.action-row-text');
  if (textWrap) {
    const lead = textWrap.querySelector('.row-lead');
    if (lead) {
      const isKnownKind = step.kind && step.kind !== 'other';
      const leadText = isKnownKind ? stepRowLabel(step) : (stepToolLabel(step) || stepRowLabel(step));
      if (lead.textContent !== leadText) lead.textContent = leadText;
    }
    const fileLink = textWrap.querySelector('.row-file');
    const shimmerEl = textWrap.querySelector('.shimmer');
    const summaryEl = textWrap.querySelector('.row-summary');
    if (step.file) {
      let target = fileLink;
      if (!target) {
        target = document.createElement('span');
        target.className = 'row-file';
        target.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const current = row.__step || step;
          if (current.fileIsCommand) return;
          openFileInRight(current.file, previewModeFor(current.file, String(current.file).split('.').pop()));
        });
        textWrap.appendChild(target);
      }
      if (target.textContent !== step.file) target.textContent = step.file;
      target.classList.toggle('row-command', Boolean(step.fileIsCommand));
      if (shimmerEl) shimmerEl.remove();
      if (summaryEl) summaryEl.remove();
    } else if (step.status === 'running') {
      if (fileLink) fileLink.remove();
      if (summaryEl) summaryEl.remove();
      if (!shimmerEl) {
        const running = document.createElement('span');
        running.className = 'shimmer';
        textWrap.appendChild(running);
      }
      const runner = textWrap.querySelector('.shimmer');
      if (runner) {
        const label = step.summary || 'Đang thực hiện';
        if (runner.textContent !== label) runner.textContent = label;
      }
    } else {
      if (fileLink) fileLink.remove();
      if (shimmerEl) shimmerEl.remove();
      let summaryNode = summaryEl;
      if (!summaryNode) {
        summaryNode = document.createElement('span');
        summaryNode.className = 'row-summary';
        textWrap.appendChild(summaryNode);
      }
      const label = step.summary || '';
      if (summaryNode.textContent !== label) summaryNode.textContent = label;
    }
  }

  const meta = row.querySelector('.row-meta');
  if (meta) {
    let metaText = '';
    if (step.status === 'running') metaText = 'đang chạy';
    else if (step.status === 'error') metaText = 'lỗi · ' + formatDuration(step.durationMs);
    else metaText = formatDuration(step.durationMs);
    if (meta.textContent !== metaText) meta.textContent = metaText;
  }

  const arrow = row.querySelector('.row-arrow');
  if (arrow) {
    const wanted = chevronSvg(Boolean(step.open));
    if (arrow.dataset.open !== (step.open ? '1' : '0')) {
      arrow.dataset.open = step.open ? '1' : '0';
      arrow.innerHTML = wanted;
    }
  }

  syncStepRowDetail(row, step);
  row.__step = step;
}

function buildStepRow(step) {
  const row = document.createElement('div');
  row.className = 'action-row';
  row.dataset.stepId = step.id;
  row.__step = step;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'action-row-head';
  const textWrap = document.createElement('span');
  textWrap.className = 'action-row-text';
  const lead = document.createElement('span');
  lead.className = 'row-lead';
  const knownKind = step.kind && step.kind !== 'other';
  lead.textContent = knownKind ? stepRowLabel(step) : (stepToolLabel(step) || stepRowLabel(step));
  textWrap.appendChild(lead);
  if (step.file) {
    const fileLink = document.createElement('span');
    fileLink.className = 'row-file';
    fileLink.textContent = step.file;
    if (step.fileIsCommand) fileLink.classList.add('row-command');
    fileLink.addEventListener('click', (ev) => {
      ev.stopPropagation();
        if (step.fileIsCommand) return;
      openFileInRight(step.file, previewModeFor(step.file, String(step.file).split('.').pop()));
    });
    textWrap.appendChild(fileLink);
  } else if (step.status === 'running') {
    const running = document.createElement('span');
    running.className = 'shimmer';
    running.textContent = stepToolLabel(step) || 'Đang thực hiện';
    textWrap.appendChild(running);
  } else {
    const summary = document.createElement('span');
    summary.className = 'row-summary';
    summary.textContent = step.summary || '';
    textWrap.appendChild(summary);
  }
  const meta = document.createElement('span');
  meta.className = 'row-meta';
  if (step.status === 'running') meta.textContent = 'đang chạy';
  else if (step.status === 'error') meta.textContent = 'lỗi · ' + formatDuration(step.durationMs);
  else meta.textContent = formatDuration(step.durationMs);
  const arrow = document.createElement('span');
  arrow.className = 'row-arrow';
  arrow.innerHTML = chevronSvg(false);

  head.appendChild(textWrap);
  head.appendChild(meta);
  head.appendChild(arrow);

  const detail = document.createElement('div');
  detail.className = 'action-row-detail';
  const detailInner = document.createElement('div');
  detailInner.className = 'action-row-detail-inner';
  if (step.status === 'running') {
    detailInner.innerHTML = '<pre class="detail-code">' + escapeHtml(JSON.stringify(step.args || {}, null, 2)) + '</pre>';
  } else {
    detailInner.innerHTML = buildDetailHtml(step);
  }
  detail.appendChild(detailInner);

  head.addEventListener('click', () => {
    const current = row.__step || step;
    current.open = !current.open;
    const open = Boolean(current.open);
    row.classList.toggle('is-open', open);
    arrow.dataset.open = open ? '1' : '0';
    arrow.innerHTML = chevronSvg(open);
  });

  row.appendChild(head);
  row.appendChild(detail);
  applyStepRowState(row, step);
  return row;
}

function buildTimeline(block) {
  if (block.el && block.el.isConnected) return block.el;
  const entries = block.entries || [];
  const running = block.running;
  const wrap = document.createElement('div');
  wrap.className = 'timeline';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'timeline-header';
  const summary = document.createElement('span');
  summary.className = running ? 'timeline-summary shimmer' : 'timeline-summary';
  summary.textContent = buildSummaryText(entries, running);
  const arrow = document.createElement('span');
  arrow.className = 'timeline-arrow';
  arrow.innerHTML = chevronSvg(block.collapsed === false);
  header.appendChild(summary);
  header.appendChild(arrow);

  const stack = document.createElement('div');
  const openInitially = block.collapsed === false || Boolean(running);
  stack.className = 'action-stack' + (openInitially ? ' is-open' : '');
  const inner = document.createElement('div');
  inner.className = ACTION_CHILD_CLASS;
  entries.forEach((step) => inner.appendChild(buildStepRow(step)));
  stack.appendChild(inner);
  applyRowOpenStates(block);

  header.addEventListener('click', () => {
    const open = stack.classList.toggle('is-open');
    block.collapsed = !open;
    arrow.innerHTML = chevronSvg(open);
  });

  wrap.appendChild(header);
  wrap.appendChild(stack);
  return wrap;
}

function artifactActionLabel(action) {
  if (action === 'edited') return 'Đã sửa file';
  if (action === 'created') return 'Đã tạo file';
  return 'Đã cập nhật file';
}

function buildArtifactCard(artifact, action) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'artifact-card';
  const meta = document.createElement('span');
  meta.className = 'artifact-meta';
  const label = document.createElement('span');
  label.className = 'artifact-action';
  label.textContent = artifactActionLabel(action);
  const name = document.createElement('span');
  name.className = 'artifact-name';
  name.textContent = artifact.filename || artifact.filepath;
  const kind = document.createElement('span');
  kind.className = 'artifact-kind';
  kind.textContent = (artifact.kind || 'File') + ' · ' + (artifact.sizeHuman || '');
  meta.appendChild(label);
  meta.appendChild(name);
  meta.appendChild(kind);
  const open = document.createElement('span');
  open.className = 'artifact-open';
  open.textContent = 'Mở';
  card.appendChild(meta);
  card.appendChild(open);
  card.addEventListener('click', () => {
    openFileInRight(artifact.filepath, artifact.ext === 'html' || artifact.ext === 'htm' || artifact.ext === 'svg' || artifact.ext === 'md' ? 'preview' : 'code');
  });
  return card;
}

function buildTurnEl(turn) {
  const wrap = document.createElement('div');
  wrap.className = 'turn fade-in';

  const userMsg = turn.user;
  if (userMsg && userMsg.content) {
    const userRow = document.createElement('div');
    userRow.className = 'user-row';
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = userMsg.content;
    userRow.appendChild(bubble);
    if (Array.isArray(userMsg.attachments) && userMsg.attachments.length) {
      const attachments = document.createElement('div');
      attachments.className = 'user-attachments';
      attachments.textContent = userMsg.attachments.join('  ·  ');
      userRow.appendChild(attachments);
    }
    wrap.appendChild(userRow);
  }

  const assistant = turn.assistant || {};
  if (assistant.timeline && assistant.timeline.entries && assistant.timeline.entries.length > 0) {
    wrap.appendChild(buildTimeline(assistant.timeline));
  }

  const body = document.createElement('div');
  body.className = 'md-body';
  const content = assistant.content || '';
  if (content) {
    body.innerHTML = styledMarkdown(content);
    decorateCodeBlocks(body);
    body.dataset.rendered = content;
  } else if (assistant.streaming) {
    body.innerHTML = '<span class="shimmer">Đang soạn câu trả lời</span>';
  }
  if (assistant.streaming) body.classList.add('is-streaming');
  wrap.appendChild(body);

  if (assistant.artifacts && assistant.artifacts.length) {
    const grid = document.createElement('div');
    grid.className = 'artifact-grid';
    assistant.artifacts.forEach((artifact) => grid.appendChild(buildArtifactCard(artifact, artifact.action)));
    wrap.appendChild(grid);
  }

  if (assistant.error) {
    const err = document.createElement('div');
    err.className = 'turn-error';
    err.textContent = assistant.error;
    wrap.appendChild(err);
  }

  if (assistant.timeline) assistant.timeline.el = null;
  return wrap;
}





function ensureTurnBody(turn) {
  if (!turn || !turn.el) return null;
  let body = turn.el.querySelector('.md-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'md-body';
    turn.el.appendChild(body);
  }
  return body;
}

function applyRowOpenStates(block) {
  if (!block || !block.el) return;
  const openIds = {};
  const expandedIds = Array.isArray(block.openIds) ? block.openIds : [];
  expandedIds.forEach((id) => {
    openIds[id] = true;
  });
  block.el.querySelectorAll('.action-row').forEach((row) => {
    const shouldOpen = Boolean(openIds[row.dataset.stepId] || (row.__step && row.__step.open));
    row.classList.toggle('is-open', shouldOpen);
    const arrow = row.querySelector('.row-arrow');
    if (arrow) {
      arrow.dataset.open = shouldOpen ? '1' : '0';
      arrow.innerHTML = chevronSvg(shouldOpen);
    }
  });
}

function getTurnTimeline(turn) {
  if (!turn || !turn.el) return null;
  if (!turn.assistant) return null;
  const orphan = turn.el.querySelector('.timeline');
  if (!turn.assistant.timeline) {
    turn.assistant.timeline = { entries: [], running: false, collapsed: true, expanded: false, openIds: [], el: null };
  }
  const block = turn.assistant.timeline;
  if ((!block.el || !turn.el.contains(block.el)) && orphan) {
    block.el = orphan;
    const summaryEl = orphan.querySelector('.timeline-summary');
    if (summaryEl) summaryEl.textContent = buildSummaryText(block.entries || [], block.running);
  }
  if (!block.el || !turn.el.contains(block.el)) {
    const el = buildTimeline(block);
    block.el = el;
    const bodyEl = ensureTurnBody(turn);
    if (bodyEl) turn.el.insertBefore(el, bodyEl);
    else turn.el.appendChild(el);
  }
  return block;
}

function renderTurnBody(turn) {
  if (!turn || !turn.el) return;
  const body = ensureTurnBody(turn);
  if (!body) return;
  const assistant = turn.assistant || {};
  const content = assistant.content || '';
  if (content && body.dataset.rendered !== content) {
    body.innerHTML = styledMarkdown(content);
    decorateCodeBlocks(body);
    body.dataset.rendered = content;
  }
  if (!content && assistant.streaming) {
    body.innerHTML = '<span class="shimmer">Đang soạn câu trả lời</span>';
    body.dataset.rendered = '';
  }
  if (assistant.streaming) body.classList.add('is-streaming');
  else body.classList.remove('is-streaming');
  scrollToBottom();
}

function renderTurnArtifacts(turn) {
  if (!turn || !turn.el) return;
  const old = turn.el.querySelector('.artifact-grid');
  if (old) old.remove();
  const list = (turn.assistant && turn.assistant.artifacts) || [];
  if (!list.length) return;
  const grid = document.createElement('div');
  grid.className = 'artifact-grid';
  list.forEach((artifact) => grid.appendChild(buildArtifactCard(artifact, artifact.action)));
  const err = turn.el.querySelector('.turn-error');
  if (err) turn.el.insertBefore(grid, err);
  else turn.el.appendChild(grid);
}

function renderTurnError(turn, message) {
  if (!turn || !turn.el) return;
  const old = turn.el.querySelector('.turn-error');
  if (old) old.remove();
  if (!message) return;
  const err = document.createElement('div');
  err.className = 'turn-error';
  err.textContent = message;
  turn.el.appendChild(err);
}

const ACTION_CHILD_CLASS = 'action-children';
const ACTION_STEP_LIMIT = 6;

function ensureTimelineParts(stack) {
  let children = stack.querySelector('.' + ACTION_CHILD_CLASS);
  if (!children) {
    children = document.createElement('div');
    children.className = ACTION_CHILD_CLASS;
    stack.appendChild(children);
  }
  return { children: children };
}

function refreshTimelineBlock(block) {
  if (!block || !block.el) return;
  const stack = block.el.querySelector('.action-stack');
  if (!stack) return;
  const summaryEl = block.el.querySelector('.timeline-summary');
  const arrow = block.el.querySelector('.timeline-arrow');
  const parts = ensureTimelineParts(stack);
  const container = parts.children;
  const entries = block.entries || [];
  const existing = new Map();
  Array.from(container.children).forEach((row) => {
    if (row.dataset.stepId) existing.set(row.dataset.stepId, row);
  });

  const expanded = Boolean(block.expanded || (block.el && block.el.dataset.expanded === '1'));
  const visibleEntries = expanded ? entries : entries.slice(-ACTION_STEP_LIMIT);
  const visibleIds = new Set(visibleEntries.map((step) => step.id));

  let cursor = container.firstElementChild;
  visibleEntries.forEach((step) => {
    let row = existing.get(step.id);
    if (!row) {
      row = buildStepRow(step);
    } else {
      applyStepRowState(row, step);
      existing.delete(step.id);
    }
    if (row !== cursor) {
      container.insertBefore(row, cursor || null);
    } else {
      cursor = cursor ? cursor.nextElementSibling : null;
    }
    row.classList.remove('is-hidden');
  });
  existing.forEach((row) => {
    if (visibleIds.has(row.dataset.stepId)) return;
    row.remove();
  });

  const hiddenCount = entries.length - visibleEntries.length;
  let moreBtn = stack.querySelector('.action-more');
  if (hiddenCount > 0) {
    if (!moreBtn) {
      moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'action-more';
      container.parentNode.insertBefore(moreBtn, container.nextSibling);
      moreBtn.addEventListener('click', () => {
        block.expanded = !block.expanded;
        if (block.el) block.el.dataset.expanded = block.expanded ? '1' : '0';
        refreshTimelineBlock(block);
      });
    }
    const moreLabel = 'Hiện thêm ' + hiddenCount + ' bước trước đó';
    if (moreBtn.textContent !== moreLabel) moreBtn.textContent = moreLabel;
    moreBtn.classList.remove('is-hidden');
  } else if (moreBtn) {
    moreBtn.classList.add('is-hidden');
  }

  const open = block.collapsed === false || Boolean(block.running);
  block.collapsed = !open;
  stack.classList.toggle('is-open', open);
  if (arrow) arrow.innerHTML = chevronSvg(open);

  let pendingRow = null;
  entries.forEach((entry) => {
    if (entry.status === 'running') pendingRow = entry;
    if (entry.status === 'running' || Boolean(entry.open)) return;
    entry.open = false;
  });
  let pendingEl = stack.querySelector('.action-pending');
  if (pendingRow) {
    if (!pendingEl) {
      pendingEl = document.createElement('div');
      pendingEl.className = 'action-pending';
      stack.appendChild(pendingEl);
    }
    const label = (pendingRow.summary || 'Đang thực hiện').trim();
    const fileLabel = pendingRow.file ? ' → ' + pendingRow.file : '';
    const nextHtml = '<span class="shimmer action-pending-text">' + escapeHtml(label + fileLabel) + '</span>';
    if (pendingEl.dataset.label !== label + fileLabel) {
      pendingEl.dataset.label = label + fileLabel;
      pendingEl.innerHTML = nextHtml;
    }
    pendingEl.classList.remove('is-hidden');
  } else if (pendingEl) {
    pendingEl.classList.add('is-hidden');
  }

  if (summaryEl) {
    const text = buildSummaryText(entries, block.running);
    if (summaryEl.textContent !== text) summaryEl.textContent = text;
    if (block.running) summaryEl.classList.add('shimmer');
    else summaryEl.classList.remove('shimmer');
  }
  scrollToBottom();
}

function updateTimelineEntries(block, patch) {
  if (!block) return;
  if (!Array.isArray(block.entries)) block.entries = [];
  const list = block.entries;
  const index = list.findIndex((entry) => entry.id === patch.id);
  if (index === -1) list.push(patch);
  else Object.assign(list[index], patch);
}

function stepKindOf(name) {
  if (name === 'write_file') return 'created';
  if (name === 'edit_file') return 'edited';
  if (name === 'execute_command') return 'ran';
  if (name === 'read_file') return 'read';
  if (name === 'list_directory') return 'listed';
  if (name === 'delete_path') return 'deleted';
  return 'other';
}

function finishTimeline(turn) {
  const block = turn && turn.assistant ? turn.assistant.timeline : null;
  if (!block) return;
  block.running = false;
  (block.entries || []).forEach((entry) => {
    if (entry.status === 'running') {
      entry.status = 'success';
      entry.detail = entry.detail || { kind: 'log', resultPreview: entry.summary || '' };
    }
  });
  block.collapsed = true;
  if (block.el) block.el.dataset.expanded = '0';
  refreshTimelineBlock(block);
}

function handleSseEvent(turn, event, data) {
  const assistant = turn.assistant;
  if (!assistant) return;
  if (event === 'start') {
    assistant.model = data.model;
    if (data.workspaceRoot) {
      state.workspace.active = data.workspaceRoot;
      state.workspace.created = Boolean(data.workspaceCreated);
      state.workspace.activeAbsolute = data.workspaceRootAbsolute || '';
      applyWorkspaceBadge();
      refreshFileTree();
    }
    return;
  }
  if (event === 'step_start') {
    const block = getTurnTimeline(turn);
    if (!block) return;
    block.running = true;
    updateTimelineEntries(block, {
      id: data.id,
      index: data.index,
      name: data.name,
      kind: stepKindOf(data.name),
      summary: data.summary,
      file: data.file || '',
      fileIsCommand: data.name === 'execute_command',
      args: data.args || {},
      status: 'running',
      durationMs: 0,
      detail: null,
      open: false
    });
    refreshTimelineBlock(block);
    schedulePersistTurn(turn);
    return;
  }
  if (event === 'step_done') {
    const block = getTurnTimeline(turn);
    if (!block) return;
    updateTimelineEntries(block, {
      id: data.id,
      index: data.index,
      name: data.name,
      kind: stepKindOf(data.name),
      summary: data.summary,
      file: data.file || '',
      fileIsCommand: data.name === 'execute_command',
      status: data.status,
      durationMs: data.durationMs,
      detail: data.detail,
      args: data.args
    });
    refreshTimelineBlock(block);
    schedulePersistTurn(turn);
    return;
  }
  if (event === 'artifact_update') {
    const artifact = data.artifact || {};
    if (!Array.isArray(assistant.artifacts)) assistant.artifacts = [];
    const existingIndex = assistant.artifacts.findIndex((item) => item.filepath === artifact.filepath);
    const record = Object.assign({}, artifact, { action: data.action || 'created' });
    if (existingIndex === -1) assistant.artifacts.push(record);
    else assistant.artifacts[existingIndex] = record;
    renderTurnArtifacts(turn);
    applyArtifactToPanel(record);
    return;
  }
  if (event === 'presented_file') {
    const block = getTurnTimeline(turn);
    if (!block) return;
    assistant.presentedCount = (assistant.presentedCount || 0) + 1;
    updateTimelineEntries(block, {
      id: 'presented-' + assistant.presentedCount + '-' + data.filepath,
      index: (block.entries || []).length + 1,
      name: 'present',
      kind: 'presented',
      summary: 'Presented file ' + data.filepath,
      file: data.filepath,
      fileIsCommand: false,
      status: 'success',
      durationMs: 0,
      detail: { kind: 'log', resultPreview: 'File ' + data.filepath + ' (' + (data.kind || 'File') + ') đã sẵn sàng trong khung Artifact.' },
      open: false
    });
    refreshTimelineBlock(block);
    schedulePersistTurn(turn);
    return;
  }
  if (event === 'text_delta') {
    assistant.content = data.text || assistant.content || '';
    renderTurnBody(turn);
    schedulePersistTurn(turn);
    return;
  }
  if (event === 'final_reply') {
    assistant.content = data.content || assistant.content || '';
    assistant.model = data.model || assistant.model;
    finishTimeline(turn);
    renderTurnBody(turn);
    renderTurnArtifacts(turn);
    persistTurnMessage(turn);
    return;
  }
  if (event === 'error') {
    assistant.error = data.error || 'Request failed';
    assistant.streaming = false;
    finishTimeline(turn);
    renderTurnBody(turn);
    renderTurnError(turn, assistant.error);
    persistTurnMessage(turn);
    return;
  }
  if (event === 'done') {
    assistant.streaming = false;
    finishTimeline(turn);
    renderTurnBody(turn);
  }
}


const SSE_FRAME_SEPARATOR = String.fromCharCode(10, 10);

function serializeTimeline(block) {
  if (!block) return null;
  return {
    entries: (block.entries || []).map((entry) => ({
      id: entry.id,
      index: entry.index,
      name: entry.name,
      kind: entry.kind,
      summary: entry.summary,
      file: entry.file,
      fileIsCommand: entry.fileIsCommand,
      args: entry.args,
      status: entry.status,
      durationMs: entry.durationMs,
      detail: entry.detail,
      open: false
    })),
    running: Boolean(block.running),
    collapsed: Boolean(block.collapsed),
    expanded: Boolean(block.expanded),
    openIds: (block.entries || []).filter((entry) => entry.open).map((entry) => entry.id)
  };
}

let persistTimer = null;
let persistPendingTurn = null;

function schedulePersistTurn(turn) {
  if (!turn || !turn.el) return;
  persistPendingTurn = turn;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const target = persistPendingTurn;
    persistPendingTurn = null;
    if (target) persistTurnMessage(target);
  }, 350);
}

function persistTurnMessage(turn) {
  if (!turn || !turn.el) return;
  const chat = activeChat();
  if (!chat) return;
  const record = chat.messages.find((item) => item.id === turn.id);
  if (!record || !record.assistant) return;
  const assistant = turn.assistant || {};
  record.assistant.content = assistant.content || '';
  record.assistant.streaming = Boolean(assistant.streaming);
  record.assistant.error = assistant.error || null;
  record.assistant.model = assistant.model || record.assistant.model || null;
  record.assistant.artifacts = (assistant.artifacts || []).map((artifact) => ({
    filepath: artifact.filepath,
    filename: artifact.filename,
    ext: artifact.ext,
    kind: artifact.kind,
    action: artifact.action,
    size: artifact.size,
    sizeHuman: artifact.sizeHuman
  }));
  if (assistant.timeline && turn.el) {
    turn.el.querySelectorAll('.action-row').forEach((row) => {
      const entry = (assistant.timeline.entries || []).find((item) => item.id === row.dataset.stepId);
      if (entry) entry.open = row.classList.contains('is-open');
    });
  }
  record.assistant.timeline = serializeTimeline(assistant.timeline);
  chat.updatedAt = Date.now();
  persistChats();
}

function parseSseFrame(frame) {
  const lines = frame.split(String.fromCharCode(10));
  let event = 'message';
  let dataText = '';
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataText += line.slice(5).trim();
  }
  if (!dataText) return null;
  try {
    return { event: event, payload: JSON.parse(dataText) };
  } catch (err) {
    return null;
  }
}

function normalizeSseFrame(frame) {
  const rewritten = frame
    .split(String.fromCharCode(13, 10))
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(13))
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(10))
    .map((line) => {
      if (line.startsWith('data:')) return 'data:' + line.slice(5).trim();
      if (line.startsWith('event:')) return 'event:' + line.slice(6).trim();
      return line;
    })
    .join(String.fromCharCode(10));
  return rewritten;
}

async function streamChat(payload, turn) {
  const controller = new AbortController();
  state.abortController = controller;
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  if (!resp.ok) {
    let message = 'Request failed (' + resp.status + ')';
    try {
      const body = await resp.json();
      if (body && body.error) message = body.error;
    } catch (err) {
      /* non JSON error body */
    }
    turn.assistant.error = message;
    turn.assistant.streaming = false;
    renderTurnBody(turn);
    renderTurnError(turn, message);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    let idx = buffer.indexOf(SSE_FRAME_SEPARATOR);
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + SSE_FRAME_SEPARATOR.length);
      const parsed = parseSseFrame(normalizeSseFrame(frame));
      if (parsed && parsed.payload && parsed.payload.data) {
        handleSseEvent(turn, parsed.payload.event || parsed.event, parsed.payload.data);
      }
      idx = buffer.indexOf(SSE_FRAME_SEPARATOR);
    }
  }
  if (buffer.trim()) {
    const parsed = parseSseFrame(normalizeSseFrame(buffer));
    if (parsed && parsed.payload && parsed.payload.data) {
      handleSseEvent(turn, parsed.payload.event || parsed.event, parsed.payload.data);
    }
  }
}


function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
  } catch (err) {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettingsToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
}

function migrateLegacyStorage() {
  const pairs = [
    ['claudex_workspace_chats_v1', CHATS_KEY],
    ['claudex_workspace_settings_v1', STORAGE_KEY]
  ];
  pairs.forEach((pair) => {
    const legacyKey = pair[0];
    const targetKey = pair[1];
    try {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy && !localStorage.getItem(targetKey)) {
        localStorage.setItem(targetKey, legacy);
      }
    } catch (err) {
      /* storage unavailable */
    }
  });
}

function loadChats() {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) state.chats = parsed;
    }
  } catch (err) {
    state.chats = [];
  }
}

function persistChats() {
  try {
    const serializable = state.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages: chat.messages
    }));
    localStorage.setItem(CHATS_KEY, JSON.stringify(serializable));
  } catch (err) {
    console.warn('Unable to persist chats', err);
  }
}

function activeChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function createChat() {
  const chat = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  persistChats();
  renderChatList();
  renderMessages();
  return chat;
}

function ensureChat() {
  let chat = activeChat();
  if (!chat) chat = createChat();
  return chat;
}

function deleteChat(id) {
  state.chats = state.chats.filter((chat) => chat.id !== id);
  if (state.activeChatId === id) {
    state.activeChatId = state.chats.length ? state.chats[0].id : null;
  }
  if (!state.activeChatId) createChat();
  persistChats();
  renderChatList();
  renderMessages();
}

function renderChatList() {
  const list = el('chatList');
  list.innerHTML = '';
  for (const chat of state.chats) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (chat.id === state.activeChatId ? ' is-active' : '');
    const dot = document.createElement('span');
    dot.className = 'chat-item-dot';
    const label = document.createElement('span');
    label.className = 'chat-item-label';
    label.textContent = chat.title || 'New chat';
    const del = document.createElement('button');
    del.className = 'chat-item-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Xóa cuộc trò chuyện';
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(del);
    row.addEventListener('click', (ev) => {
      if (ev.target === del) return;
      state.activeChatId = chat.id;
      persistChats();
      renderChatList();
      renderMessages();
    });
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteChat(chat.id);
    });
    list.appendChild(row);
  }
}

function buildTurnFromRecord(record) {
  const turn = {
    id: record.id,
    user: record.user,
    assistant: record.assistant || { timeline: { entries: [], running: false, collapsed: true }, content: '', artifacts: [], streaming: false },
    el: null
  };
  return turn;
}

const RENDER_ERROR_BANNER_ID = 'renderErrorBanner';

function showRenderErrorBanner(message) {
  const existing = el(RENDER_ERROR_BANNER_ID);
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = RENDER_ERROR_BANNER_ID;
  banner.className = 'turn-error';
  banner.style.margin = '12px auto 0';
  banner.style.maxWidth = '760px';
  banner.textContent = 'Lỗi hiển thị tin nhắn: ' + message + ' — nhấn vào để tải lại trang.';
  banner.addEventListener('click', () => window.location.reload());
  const scroller = el('chatScroll');
  if (scroller) scroller.insertBefore(banner, scroller.firstChild);
}

function renderMessages() {
  const chat = activeChat();
  const welcome = el('welcome');
  const messages = el('messages');
  const title = el('chatTitle');
  messages.innerHTML = '';
  if (!chat || chat.messages.length === 0) {
    welcome.classList.remove('is-hidden');
    messages.classList.add('is-hidden');
    title.textContent = 'New chat';
    return;
  }
  welcome.classList.add('is-hidden');
  messages.classList.remove('is-hidden');
  title.textContent = chat.title || 'Chat';
  for (const record of chat.messages) {
    try {
      renderSingleRecord(messages, record);
    } catch (err) {
      console.error('[render message]', err);
      showRenderErrorBanner(errorMessage(err));
      const fallback = document.createElement('div');
      fallback.className = 'turn';
      const bubble = document.createElement('div');
      bubble.className = 'user-bubble';
      bubble.textContent = (record.user && record.user.content) || '';
      const body = document.createElement('div');
      body.className = 'md-body';
      body.textContent = (record.assistant && record.assistant.content) || '(không hiển thị được nội dung cũ)';
      fallback.appendChild(bubble);
      fallback.appendChild(body);
      messages.appendChild(fallback);
    }
  }
  scrollToBottom();
}

function renderSingleRecord(messages, record) {
  const turn = buildTurnFromRecord(record);
  normalizeRestoredTurn(turn);
  const node = buildTurnEl(turn);
  turn.el = node;
  if (turn.assistant.timeline) {
    const timelineEl = node.querySelector('.timeline');
    if (timelineEl) turn.assistant.timeline.el = timelineEl;
  }
  const bodyEl = node.querySelector('.md-body');
  if (bodyEl && turn.assistant.content) bodyEl.dataset.rendered = turn.assistant.content;
  messages.appendChild(node);
}

function scrollToBottom() {
  const scroller = el('chatScroll');
  if (!scroller) return;
  scroller.scrollTop = scroller.scrollHeight;
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 216) + 'px';
}

function renderAttachments() {
  const bar = el('attachmentBar');
  bar.innerHTML = '';
  if (!state.attachments.length) {
    bar.classList.add('is-hidden');
    return;
  }
  bar.classList.remove('is-hidden');
  state.attachments.forEach((attachment, idx) => {
    const chip = document.createElement('div');
    chip.className = 'attach-chip';
    const name = document.createElement('span');
    name.className = 'attach-chip-name';
    name.textContent = attachment.filepath;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attach-chip-remove';
    remove.textContent = '×';
    remove.title = 'Bỏ đính kèm';
    remove.addEventListener('click', () => {
      state.attachments.splice(idx, 1);
      renderAttachments();
    });
    chip.appendChild(name);
    chip.appendChild(remove);
    bar.appendChild(chip);
  });
}

async function sendMessage() {
  if (state.sending) return;
  const input = el('input');
  const text = input.value.trim();
  if (!text && state.attachments.length === 0 && !state.pendingSkill) return;
  const skillName = state.pendingSkill;
  const chat = ensureChat();
  let content = text;
  if (state.attachments.length) {
    const fence = String.fromCharCode(96, 96, 96);
    const newline = String.fromCharCode(10);
    const doubleNewline = String.fromCharCode(10, 10);
    const blocks = state.attachments.map((attachment) => 'Đính kèm: ' + attachment.filepath + newline + fence + newline + (attachment.content || '').slice(0, 20000) + newline + fence);
    content = (content ? content + doubleNewline : '') + blocks.join(doubleNewline);
  }
  input.value = '';
  autoResize(input);
  const attachments = state.attachments.map((attachment) => attachment.filepath);
  state.attachments = [];
  renderAttachments();

  if (skillName) {
    const header = '/skill ' + skillName;
    content = header + String.fromCharCode(10, 10) + (content || 'Hãy thực hiện công việc theo skill ' + skillName + '.');
  }
  state.pendingSkill = null;
  renderSkillChip();
  const record = {
    id: uid(),
    user: { role: 'user', content: content, attachments: attachments, skill: skillName || null },
    assistant: { timeline: { entries: [], running: true, collapsed: true }, content: '', artifacts: [], streaming: true, error: null }
  };
  chat.messages.push(record);
  const holder = el('messages');
  holder.classList.remove('is-hidden');
  el('welcome').classList.add('is-hidden');
  if (chat.title === 'New chat') {
    chat.title = (text || attachments[0] || 'New chat').slice(0, 48);
  }
  chat.updatedAt = Date.now();
  persistChats();
  renderChatList();
  renderMessages();

  const turn = { id: record.id, user: record.user, assistant: record.assistant, el: null };
  const nodes = el('messages').children;
  turn.el = nodes[nodes.length - 1] || null;
  if (!turn.el) return;
  turn.assistant.timeline = { entries: [], running: true, collapsed: true, expanded: false, openIds: [], el: null };
  getTurnTimeline(turn);

  const history = chat.messages
    .filter((item) => item.user && item.user.content)
    .map((item) => {
      const reply = (item.assistant && item.assistant.content) || '...';
      return [
        { role: 'user', content: item.user.content },
        { role: 'assistant', content: reply }
      ];
    })
    .reduce((acc, pair) => acc.concat(pair), []);
  if (history.length > 0 && history[history.length - 1].role === 'assistant') history.pop();
  history.push({ role: 'user', content: content });

  state.sending = true;
  el('sendBtn').classList.add('is-hidden');
  el('stopBtn').classList.remove('is-hidden');
  try {
    await streamChat({
      messages: history,
      config: {
        apiKey: state.settings.apiKey,
        baseURL: state.settings.baseURL,
        model: state.settings.model,
        systemPrompt: state.settings.systemPrompt,
        maxSteps: state.settings.maxSteps,
        password: state.settings.password,
        workspaceMode: state.workspace.mode,
        workspaceRoot: state.workspace.active || ''
      }
    }, turn);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      turn.assistant.error = 'Yêu cầu đã được dừng.';
      const stopped = getTurnTimeline(turn);
      if (stopped) {
        stopped.running = false;
        (stopped.entries || []).forEach((entry) => {
          if (entry.status === 'running') {
            entry.status = 'error';
            entry.detail = { kind: 'log', resultPreview: 'Bước này bị dừng trước khi hoàn tất', error: true };
          }
        });
        refreshTimelineBlock(stopped);
      }
      renderTurnError(turn, turn.assistant.error);
      renderTurnBody(turn);
    } else {
      turn.assistant.error = (err && err.message) || 'Lỗi kết nối';
      renderTurnError(turn, turn.assistant.error);
    }
  } finally {
    turn.assistant.streaming = false;
    state.sending = false;
    state.abortController = null;
    el('sendBtn').classList.remove('is-hidden');
    el('stopBtn').classList.add('is-hidden');
    persistChats();
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const payload = [];
  for (const file of files) {
    const base64Data = await readFileAsBase64(file);
    payload.push({ filepath: file.name, base64Data: base64Data });
  }
  try {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: payload, workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    const savedNames = (data.saved || []).map((item) => item.filepath);
    for (const name of savedNames) {
      try {
        const r = await fetch('/api/file?path=' + encodeURIComponent(name) + wsParam('&'));
        const info = await r.json();
        if (info.ok && !info.isDirectory) state.attachments.push({ filepath: name, content: info.content || '' });
      } catch (err) {
        /* ignore attachment read failure */
      }
    }
    renderAttachments();
    refreshFileTree();
  } catch (err) {
    window.alert('Upload thất bại: ' + err.message);
  }
}


async function refreshFileTree() {
  try {
    const resp = await fetch('/api/files?recursive=1' + wsParam('&'));
    const data = await resp.json();
    const container = el('fileTree');
    container.innerHTML = '';
    if (!data.ok) {
      container.innerHTML = '<div class="tree-error">' + escapeHtml(data.error || 'Không đọc được danh sách file') + '</div>';
      return;
    }
    state.serverFiles = data.entries || [];
    const root = data.tree;
    const rows = [];
    const walk = (node, depth) => {
      const children = (node.children || []).slice().sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'dir' ? -1 : 1;
      });
      for (const child of children) {
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (8 + depth * 14) + 'px';
        const name = document.createElement('span');
        name.className = 'tree-name ' + (child.type === 'dir' ? 'is-dir' : 'is-file');
        name.textContent = child.name;
        const actions = document.createElement('span');
        actions.className = 'tree-actions';
        if (child.type === 'file') {
          const download = document.createElement('button');
          download.type = 'button';
          download.className = 'tree-action';
          download.textContent = 'Tải';
          download.title = 'Tải file';
          download.addEventListener('click', (ev) => {
            ev.stopPropagation();
            window.open('/api/file?download=1&path=' + encodeURIComponent(child.path) + wsParam('&'), '_blank');
          });
          actions.appendChild(download);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'tree-action';
        remove.textContent = 'Xóa';
        remove.title = 'Xóa';
        remove.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!window.confirm('Xóa ' + child.path + '?')) return;
          await fetch('/api/file?path=' + encodeURIComponent(child.path) + wsParam('&'), { method: 'DELETE' });
          refreshFileTree();
        });
        actions.appendChild(remove);
        row.appendChild(name);
        row.appendChild(actions);
        row.querySelector('.tree-name').addEventListener('click', () => {
          if (child.type === 'dir') return;
          openFileInRight(child.path, 'code');
        });
        rows.push(row);
        if (child.type === 'dir') walk(child, depth + 1);
      }
    };
    walk(root, 0);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = 'Workspace trống.';
      container.appendChild(empty);
    } else {
      rows.forEach((row) => container.appendChild(row));
    }
  } catch (err) {
    console.warn('refreshFileTree failed', err);
  }
}

function previewModeFor(filepath, ext) {
  const lower = String(ext || '').toLowerCase();
  if (['html', 'htm', 'svg', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp'].includes(lower)) return 'preview';
  return 'code';
}

function openFileInRight(filepath, mode) {
  state.currentFile = filepath;
  switchTab(mode || 'preview');
  loadFileIntoPanels(filepath);
  openRightPanel();
}

function applyArtifactToPanel(artifact) {
  if (state.codeDirty) return;
  state.currentFile = artifact.filepath;
  state.currentFileContent = artifact.content || '';
  state.codeDirty = false;
  el('previewName').textContent = artifact.filepath;
  el('codeName').textContent = artifact.filepath;
  el('codeEditor').value = artifact.content || '';
  renderPreviewFor(artifact.filepath, artifact.ext || '', artifact.content || '');
  refreshFileTree();
}

function showPreviewIframe(show) {
  const frame = el('previewFrame');
  const empty = el('previewEmpty');
  if (!frame || !empty) return;
  if (show) {
    frame.classList.remove('is-hidden');
    empty.classList.add('is-hidden');
  } else {
    frame.classList.add('is-hidden');
    empty.classList.remove('is-hidden');
  }
}

function renderPreviewFor(filepath, ext, content) {
  const lower = String(ext || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'].includes(lower)) {
    showPreviewIframe(true);
    el('previewFrame').srcdoc = '<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#191918"><img src="/api/file?raw=1&amp;path=' + encodeURIComponent(filepath) + '&amp;t=' + Date.now() + wsParam('&amp;').replace(/&/g, '&amp;') + '" style="max-width:100%;max-height:100%" /></body></html>';
    return;
  }
  if (lower === 'md') {
    showPreviewIframe(true);
    el('previewFrame').srcdoc = '<html><head><meta charset="utf-8"><style>body{margin:0;background:#191918;color:#ECECEC;font-family:Inter,Georgia,serif;padding:32px;line-height:1.7;font-size:16px}pre{background:#0D0D0C;padding:14px;border-radius:8px;overflow:auto;border:1px solid #2A2927}code{font-family:"JetBrains Mono",monospace;font-size:13px}a{color:#D97757}h1,h2,h3{font-family:Inter,sans-serif}blockquote{border-left:3px solid #2A2927;margin-left:0;padding-left:16px;color:#B5B3AD}table{border-collapse:collapse}td,th{border:1px solid #2A2927;padding:6px 10px}</style></head><body>' + styledMarkdown(content) + '</body></html>';
    return;
  }
  if (lower === 'html' || lower === 'htm' || lower === 'svg') {
    showPreviewIframe(true);
    el('previewFrame').srcdoc = content || '';
    return;
  }
  if (!content) {
    showPreviewIframe(false);
    return;
  }
  showPreviewIframe(true);
  el('previewFrame').srcdoc = '<html><head><meta charset="utf-8"><style>body{margin:0;background:#0D0D0C;color:#B5B3AD;font-family:"JetBrains Mono",monospace;font-size:12.5px;padding:16px;white-space:pre-wrap;line-height:1.65}</style></head><body>' + escapeHtml(content.slice(0, 100000)) + '</body></html>';
}

async function loadFileIntoPanels(filepath) {
  try {
    const resp = await fetch('/api/file?path=' + encodeURIComponent(filepath) + wsParam('&'));
    const data = await resp.json();
    if (!data.ok || data.isDirectory) {
      showPreviewIframe(false);
      el('previewName').textContent = filepath;
      el('codeName').textContent = filepath;
      el('codeEditor').value = '';
      return;
    }
    state.currentFile = filepath;
    state.currentFileContent = data.binary ? '' : (data.content || '');
    state.codeDirty = false;
    el('codeName').textContent = filepath;
    el('codeEditor').value = data.binary ? '' : (data.content || '');
    el('codeEditor').readOnly = Boolean(data.binary);
    el('previewName').textContent = filepath + (data.kind ? ' · ' + data.kind : '');
    if (data.binary) {
      showPreviewIframe(false);
      el('previewFrame').srcdoc = '';
      return;
    }
    renderPreviewFor(filepath, data.ext || '', data.content || '');
  } catch (err) {
    el('codeName').textContent = 'Lỗi đọc file';
  }
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.right-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  ['preview', 'code', 'files', 'terminal'].forEach((name) => {
    const pane = el('pane' + name.charAt(0).toUpperCase() + name.slice(1));
    if (!pane) return;
    if (name === tab) pane.classList.remove('is-hidden');
    else pane.classList.add('is-hidden');
  });
  if (tab === 'files') refreshFileTree();
  if (tab === 'preview') {
    if (state.currentFile) loadFileIntoPanels(state.currentFile);
    else showPreviewIframe(false);
  }
  if (tab === 'terminal') el('terminalInput').focus();
}

function openRightPanel() {
  state.rightOpen = true;
  el('rightPanel').classList.remove('is-hidden');
}

function closeRightPanel() {
  state.rightOpen = false;
  el('rightPanel').classList.add('is-hidden');
}

async function saveCurrentFile() {
  if (!state.currentFile) return;
  const content = el('codeEditor').value;
  try {
    const resp = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: state.currentFile, content: content, workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Save failed');
    state.currentFileContent = content;
    state.codeDirty = false;
    el('codeName').textContent = state.currentFile + ' · đã lưu';
    renderPreviewFor(state.currentFile, (state.currentFile.split('.').pop() || ''), content);
    setTimeout(() => {
      el('codeName').textContent = state.currentFile;
    }, 1600);
    refreshFileTree();
  } catch (err) {
    window.alert('Lưu thất bại: ' + err.message);
  }
}

async function runTerminal(command) {
  const out = el('terminalOut');
  const line = document.createElement('div');
  line.className = 'term-line';
  const prompt = document.createElement('span');
  prompt.className = 'term-prompt';
  prompt.textContent = '$';
  line.appendChild(prompt);
  line.appendChild(document.createTextNode(' ' + command));
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  try {
    const resp = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: command, workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (data.stdout) {
      const pre = document.createElement('pre');
      pre.className = 'term-out';
      pre.textContent = data.stdout;
      out.appendChild(pre);
    }
    if (data.stderr) {
      const pre = document.createElement('pre');
      pre.className = 'term-out is-error';
      pre.textContent = data.stderr;
      out.appendChild(pre);
    }
    const meta = document.createElement('div');
    meta.className = 'term-meta';
    meta.textContent = 'exit ' + (data.exitCode != null ? data.exitCode : '?') + ' · ' + (data.durationMs || 0) + 'ms';
    out.appendChild(meta);
  } catch (err) {
    const pre = document.createElement('pre');
    pre.className = 'term-out is-error';
    pre.textContent = err.message;
    out.appendChild(pre);
  }
  out.scrollTop = out.scrollHeight;
}

function openSettings() {
  el('setApiKey').value = state.settings.apiKey || '';
  el('setBaseURL').value = state.settings.baseURL || '';
  el('setModel').value = state.settings.model || '';
  el('setSystemPrompt').value = state.settings.systemPrompt || '';
  el('setMaxSteps').value = state.settings.maxSteps || 12;
  el('setPassword').value = state.settings.password || '';
  el('settingsModal').classList.remove('is-hidden');
}

function closeSettingsModal() {
  el('settingsModal').classList.add('is-hidden');
}

function saveSettings() {
  state.settings.apiKey = el('setApiKey').value.trim();
  state.settings.baseURL = el('setBaseURL').value.trim();
  state.settings.model = el('setModel').value.trim();
  state.settings.systemPrompt = el('setSystemPrompt').value;
  const steps = parseInt(el('setMaxSteps').value, 10);
  state.settings.maxSteps = Number.isFinite(steps) && steps > 0 ? Math.min(steps, 40) : 12;
  state.settings.password = el('setPassword').value;
  saveSettingsToStorage();
  setModelBadge();
  closeSettingsModal();
}

async function fetchStats() {
  try {
    const resp = await fetch('/api/stats');
    const data = await resp.json();
    if (!data.ok) return;
    const percent = data.system.memPercent;
    el('statRam').textContent = percent + '% · ' + data.process.rssHuman;
    el('ramBar').style.width = Math.min(percent, 100) + '%';
    el('statDisk').textContent = (data.disk.used || '-') + ' / ' + (data.disk.size || '-');
    el('statUptime').textContent = data.uptime.processHuman;
  } catch (err) {
    /* stats are informational only */
  }
}

function setModelBadge() {
  const model = state.settings.model || 'mặc định';
  el('modelBadge').textContent = model.length > 30 ? model.slice(0, 30) + '…' : model;
}

async function openServerFileModal() {
  el('serverFileModal').classList.remove('is-hidden');
  el('serverFileSearch').value = '';
  await renderServerFileList('');
  el('serverFileSearch').focus();
}

async function renderServerFileList(filter) {
  if (!state.serverFiles.length) {
    try {
      const resp = await fetch('/api/files?recursive=1');
      const data = await resp.json();
      if (data.ok) state.serverFiles = data.entries || [];
    } catch (err) {
      /* ignore */
    }
  }
  const list = el('serverFileList');
  list.innerHTML = '';
  const lower = String(filter || '').toLowerCase();
  const items = state.serverFiles.filter((entry) => entry.type === 'file' && (!lower || entry.path.toLowerCase().includes(lower)));
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = 'Không có file phù hợp.';
    list.appendChild(empty);
    return;
  }
  items.slice(0, 400).forEach((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'server-file-row';
    const name = document.createElement('span');
    name.className = 'server-file-name';
    name.textContent = item.path;
    const size = document.createElement('span');
    size.className = 'server-file-size';
    size.textContent = item.sizeHuman || '';
    row.appendChild(name);
    row.appendChild(size);
    row.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/file?path=' + encodeURIComponent(item.path) + wsParam('&'));
        const data = await resp.json();
        if (data.ok && !data.isDirectory) {
          state.attachments.push({ filepath: item.path, content: data.content || '' });
          renderAttachments();
          el('serverFileModal').classList.add('is-hidden');
          el('input').focus();
        }
      } catch (err) {
        /* ignore */
      }
    });
    list.appendChild(row);
  });
}


function resumeInterruptedChats() {
  let changed = false;
  state.chats.forEach((chat) => {
    (chat.messages || []).forEach((record) => {
      const assistant = record.assistant;
      if (!assistant) return;
      if (assistant.streaming) {
        assistant.streaming = false;
        changed = true;
      }
      const timeline = assistant.timeline;
      if (timeline && Array.isArray(timeline.entries) && timeline.entries.length === 0) {
        assistant.timeline = null;
        changed = true;
      }
      if (timeline && Array.isArray(timeline.entries)) {
        if (timeline.running) {
          timeline.running = false;
          changed = true;
        }
        timeline.collapsed = true;
        timeline.entries.forEach((entry) => {
          if (entry.status === 'running') {
            entry.status = 'error';
            entry.durationMs = entry.durationMs || 0;
            entry.detail = { kind: 'log', resultPreview: 'Phiên trước đã bị ngắt trước khi bước này hoàn tất', error: true };
            changed = true;
          }
        });
      }
    });
  });
  if (changed) persistChats();
}

function normalizeRestoredTurn(turn) {
  const assistant = turn.assistant;
  if (!assistant) return;
  const timeline = assistant.timeline;
  if (timeline && (!Array.isArray(timeline.entries) || timeline.entries.length === 0)) {
    assistant.timeline = null;
  }
}


function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  const sidebar = el('sidebar');
  const labels = sidebar.querySelectorAll('.sidebar-label');
  if (state.sidebarOpen) {
    sidebar.classList.remove('is-collapsed');
    labels.forEach((node) => node.classList.remove('is-hidden'));
  } else {
    sidebar.classList.add('is-collapsed');
    labels.forEach((node) => node.classList.add('is-hidden'));
  }
}

function bindEvents() {
  el('toggleSidebar').addEventListener('click', toggleSidebar);
  el('newChatBtn').addEventListener('click', () => {
    createChat();
    el('input').focus();
  });
  el('skillsBtn').addEventListener('click', openSkillsModal);
  el('skillsClose').addEventListener('click', closeSkillsModal);
  el('skillNewBtn').addEventListener('click', resetSkillForm);
  el('skillSaveBtn').addEventListener('click', saveSkillForm);
  el('skillDeleteBtn').addEventListener('click', deleteSkillForm);
  el('skillsModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'skillsModal') closeSkillsModal();
  });
  el('agentsBtn').addEventListener('click', openAgentsModal);
  el('agentsClose').addEventListener('click', closeAgentsModal);
  el('agentsCancel').addEventListener('click', closeAgentsModal);
  el('agentsSave').addEventListener('click', saveAgentsModal);
  el('agentsCreateBtn').addEventListener('click', createAgentsTemplate);
  el('agentsModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'agentsModal') closeAgentsModal();
  });
  el('wsBtn').addEventListener('click', openWorkspaceModal);
  el('wsClose').addEventListener('click', closeWorkspaceModal);
  el('wsCancel').addEventListener('click', closeWorkspaceModal);
  el('wsApply').addEventListener('click', applyWorkspaceModal);
  el('wsCreateBtn').addEventListener('click', createWorkspaceFromModal);
  el('wsSelect').addEventListener('change', (ev) => {
    if (ev.target.value) el('wsNameInput').value = ev.target.value;
  });
  document.querySelectorAll('.ws-option').forEach((btn) => {
    btn.addEventListener('click', () => selectWorkspaceMode(btn.dataset.mode));
  });
  el('wsModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'wsModal') closeWorkspaceModal();
  });
  el('settingsBtn').addEventListener('click', openSettings);
  el('closeSettings').addEventListener('click', closeSettingsModal);
  el('cancelSettings').addEventListener('click', closeSettingsModal);
  el('saveSettings').addEventListener('click', saveSettings);
  el('settingsModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'settingsModal') closeSettingsModal();
  });
  el('sendBtn').addEventListener('click', () => {
    sendMessage();
  });
  el('stopBtn').addEventListener('click', () => {
    if (state.abortController) state.abortController.abort();
  });
  el('input').addEventListener('input', (ev) => {
    autoResize(ev.target);
    refreshSlashMenu();
  });
  el('input').addEventListener('blur', () => {
    setTimeout(hideSlashMenu, 120);
  });
  el('input').addEventListener('keydown', (ev) => {
    const menu = el('slashMenu');
    const menuOpen = menu && !menu.classList.contains('is-hidden');
    if (menuOpen && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      const total = state.skillMenuItems.length;
      if (total > 0) {
        state.skillMenuIndex = (state.skillMenuIndex + (ev.key === 'ArrowDown' ? 1 : total - 1)) % total;
        showSlashMenu(slashQuery() ? slashQuery().query : '');
      }
      return;
    }
    if (menuOpen && (ev.key === 'Enter' || ev.key === 'Tab') && state.skillMenuItems.length > 0) {
      ev.preventDefault();
      applySlashSkill(state.skillMenuIndex);
      return;
    }
    if (menuOpen && ev.key === 'Escape') {
      ev.preventDefault();
      hideSlashMenu();
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  });
  document.querySelectorAll('.quick-prompt').forEach((btn) => {
    btn.addEventListener('click', () => {
      el('input').value = btn.dataset.prompt || '';
      autoResize(el('input'));
      sendMessage();
    });
  });
  el('attachBtn').addEventListener('click', () => el('fileInput').click());
  el('fileInput').addEventListener('change', (ev) => {
    uploadFiles(ev.target.files);
    ev.target.value = '';
  });
  el('serverAttachBtn').addEventListener('click', openServerFileModal);
  el('closeServerFile').addEventListener('click', () => el('serverFileModal').classList.add('is-hidden'));
  el('serverFileModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'serverFileModal') el('serverFileModal').classList.add('is-hidden');
  });
  el('serverFileSearch').addEventListener('input', (ev) => renderServerFileList(ev.target.value));
  el('openRightBtn').addEventListener('click', () => {
    if (state.rightOpen) closeRightPanel();
    else openRightPanel();
  });
  el('closeRightBtn').addEventListener('click', closeRightPanel);
  document.querySelectorAll('.right-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  el('previewRefresh').addEventListener('click', () => {
    if (state.currentFile) loadFileIntoPanels(state.currentFile);
  });
  el('previewOpen').addEventListener('click', () => {
    if (state.currentFile) window.open('/api/file?raw=1&path=' + encodeURIComponent(state.currentFile) + wsParam('&'), '_blank');
  });
  el('codeSave').addEventListener('click', saveCurrentFile);
  el('codeCopy').addEventListener('click', () => {
    const value = el('codeEditor').value || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value);
    }
  });
  el('codeDownload').addEventListener('click', () => {
    if (!state.currentFile) return;
    window.open('/api/file?download=1&path=' + encodeURIComponent(state.currentFile) + wsParam('&'), '_blank');
  });
  el('codeEditor').addEventListener('input', () => {
    state.codeDirty = true;
    el('codeName').textContent = (state.currentFile || '') + ' *';
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      if (!el('paneCode').classList.contains('is-hidden')) {
        ev.preventDefault();
        saveCurrentFile();
      }
    }
  });
  el('refreshFilesBtn').addEventListener('click', refreshFileTree);
  el('uploadFilesBtn').addEventListener('click', () => el('uploadFileInput').click());
  el('uploadFileInput').addEventListener('change', (ev) => {
    uploadFiles(ev.target.files);
    ev.target.value = '';
  });
  el('newFileBtn').addEventListener('click', async () => {
    const target = window.prompt('Đường dẫn file mới (tương đối trong workspace):');
    if (!target) return;
    const resp = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, content: '', workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (!data.ok) {
      window.alert(data.error || 'Tạo file thất bại');
      return;
    }
    await refreshFileTree();
    openFileInRight(target, 'code');
  });
  el('newDirBtn').addEventListener('click', async () => {
    const target = window.prompt('Đường dẫn thư mục mới (tương đối trong workspace):');
    if (!target) return;
    const resp = await fetch('/api/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, type: 'dir', workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (!data.ok) {
      window.alert(data.error || 'Tạo thư mục thất bại');
      return;
    }
    refreshFileTree();
  });
  const filesPane = el('paneFiles');
  filesPane.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    filesPane.classList.add('dragover');
  });
  filesPane.addEventListener('dragleave', () => filesPane.classList.remove('dragover'));
  filesPane.addEventListener('drop', (ev) => {
    ev.preventDefault();
    filesPane.classList.remove('dragover');
    if (ev.dataTransfer && ev.dataTransfer.files) uploadFiles(ev.dataTransfer.files);
  });
  const composer = el('composer');
  composer.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    composer.classList.add('dragover');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', (ev) => {
    ev.preventDefault();
    composer.classList.remove('dragover');
    if (ev.dataTransfer && ev.dataTransfer.files) uploadFiles(ev.dataTransfer.files);
  });
  el('terminalInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const command = ev.target.value.trim();
      if (!command) return;
      ev.target.value = '';
      runTerminal(command);
    }
  });
  el('terminalClear').addEventListener('click', () => {
    el('terminalOut').innerHTML = '';
  });
}

function renderSkillChip() {
  const bar = el('skillChipBar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!state.pendingSkill) {
    bar.classList.add('is-hidden');
    return;
  }
  bar.classList.remove('is-hidden');
  const chip = document.createElement('div');
  chip.className = 'attach-chip skill-chip';
  const name = document.createElement('span');
  name.className = 'attach-chip-name';
  name.textContent = 'Skill: /' + state.pendingSkill;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'attach-chip-remove';
  remove.textContent = '×';
  remove.title = 'Bỏ skill khỏi tin nhắn';
  remove.addEventListener('click', () => {
    state.pendingSkill = null;
    renderSkillChip();
  });
  chip.appendChild(name);
  chip.appendChild(remove);
  bar.appendChild(chip);
}

function hideSlashMenu() {
  const menu = el('slashMenu');
  if (menu) menu.classList.add('is-hidden');
  state.skillMenuItems = [];
  state.skillMenuIndex = 0;
}

function slashQuery() {
  const input = el('input');
  const value = input.value;
  const pos = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
  const before = value.slice(0, pos);
  const slashIndex = before.lastIndexOf(String.fromCharCode(47));
  if (slashIndex === -1) return null;
  const prefix = slashIndex === 0 ? ' ' : before.charAt(slashIndex - 1);
  if (prefix !== ' ' && prefix !== String.fromCharCode(9) && prefix !== String.fromCharCode(10) && prefix !== String.fromCharCode(13)) return null;
  const token = before.slice(slashIndex + 1);
  if (!/^[a-zA-Z0-9_-]*$/.test(token)) return null;
  return { start: slashIndex, query: token.toLowerCase(), end: pos };
}

function showSlashMenu(query) {
  const menu = el('slashMenu');
  const list = el('slashMenuList');
  if (!menu || !list) return;
  const items = (state.skills || []).filter((skill) => {
    if (!query) return true;
    return skill.name.includes(query) || String(skill.title || '').toLowerCase().includes(query);
  });
  state.skillMenuItems = items;
  if (state.skillMenuIndex >= items.length) state.skillMenuIndex = 0;
  list.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = state.skills.length ? 'Không có skill khớp "' + query + '"' : 'Chưa có skill nào. Mở Skills để thêm.';
    list.appendChild(empty);
    menu.classList.remove('is-hidden');
    return;
  }
  items.forEach((skill, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slash-item' + (index === state.skillMenuIndex ? ' is-active' : '');
    const name = document.createElement('span');
    name.className = 'slash-item-name';
    name.textContent = '/' + skill.name;
    const desc = document.createElement('span');
    desc.className = 'slash-item-desc';
    desc.textContent = skill.description || skill.title || '';
    row.appendChild(name);
    row.appendChild(desc);
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      applySlashSkill(index);
    });
    list.appendChild(row);
  });
  menu.classList.remove('is-hidden');
}

function refreshSlashMenu() {
  const query = slashQuery();
  if (!query) {
    hideSlashMenu();
    return;
  }
  showSlashMenu(query.query);
}

function applySlashSkill(index) {
  const skill = state.skillMenuItems[index];
  if (!skill) return;
  const input = el('input');
  const query = slashQuery();
  if (query) {
    input.value = input.value.slice(0, query.start) + input.value.slice(query.end);
  }
  state.pendingSkill = skill.name;
  renderSkillChip();
  hideSlashMenu();
  input.focus();
  autoResize(input);
}

async function loadSkills() {
  try {
    const resp = await fetch('/api/skills');
    const data = await resp.json();
    if (data.ok) state.skills = data.skills || [];
  } catch (err) {
    state.skills = state.skills || [];
  }
  return state.skills;
}

function openSkillsModal() {
  el('skillsModal').classList.remove('is-hidden');
  el('skillHint').textContent = '';
  el('skillHint').classList.remove('is-error');
  loadSkills().then(() => renderSkillList());
}

function closeSkillsModal() {
  el('skillsModal').classList.add('is-hidden');
}

function renderSkillList() {
  const list = el('skillList');
  list.innerHTML = '';
  if (!state.skills.length) {
    const empty = document.createElement('div');
    empty.className = 'slash-empty';
    empty.textContent = 'Chưa có skill. Bấm "Thêm skill" để tạo.';
    list.appendChild(empty);
    return;
  }
  state.skills.forEach((skill) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'skill-row' + (skill.name === el('skillName').value.trim() ? ' is-active' : '');
    const name = document.createElement('span');
    name.className = 'skill-row-name';
    name.textContent = '/' + skill.name;
    const desc = document.createElement('span');
    desc.className = 'skill-row-desc';
    desc.textContent = skill.description || skill.title || '';
    row.appendChild(name);
    row.appendChild(desc);
    row.addEventListener('click', () => selectSkillForEdit(skill.name));
    list.appendChild(row);
  });
}

async function selectSkillForEdit(name) {
  try {
    const resp = await fetch('/api/skills/' + encodeURIComponent(name));
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Không tải được skill');
    el('skillName').value = data.name;
    el('skillTitle').value = data.title || '';
    el('skillDesc').value = data.description || '';
    el('skillContent').value = data.content || '';
    el('skillHint').textContent = 'Đang sửa skill: ' + data.name;
    el('skillHint').classList.remove('is-error');
    renderSkillList();
  } catch (err) {
    el('skillHint').textContent = err.message;
    el('skillHint').classList.add('is-error');
  }
}

function resetSkillForm() {
  el('skillName').value = '';
  el('skillTitle').value = '';
  el('skillDesc').value = '';
  el('skillContent').value = '';
  el('skillHint').textContent = 'Tạo skill mới.';
  el('skillHint').classList.remove('is-error');
  renderSkillList();
  el('skillName').focus();
}

async function saveSkillForm() {
  const payload = {
    name: el('skillName').value.trim(),
    title: el('skillTitle').value.trim(),
    description: el('skillDesc').value.trim(),
    content: el('skillContent').value,
    overwrite: true
  };
  if (!payload.name || !payload.content.trim()) {
    el('skillHint').textContent = 'Cần tên skill và nội dung SKILL.md.';
    el('skillHint').classList.add('is-error');
    return;
  }
  try {
    const resp = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Lưu skill thất bại');
    el('skillHint').textContent = 'Đã lưu: skills/' + data.name + '/SKILL.md';
    el('skillHint').classList.remove('is-error');
    await loadSkills();
    renderSkillList();
  } catch (err) {
    el('skillHint').textContent = err.message;
    el('skillHint').classList.add('is-error');
  }
}

async function deleteSkillForm() {
  const name = el('skillName').value.trim();
  if (!name) return;
  if (!window.confirm('Xóa skill /' + name + '?')) return;
  try {
    const resp = await fetch('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Xóa thất bại');
    resetSkillForm();
    await loadSkills();
    renderSkillList();
    el('skillHint').textContent = 'Đã xóa skill ' + name;
  } catch (err) {
    el('skillHint').textContent = err.message;
    el('skillHint').classList.add('is-error');
  }
}

async function openAgentsModal() {
  el('agentsModal').classList.remove('is-hidden');
  const meta = el('agentsMeta');
  meta.textContent = 'Đang tải...';
  try {
    const resp = await fetch('/api/agents' + wsParam('?'));
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Không đọc được AGENTS.md');
    el('agentsContent').value = data.content || '';
    meta.textContent = 'Workspace: ' + data.workspace + (data.exists ? ' · đã có AGENTS.md' : ' · chưa có AGENTS.md');
  } catch (err) {
    meta.textContent = err.message;
  }
}

function closeAgentsModal() {
  el('agentsModal').classList.add('is-hidden');
}

async function saveAgentsModal() {
  const content = el('agentsContent').value;
  try {
    const resp = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Lưu thất bại');
    el('agentsMeta').textContent = 'Đã lưu AGENTS.md cho workspace ' + (state.workspace.active || 'gốc');
    refreshFileTree();
  } catch (err) {
    el('agentsMeta').textContent = err.message;
  }
}

async function createAgentsTemplate() {
  try {
    const resp = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', overwrite: true, workspaceRoot: state.workspace.active || '' })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Tạo mẫu thất bại');
    await openAgentsModal();
    el('agentsMeta').textContent = 'Đã tạo AGENTS.md mẫu cho workspace ' + (state.workspace.active || 'gốc');
    refreshFileTree();
  } catch (err) {
    el('agentsMeta').textContent = err.message;
  }
}

function openWorkspaceModal() {
  const modal = el('wsModal');
  const current = state.workspace || { mode: 'auto' };
  modal.classList.remove('is-hidden');
  selectWorkspaceMode(current.mode || 'auto');
  el('wsNameInput').value = current.active && current.active !== '.' ? current.active : '';
  loadWorkspaceOptions();
}

function closeWorkspaceModal() {
  el('wsModal').classList.add('is-hidden');
}

function selectWorkspaceMode(mode) {
  const normalized = ['auto', 'picker', 'root'].includes(mode) ? mode : 'auto';
  document.querySelectorAll('.ws-option').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === normalized);
  });
  const picker = el('wsPickerBox');
  const warning = el('wsRootWarning');
  if (normalized === 'picker') picker.classList.remove('is-hidden');
  else picker.classList.add('is-hidden');
  if (normalized === 'root') warning.classList.remove('is-hidden');
  else warning.classList.add('is-hidden');
  el('wsModal').dataset.mode = normalized;
  const hint = el('wsPickerHint');
  hint.classList.remove('is-error');
  if (normalized === 'auto') hint.textContent = 'Thư mục mới sẽ được tạo tự động (workspace-YYYY-MM-DD) nếu chưa có.';
  else if (normalized === 'picker') hint.textContent = 'Chọn một thư mục bên dưới hoặc gõ tên mới rồi bấm Tạo thư mục.';
  else hint.textContent = '';
}

async function loadWorkspaceOptions() {
  const select = el('wsSelect');
  select.innerHTML = '';
  const rootOption = document.createElement('option');
  rootOption.value = '';
  rootOption.textContent = '(thư mục gốc)';
  select.appendChild(rootOption);
  try {
    const resp = await fetch('/api/workspaces');
    const data = await resp.json();
    if (data.ok && Array.isArray(data.workspaces)) {
      state.serverFiles = state.serverFiles || [];
      data.workspaces.forEach((workspace) => {
        const option = document.createElement('option');
        option.value = workspace.path;
        option.textContent = workspace.path;
        select.appendChild(option);
      });
      if (!select.value && state.workspace.active) select.value = state.workspace.active;
    }
  } catch (err) {
    /* workspace list is best effort */
  }
}

function applyWorkspaceModal() {
  const modal = el('wsModal');
  const mode = modal.dataset.mode || 'auto';
  const typed = el('wsNameInput').value.trim();
  if (mode === 'picker' && !typed) {
    const hint = el('wsPickerHint');
    hint.textContent = 'Hãy chọn hoặc nhập một thư mục cho chế độ này, hoặc chuyển sang Auto workspace.';
    hint.classList.add('is-error');
    return;
  }
  if (mode === 'root') {
    const ok = window.confirm('Chuyển sang chế độ KHÔNG WORKSPACE? Agent sẽ đọc/ghi trực tiếp trong thư mục gốc của ứng dụng (server.js, package.json, .env). Hãy sao lưu trước khi tiếp tục.');
    if (!ok) return;
  }
  state.workspace = {
    mode: mode,
    root: mode === 'root' ? '' : typed,
    label: '',
    active: mode === 'root' ? '' : typed,
    created: false
  };
  applyWorkspaceBadge();
  closeWorkspaceModal();
  refreshFileTree();
  if (mode !== 'root') {
    setTimeout(() => {
      if (!state.workspace.created) applyWorkspaceBadge();
    }, 0);
  }
}

async function createWorkspaceFromModal() {
  const name = el('wsNameInput').value.trim();
  const hint = el('wsPickerHint');
  hint.classList.remove('is-error');
  if (!name) {
    hint.textContent = 'Nhập tên thư mục trước khi tạo.';
    hint.classList.add('is-error');
    return;
  }
  try {
    const resp = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || 'Không tạo được thư mục');
    hint.textContent = data.existed ? 'Thư mục đã có sẵn, dùng lại: ' + data.workspace : 'Đã tạo: ' + data.workspace;
    el('wsNameInput').value = data.workspace;
    await loadWorkspaceOptions();
    el('wsSelect').value = data.workspace;
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('is-error');
  }
}

async function init() {
  migrateLegacyStorage();
  loadSettings();
  loadChats();
  resumeInterruptedChats();
  if (!state.chats.length) createChat();
  else if (!state.activeChatId) state.activeChatId = state.chats[0].id;
  try {
    renderChatList();
  } catch (err) {
    console.error('[chat list]', err);
  }
  try {
    renderMessages();
  } catch (err) {
    console.error('[messages]', err);
    el('welcome').classList.remove('is-hidden');
    el('messages').classList.add('is-hidden');
  }
  setModelBadge();
  applyWorkspaceBadge();
  bindEvents();
  loadSkills();
  window.__claudexReady = true;
  fetchStats();
  setInterval(fetchStats, 10000);
  refreshFileTree();
  el('input').focus();
  window.addEventListener('pageshow', () => {
    if (!activeChat() || activeChat().messages.length === 0) {
      el('welcome').classList.remove('is-hidden');
      el('messages').classList.add('is-hidden');
    }
  });
}

function bootFallback() {
  if (window.__claudexReady) return;
  try {
    init();
  } catch (err) {
    console.error('[boot]', err);
    const target = document.getElementById('welcome');
    if (target) target.classList.remove('is-hidden');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFallback);
} else {
  setTimeout(bootFallback, 0);
}
setTimeout(bootFallback, 4000);



</script>
</body>
</html>`;

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && err.statusCode ? err.statusCode : (err && err.type === 'entity.too.large' ? 413 : 500);
  res.status(status).json({ ok: false, error: errorMessage(err) });
});

app.listen(PORT, HOST, () => {
  const mem = process.memoryUsage();
  console.log('==============================================');
  console.log(' Claudex Agentic Workspace is running');
  console.log(' URL         : http://' + HOST + ':' + PORT);
  console.log(' Workspace   : ' + DEFAULT_WORKSPACE_ROOT);
  console.log(' Node        : ' + process.version);
  console.log(' RSS         : ' + formatSize(mem.rss));
  console.log(' Chat API    : POST /api/chat (SSE streaming)');
  console.log('==============================================');
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
