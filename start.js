import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const START_FILE = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(START_FILE);

const DEFAULT_PRESERVE = ['.env', '.agent', 'node_modules', 'skills'];
const PROTECTED_FROM_RESET = DEFAULT_PRESERVE.slice();

function parseEnvFile(content) {
  const values = {};
  String(content || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  });
  return values;
}

function loadEnvFile() {
  const envPath = path.join(APP_DIR, '.env');
  if (!fs.existsSync(envPath)) return {};
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    process.stdout.write('[' + new Date().toISOString() + '] [warn] cannot read .env: ' + err.message + '\n');
    return {};
  }
  const values = parseEnvFile(content);
  for (const key of Object.keys(values)) {
    const current = process.env[key];
    if (current === undefined || current === '') process.env[key] = values[key];
  }
  return values;
}

function buildConfig() {
  const preserve = String(process.env.PRESERVE_PATHS || '.env,.agent,node_modules,skills')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return {
    repoUrl: String(process.env.GIT_REPO_URL || 'https://github.com/Exotic08/testt.git').trim(),
    branch: String(process.env.GIT_BRANCH || 'main').trim(),
    autoUpdate: String(process.env.AUTO_UPDATE || '1').trim() !== '0',
    remote: String(process.env.GIT_REMOTE || 'origin').trim(),
    entry: String(process.env.START_ENTRY || 'server.js').trim(),
    install: String(process.env.NPM_INSTALL || 'auto').trim().toLowerCase(),
    logFile: String(process.env.START_LOG_FILE || '').trim(),
    token: String(process.env.GITHUB_TOKEN || process.env.GIT_TOKEN || '').trim(),
    authUrl: String(process.env.GIT_AUTH_URL || '').trim(),
    clean: String(process.env.CLEAN_INSTALL || '1').trim() !== '0',
    preserve: preserve.length > 0 ? preserve : DEFAULT_PRESERVE.slice(),
    startedAt: new Date().toISOString()
  };
}

const CONFIG = buildConfig();


let child = null;
let shuttingDown = false;
let restartCount = 0;

function timestamp() {
  return new Date().toISOString();
}

function toLine(value) {
  return String(value).replace(/\r?\n$/, '');
}

function log(level, message, details) {
  const suffix = details === undefined ? '' : ' ' + String(details);
  const line = '[' + timestamp() + '] [' + level + '] ' + message + suffix;
  process.stdout.write(line + '\n');
  if (CONFIG.logFile) {
    try {
      fs.appendFileSync(CONFIG.logFile, line + '\n');
    } catch (err) {
      process.stdout.write('[' + timestamp() + '] [warn] cannot write START_LOG_FILE: ' + err.message + '\n');
    }
  }
}

function authenticatedUrl(url) {
  if (CONFIG.authUrl) return CONFIG.authUrl;
  const token = CONFIG.token;
  if (!token) return url;
  const match = String(url).match(/^https:\/\/(?:[^@/]+@)?github\.com\/(.+)$/);
  if (!match) return url;
  return 'https://x-access-token:' + encodeURIComponent(token) + '@github.com/' + match[1];
}

function redact(text) {
  let output = String(text || '');
  if (CONFIG.token) output = output.split(CONFIG.token).join('***');
  if (CONFIG.authUrl) output = output.split(CONFIG.authUrl).join('(auth-url)');
  return output;
}

function credentialArgs() {
  const basic = Buffer.from('x-access-token:' + (CONFIG.token || '')).toString('base64');
  return [
    '-c', 'credential.helper=',
    '-c', 'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + basic
  ];
}

