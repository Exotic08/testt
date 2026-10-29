import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const START_MODULE = path.resolve('start.js');
const APP_DIR = process.cwd();

const { dependenciesInstalled } = await import('../start.js');

after(() => {
  /* no global state to clean up */
});

test('start.js parses and the checker reports installed dependencies', async () => {
  const broken = [];
  try {
    execFileSync(process.execPath, ['--check', START_MODULE], { stdio: 'pipe' });
  } catch (err) {
    broken.push(err.message);
  }
  assert.deepEqual(broken, []);
  assert.equal(dependenciesInstalled(), true);
});

test('start.js boots the server from a temp copy and shuts down on SIGTERM', async () => {
  const projectCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-boot-'));
  const files = ['start.js', 'server.js', 'package.json', '.env.example', 'skills'];
  try {
    for (const entry of files) {
      if (!fs.existsSync(path.join(APP_DIR, entry))) continue;
      fs.cpSync(path.join(APP_DIR, entry), path.join(projectCopy, entry), { recursive: true, force: true });
    }
    fs.cpSync(path.join(APP_DIR, 'src'), path.join(projectCopy, 'src'), { recursive: true, force: true });
    fs.cpSync(path.join(APP_DIR, 'tools'), path.join(projectCopy, 'tools'), { recursive: true, force: true });
    if (fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
      fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(projectCopy, 'node_modules'), 'dir');
    }
    const port = String(3900 + Math.floor(Math.random() * 90));
    fs.writeFileSync(path.join(projectCopy, '.env'), 'SERVER_PORT=' + port + '\nAI_API_KEY=test\n', 'utf8');

    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [path.join(projectCopy, 'start.js')], {
      cwd: projectCopy,
      env: Object.assign({}, process.env, {
        AUTO_UPDATE: '0',
        NPM_INSTALL: 'never',
        SERVER_PORT: port,
        GIT_REPO_URL: ''
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/stats');
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch (err) {
        ready = false;
      }
    }
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode));
      setTimeout(() => resolve('timeout'), 8000);
    });
    assert.equal(ready, true, 'server should respond on /api/stats. Output: ' + output.slice(-2000));
    assert.match(output, /External tools loaded: .*todo_write/);
    assert.match(output, /already up to date|AUTO_UPDATE=0/);
    assert.notEqual(code, 'timeout');
    fs.rmSync(projectCopy, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(projectCopy, { recursive: true, force: true });
    throw err;
  }
});

test('start.js fails gracefully when the entry file is missing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-noentry-'));
  try {
    fs.copyFileSync(START_MODULE, path.join(empty, 'start.js'));
    const { spawn } = await import('node:child_process');
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(empty, 'start.js')], {
        cwd: empty,
        env: Object.assign({}, process.env, { AUTO_UPDATE: '0', NPM_INSTALL: 'never' }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      child.stdout.on('data', (c) => {
        output += c.toString();
      });
      child.stderr.on('data', (c) => {
        output += c.toString();
      });
      child.on('exit', (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 1);
    assert.match(result.output, /entry file not found/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
