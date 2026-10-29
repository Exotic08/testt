import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const START_FILE = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(START_FILE);

const CONFIG = {
  repoUrl: String(process.env.GIT_REPO_URL || 'https://github.com/Exotic08/testt.git').trim(),
  branch: String(process.env.GIT_BRANCH || 'main').trim(),
  autoUpdate: String(process.env.AUTO_UPDATE || '1').trim() !== '0',
  remote: String(process.env.GIT_REMOTE || 'origin').trim(),
  entry: String(process.env.START_ENTRY || 'server.js').trim(),
  install: String(process.env.NPM_INSTALL || 'auto').trim().toLowerCase(),
  logFile: String(process.env.START_LOG_FILE || '').trim()
};

const PROTECTED_FROM_RESET = [
  '.env',
  '.agent',
  'node_modules'
];

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
  return run('git', args, options);
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

function cloneRepository() {
  if (!CONFIG.repoUrl) {
    log('warn', 'GIT_REPO_URL is empty, running without repository');
    return false;
  }
  const parent = path.dirname(APP_DIR);
  const targetName = path.basename(APP_DIR);
  const tempDir = path.join(parent, '.clone-' + process.pid);
  log('info', 'cloning ' + CONFIG.repoUrl + ' (' + CONFIG.branch + ') into ' + APP_DIR);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    log('warn', 'cannot clean temporary clone directory: ' + err.message);
  }
  const clone = git(['clone', '--depth', '1', '--branch', CONFIG.branch, CONFIG.repoUrl, tempDir], { timeoutMs: 300000 });
  if (!clone.ok) {
    log('error', 'git clone failed', toLine(clone.stderr || clone.stdout));
    return false;
  }
  const backupDir = makeProtectedCopy();
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    const entries = fs.readdirSync(tempDir);
    for (const entry of entries) {
      if (entry === '.git') continue;
      fs.cpSync(path.join(tempDir, entry), path.join(APP_DIR, entry), { recursive: true, force: true });
    }
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
  if (!hasGit()) return true;

  if (!isGitRepo()) {
    return cloneRepository();
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
    log('info', 'NPM_INSTALL=never, skipping dependency install');
    return true;
  }
  if (CONFIG.install === 'auto' && dependenciesInstalled()) {
    log('info', 'dependencies already installed');
    return true;
  }
  if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) return true;
  log('info', 'installing dependencies with npm');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const install = run(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], { timeoutMs: 600000 });
  if (!install.ok) {
    log('warn', 'npm install failed, starting with existing modules', toLine(install.stderr || install.stdout));
    return false;
  }
  log('info', 'dependencies installed');
  return true;
}

function ensureEnvDefaults() {
  if (process.env.SERVER_PORT) return;
  const envPath = path.join(APP_DIR, '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^\s*SERVER_PORT\s*=\s*(\d+)/m);
    if (match && !process.env.SERVER_PORT) process.env.SERVER_PORT = match[1];
  } catch (err) {
    log('warn', 'cannot read SERVER_PORT from .env: ' + err.message);
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
  log('info', 'Claudex start.js | repo=' + CONFIG.repoUrl + ' branch=' + CONFIG.branch + ' dir=' + APP_DIR);
  ensureEnvFile();
  try {
    pullUpdates();
  } catch (err) {
    log('error', 'update step failed: ' + err.message);
  }
  try {
    ensureEnvFile();
    installDependencies();
  } catch (err) {
    log('error', 'dependency step failed: ' + err.message);
  }
  ensureEnvDefaults();
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

export { main, pullUpdates, installDependencies, dependenciesInstalled, CONFIG };