function run(command, args, options) {
  const settings = options || {};
  const result = spawnSync(command, args, {
    cwd: settings.cwd || APP_DIR,
    encoding: 'utf8',
    timeout: settings.timeoutMs || 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
    shell: false,
    windowsHide: true
  });
  if (result.error) {
    return { ok: false, code: -1, stdout: '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    code: typeof result.status === 'number' ? result.status : -1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || '')
  };
}

function git(args, options) {
  const list = Array.isArray(args) ? args.slice() : [];
  const networkCommand = list.length > 0 && ['clone', 'fetch', 'pull', 'ls-remote'].includes(list.find((item) => typeof item === 'string' && !item.startsWith('-')));
  const fullArgs = CONFIG.token && networkCommand ? credentialArgs().concat(list) : list;
  const result = run('git', fullArgs, options);
  return Object.assign({}, result, { stdout: redact(result.stdout), stderr: redact(result.stderr), rawArgs: list.join(' ') });
}

function hasGit() {
  const probe = git(['--version'], { timeoutMs: 15000 });
  if (!probe.ok) {
    log('warn', 'git is not available, skipping update');
    return false;
  }
  return true;
}

function isGitRepo() {
  const probe = git(['rev-parse', '--is-inside-work-tree'], { timeoutMs: 15000 });
  return probe.ok && probe.stdout.trim() === 'true';
}

function ensureEnvFile() {
  const envPath = path.join(APP_DIR, '.env');
  const examplePath = path.join(APP_DIR, '.env.example');
  if (fs.existsSync(envPath)) return;
  if (!fs.existsSync(examplePath)) return;
  try {
    fs.copyFileSync(examplePath, envPath);
    log('info', 'created .env from .env.example (edit it with your API key)');
  } catch (err) {
    log('warn', 'cannot create .env: ' + err.message);
  }
}

function makeProtectedCopy() {
  const backupDir = path.join(APP_DIR, '.start-backup-' + process.pid);
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (err) {
    log('warn', 'cannot prepare backup directory: ' + err.message);
    return null;
  }
  for (const name of PROTECTED_FROM_RESET) {
    const source = path.join(APP_DIR, name);
    if (!fs.existsSync(source)) continue;
    try {
      fs.cpSync(source, path.join(backupDir, name), { recursive: true, force: true });
    } catch (err) {
      log('warn', 'cannot back up ' + name + ': ' + err.message);
    }
  }
  return backupDir;
}

function restoreProtected(backupDir) {
  if (!backupDir) return;
  for (const name of PROTECTED_FROM_RESET) {
    const backup = path.join(backupDir, name);
    if (!fs.existsSync(backup)) continue;
    try {
      fs.rmSync(path.join(APP_DIR, name), { recursive: true, force: true });
      fs.cpSync(backup, path.join(APP_DIR, name), { recursive: true, force: true });
    } catch (err) {
      log('warn', 'cannot restore ' + name + ': ' + err.message);
    }
  }
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'cannot remove backup directory: ' + err.message);
  }
}

function directoryHasFiles(directory) {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch (err) {
    return false;
  }
}

function wipeAppDir(keepNames) {
  const keep = new Set((keepNames || []).concat([], CONFIG.preserve));
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(APP_DIR);
  } catch (err) {
    return removed;
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    if (entry.startsWith('.start-backup-') || entry.startsWith('.clone-')) continue;
    try {
      fs.rmSync(path.join(APP_DIR, entry), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log('warn', 'cannot remove ' + entry + ': ' + err.message);
    }
  }
  return removed;
}

function copyTreeIntoAppDir(sourceDir, skipNames) {
  const skip = new Set(skipNames || []);
  const entries = fs.readdirSync(sourceDir);
  for (const entry of entries) {
    if (skip.has(entry)) continue;
    fs.cpSync(path.join(sourceDir, entry), path.join(APP_DIR, entry), { recursive: true, force: true });
  }
}

