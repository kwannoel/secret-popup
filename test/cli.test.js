import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SECRET = 'sk-test-abcdef123456';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-popup-'));
  writeFileSync(join(dir, '.env'), `API_KEY='${SECRET}'\n`);
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  return dir;
}

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });

test('run passes the secret, masks it, and keeps the exit code', () => {
  const result = cli(project(), 'run', 'API_KEY', '--', 'echo "key=$API_KEY"; echo "$API_KEY" >&2; exit 3');
  assert.equal(result.stdout, 'key=[REDACTED:API_KEY]\n');
  assert.equal(result.stderr, '[REDACTED:API_KEY]\n');
  assert.equal(result.status, 3);
});

test('run refuses a command split into several arguments', () => {
  // What `secret-popup run API_KEY -- echo $API_KEY` looks like once the
  // calling shell has expanded the unset variable.
  const result = cli(project(), 'run', 'API_KEY', '--', 'echo', '');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /one quoted argument/);
});

test('--dir points at another project', () => {
  const dir = project();
  const result = cli(tmpdir(), 'list', '--dir', dir);
  assert.deepEqual(JSON.parse(result.stdout).names, ['API_KEY']);
});

test('request on a set name succeeds without a popup', () => {
  const result = cli(project(), 'request', 'API_KEY');
  assert.equal(JSON.parse(result.stdout).status, 'already_set');
  assert.equal(result.status, 0);
});

test('errors go to stderr with a nonzero exit', () => {
  const dir = project();
  for (const args of [['request', 'bad name'], ['run', 'MISSING', '--', 'true'], ['nope']]) {
    const result = cli(dir, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^secret-popup: /);
  }
  assert.ok(!JSON.stringify(cli(dir, 'list')).includes(SECRET));
});