function cloneRepository() {
  if (!CONFIG.repoUrl) {
    log('warn', 'GIT_REPO_URL is empty, running without repository');
    return false;
  }
  const targetName = path.basename(APP_DIR);
  const tempDir = path.join(APP_DIR, '.clone-' + process.pid);
  log('info', 'cloning ' + CONFIG.repoUrl + ' (' + CONFIG.branch + ') into ' + APP_DIR);
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'cannot prepare temporary clone directory inside app dir: ' + err.message);
  }
  const url = authenticatedUrl(CONFIG.repoUrl);
  const clone = git(['clone', '--depth', '1', '--branch', CONFIG.branch, url, tempDir], { timeoutMs: 300000 });
  if (!clone.ok) {
    const retry = git(['clone', '--depth', '1', '--branch', CONFIG.branch, url, tempDir], { timeoutMs: 300000, cwd: APP_DIR });
    if (!retry.ok) {
      const reason = (retry.stderr || retry.stdout || clone.stderr || '').trim();
      log('error', 'git clone failed: ' + (reason || 'unknown error'));
      if (reason.includes('terminal prompts disabled') || reason.includes('could not read Username') || reason.includes('Authentication failed')) {
        log('error', 'GitHub needs a token: add GITHUB_TOKEN (repo scope) or make the repository public');
      }
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        log('warn', 'cannot remove temporary clone: ' + err.message);
      }
      return false;
    }
  }
  const backupDir = makeProtectedCopy();
  const appBaseline = new Set(['.env', '.agent', 'node_modules']);
  if (backupDir) appBaseline.add(path.basename(backupDir));
  appBaseline.add(path.basename(tempDir));
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    if (CONFIG.clean) {
      const removed = wipeAppDir([path.basename(tempDir), path.basename(backupDir || '')]);
      if (removed > 0) log('info', 'cleaned ' + removed + ' existing entries before installing the repo');
    }
    copyTreeIntoAppDir(tempDir, ['.git']);
    fs.cpSync(path.join(tempDir, '.git'), path.join(APP_DIR, '.git'), { recursive: true, force: true });
  } catch (err) {
    log('error', 'cannot copy cloned files: ' + err.message);
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'cannot remove temporary clone: ' + err.message);
  }
  restoreProtected(backupDir);
  log('info', 'repository cloned into ' + targetName);
  return true;
}

function pullUpdates() {
  if (!CONFIG.autoUpdate) {
    log('info', 'AUTO_UPDATE=0, skipping update');
    return true;
  }
  if (!hasGit()) {
    if (!fs.existsSync(path.join(APP_DIR, CONFIG.entry))) {
      log('error', 'git is not available and ' + CONFIG.entry + ' is missing; upload the files or install git');
      return false;
    }
    return true;
  }

  if (!isGitRepo()) {
    const cloned = cloneRepository();
    if (!cloned) return false;
    return true;
  }

  const remoteCheck = git(['remote', 'get-url', CONFIG.remote], { timeoutMs: 15000 });
  if (!remoteCheck.ok) {
    const addRemote = git(['remote', 'add', CONFIG.remote, CONFIG.repoUrl], { timeoutMs: 15000 });
    if (!addRemote.ok) {
      log('warn', 'cannot add git remote', toLine(addRemote.stderr));
    }
  } else if (CONFIG.repoUrl && remoteCheck.stdout.trim() !== CONFIG.repoUrl) {
    git(['remote', 'set-url', CONFIG.remote, CONFIG.repoUrl], { timeoutMs: 15000 });
  }

  log('info', 'fetching ' + CONFIG.remote + '/' + CONFIG.branch);
  const fetch = git(['fetch', '--depth', '1', CONFIG.remote, CONFIG.branch], { timeoutMs: 180000 });
  if (!fetch.ok) {
    log('warn', 'git fetch failed, starting current version', toLine(fetch.stderr || fetch.stdout));
    return true;
  }

  const target = CONFIG.remote + '/' + CONFIG.branch;
  const before = git(['rev-parse', 'HEAD'], { timeoutMs: 15000 });
  const incoming = git(['rev-parse', target], { timeoutMs: 15000 });
  if (!incoming.ok) {
    log('warn', 'cannot resolve ' + target + ', starting current version');
    return true;
  }
  const beforeSha = before.ok ? before.stdout.trim() : '';
  const incomingSha = incoming.stdout.trim();
  if (beforeSha === incomingSha) {
    log('info', 'already up to date (' + incomingSha.slice(0, 7) + ')');
    return true;
  }

  if (CONFIG.clean) {
    log('info', 'clean install: syncing working tree to ' + target + ' (keeping .env, .agent, node_modules)');
    const backupDir = makeProtectedCopy();
    const checkout = git(['checkout', '--force', '-B', CONFIG.branch, target], { timeoutMs: 120000 });
    if (!checkout.ok) {
      log('error', 'git checkout failed, keeping current version', toLine(checkout.stderr || checkout.stdout));
      restoreProtected(backupDir);
      return false;
    }
    const clean = git(['clean', '-fdx', '--', '.', ':(exclude).env', ':(exclude).agent', ':(exclude)node_modules'], { timeoutMs: 120000 });
    if (!clean.ok) {
      log('warn', 'git clean reported: ' + toLine(clean.stderr || clean.stdout));
    }
    restoreProtected(backupDir);
    log('info', 'updated ' + (beforeSha ? beforeSha.slice(0, 7) : '(new)') + ' -> ' + incomingSha.slice(0, 7));
    return true;
  }

  const localChanges = git(['status', '--porcelain', '--untracked-files=no', '--', ':(exclude)start.js'], { timeoutMs: 20000 });
  const localChangesText = localChanges.ok ? localChanges.stdout.trim() : '';
  if (localChangesText !== '') {
    log('warn', 'local changes detected, using merge instead of hard reset');
    const merge = git(['-c', 'user.email=agent@claudex.local', '-c', 'user.name=Claudex start.js', 'merge', '--no-edit', target], { timeoutMs: 120000 });
    if (!merge.ok) {
      log('error', 'git merge failed, keeping current version', toLine(merge.stderr || merge.stdout));
      return true;
    }
    log('info', 'merged ' + target + ' (' + incomingSha.slice(0, 7) + ')');
    return true;
  }

  const backupDir = makeProtectedCopy();
  const reset = git(['reset', '--hard', target], { timeoutMs: 120000 });
  if (!reset.ok) {
    log('error', 'git reset failed, keeping current version', toLine(reset.stderr || reset.stdout));
    restoreProtected(backupDir);
    return true;
  }
  git(['clean', '-fd'], { timeoutMs: 120000 });
  restoreProtected(backupDir);
  log('info', 'updated ' + (beforeSha ? beforeSha.slice(0, 7) : '(new)') + ' -> ' + incomingSha.slice(0, 7));
  return true;
}

function nodeModulesUsable() {
  try {
    return fs.existsSync(path.join(APP_DIR, 'node_modules', 'express', 'package.json'));
  } catch (err) {
    return false;
  }
}

function fallbackLinkNodeModules() {
  if (nodeModulesUsable()) return true;
  try {
    if (fs.existsSync(path.join(APP_DIR, 'node_modules'))) fs.rmSync(path.join(APP_DIR, 'node_modules'), { recursive: true, force: true });
  } catch (err) {
    log('warn', 'cannot clear broken node_modules: ' + err.message);
  }
  const candidates = [];
  try {
    let current = path.dirname(APP_DIR);
    while (current && current !== path.dirname(current)) {
      candidates.push(path.join(current, 'node_modules'));
      current = path.dirname(current);
    }
  } catch (err) {
    /* path walk is best effort */
  }
  if (process.env.START_NODE_MODULES) candidates.unshift(process.env.START_NODE_MODULES);
  const source = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'express', 'package.json')));
  if (!source) return false;
  try {
    fs.symlinkSync(source, path.join(APP_DIR, 'node_modules'), 'dir');
    log('info', 'using existing node_modules from ' + source);
    return true;
  } catch (err) {
    log('warn', 'cannot link node_modules: ' + err.message);
    return false;
  }
}

function dependenciesInstalled() {
  if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) return true;
  if (!fs.existsSync(path.join(APP_DIR, 'node_modules'))) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
    const names = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.optionalDependencies || {}));
    if (names.length === 0) return true;
    return names.every((name) => fs.existsSync(path.join(APP_DIR, 'node_modules', name, 'package.json')));
  } catch (err) {
    return false;
  }
}

function installDependencies() {
  if (CONFIG.install === 'never') {
    log('info', 'NPM_INSTALL=never, checking existing node_modules');
    return nodeModulesUsable() || fallbackLinkNodeModules();
  }
  if (CONFIG.install === 'auto' && dependenciesInstalled() && nodeModulesUsable()) {
    log('info', 'dependencies already installed');
    return true;
  }
  if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) return true;
  log('info', 'installing dependencies with npm');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = run(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], { timeoutMs: 600000 });
  if (!install.ok) {
    log('warn', 'npm install failed, trying existing node_modules', toLine(install.stderr || install.stdout));
    return fallbackLinkNodeModules();
  }
  log('info', 'dependencies installed');
  return true;
}

function ensureEnvDefaults() {
  const envPath = path.join(APP_DIR, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const values = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
      if (process.env.AI_API_KEY === 'your_api_key_here') delete process.env.AI_API_KEY;
      Object.keys(values).forEach((key) => {
        if (!key.startsWith('START_') && process.env[key] === undefined && values[key] !== '') {
          process.env[key] = values[key];
        }
      });
      if (!process.env.SERVER_PORT && values.SERVER_PORT) process.env.SERVER_PORT = values.SERVER_PORT;
    }
  } catch (err) {
    log('warn', 'cannot read .env defaults: ' + err.message);
  }
  if (process.env.AI_API_KEY === 'your_api_key_here' || !process.env.AI_API_KEY) {
    log('warn', 'AI_API_KEY trong .env chưa được điền (vẫn là giá trị mẫu hoặc trống)');
  }
}

function startServer() {
  const entryPath = path.resolve(APP_DIR, CONFIG.entry);
  if (!fs.existsSync(entryPath)) {
    log('error', 'entry file not found: ' + entryPath);
    return false;
  }
  restartCount += 1;
  log('info', 'starting ' + CONFIG.entry + ' (attempt ' + restartCount + ')');
  child = spawn(process.execPath, [entryPath], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: Object.assign({}, process.env, { CLAUDEX_STARTED_BY: 'start.js' })
  });
  child.on('exit', (code, signal) => {
    const exitCode = typeof code === 'number' ? code : 0;
    if (shuttingDown) {
      log('info', 'server stopped');
      process.exit(exitCode);
      return;
    }
    log('warn', 'server exited (code=' + exitCode + ', signal=' + (signal || 'none') + ')');
    if (exitCode === 0) {
      log('info', 'server finished normally, not restarting');
      process.exit(0);
      return;
    }
    if (restartCount >= 5) {
      log('error', 'server crashed 5 times in a row, giving up');
      process.exit(1);
      return;
    }
    log('info', 'restarting server in 3s');
    setTimeout(() => {
      startServer();
    }, 3000);
  });
  child.on('error', (err) => {
    log('error', 'cannot start server: ' + err.message);
    process.exit(1);
  });
  return true;
}

function shutdown(signal, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'received ' + signal + ', shutting down');
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM');
    } catch (err) {
      log('warn', 'cannot signal server: ' + err.message);
    }
    setTimeout(() => {
      if (child && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch (err) {
          log('warn', 'cannot force stop server: ' + err.message);
        }
      }
      process.exit(exitCode);
    }, 5000).unref();
    return;
  }
  process.exit(exitCode);
}

function main() {
  ensureEnvFile();
  const loaded = loadEnvFile();
  const keys = Object.keys(loaded);
  log('info', 'Environment: .env loaded (' + keys.length + ' key' + (keys.length === 1 ? '' : 's') + ')' + (keys.length ? ': ' + keys.join(', ') : ''));
  Object.assign(CONFIG, buildConfig());
  log('info', 'Claudex start.js | repo=' + CONFIG.repoUrl + ' branch=' + CONFIG.branch + ' dir=' + APP_DIR);
  try {
    pullUpdates();
  } catch (err) {
    log('error', 'update step failed: ' + err.message);
  }
  try {
    ensureEnvFile();
    loadEnvFile();
    Object.assign(CONFIG, buildConfig());
    installDependencies();
  } catch (err) {
    log('error', 'dependency step failed: ' + err.message);
  }
  ensureEnvDefaults();
  log('info', 'Server env: SERVER_PORT=' + (process.env.SERVER_PORT || '(default)') + ', AI_MODEL=' + (process.env.AI_MODEL || '(default)') + ', AI_API_KEY=' + (process.env.AI_API_KEY ? 'set' : 'missing'));
  const started = startServer();
  if (!started) process.exit(1);
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGHUP', () => shutdown('SIGHUP', 0));
process.on('uncaughtException', (err) => {
  log('error', 'uncaught exception: ' + (err && err.stack ? err.stack : String(err)));
  shutdown('uncaughtException', 1);
});

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(START_FILE).href;
if (isMain) {
  main();
}

export { main, pullUpdates, installDependencies, dependenciesInstalled, CONFIG, loadEnvFile, parseEnvFile, buildConfig };
