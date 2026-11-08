import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CANCELLED, TIMED_OUT } from '../src/prompt.js';
import { listSecrets, requestSecret, runWithSecrets } from '../src/tools.js';

const SECRET = 'sk-test-abcdef123456';
const tempDir = () => mkdtempSync(join(tmpdir(), 'secret-popup-'));
const read = (dir, file = '.env') => readFileSync(join(dir, file), 'utf8');
const answer = (value) => async () => value;
const noPrompt = async () => assert.fail('the user should not have been prompted');

function gitRepo() {
  const dir = tempDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function isIgnored(dir) {
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

test('saves a secret, gitignores .env, and returns no value', async () => {
  const dir = gitRepo();
  const result = await requestSecret({ project_dir: dir, name: 'API_KEY' }, answer(`  ${SECRET}\n`));
  assert.equal(result.status, 'saved');
  assert.equal(result.updated_gitignore, true);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(read(dir), `API_KEY='${SECRET}'\n`);
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.ok(isIgnored(dir));
});

test('an existing value is kept without prompting', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), 'API_KEY=existing\n');
  const result = await requestSecret({ project_dir: dir, name: 'API_KEY' }, noPrompt);
  assert.equal(result.status, 'already_set');
  assert.equal(read(dir), 'API_KEY=existing\n');
});

test('overwrite replaces the value and never duplicates the key', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), 'API_KEY=one\nOTHER=x\nAPI_KEY=two\n');
  const result = await requestSecret({ project_dir: dir, name: 'API_KEY', overwrite: true }, answer(SECRET));
  assert.equal(result.status, 'replaced');
  assert.equal(read(dir), `API_KEY='${SECRET}'\nOTHER=x\n`);
});

test('a blank placeholder counts as unset', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), 'API_KEY=\n');
  const result = await requestSecret({ project_dir: dir, name: 'API_KEY' }, answer(SECRET));
  assert.equal(result.status, 'saved');
  assert.equal(read(dir), `API_KEY='${SECRET}'\n`);
});

test('cancel, timeout and empty input write nothing', async () => {
  for (const [value, status] of [[CANCELLED, 'cancelled'], [TIMED_OUT, 'timed_out'], ['   ', 'empty']]) {
    const dir = tempDir();
    const result = await requestSecret({ project_dir: dir, name: 'API_KEY' }, answer(value));
    assert.equal(result.status, status);
    assert.ok(!existsSync(join(dir, '.env')));
  }
});

test('edits made while the popup is open are preserved', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), 'A=1\n');
  await requestSecret({ project_dir: dir, name: 'API_KEY' }, async () => {
    writeFileSync(join(dir, '.env'), 'A=1\nB=2\n');
    return SECRET;
  });
  assert.equal(read(dir), `A=1\nB=2\nAPI_KEY='${SECRET}'\n`);
});

test('a .env tracked by git is refused before the user is prompted', async () => {
  const dir = gitRepo();
  writeFileSync(join(dir, '.env'), 'A=1\n');
  execFileSync('git', ['add', '-f', '.env'], { cwd: dir });
  await assert.rejects(requestSecret({ project_dir: dir, name: 'API_KEY' }, noPrompt), /tracked by git/);
  assert.equal(read(dir), 'A=1\n');
});

test('gitignore entries are not duplicated', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.gitignore'), 'dist/');
  await requestSecret({ project_dir: dir, name: 'A' }, answer(SECRET));
  await requestSecret({ project_dir: dir, name: 'B' }, answer(SECRET));
  assert.equal(read(dir, '.gitignore'), 'dist/\n.env\n');
});

test('an existing ignore rule is respected', async () => {
  const dir = gitRepo();
  writeFileSync(join(dir, '.gitignore'), '.env*\n');
  const result = await requestSecret({ project_dir: dir, name: 'A' }, answer(SECRET));
  assert.equal(result.updated_gitignore, false);
  assert.equal(read(dir, '.gitignore'), '.env*\n');
});

test('a negated rule is overridden', async () => {
  const dir = gitRepo();
  writeFileSync(join(dir, '.gitignore'), '.env\n!.env\n');
  await requestSecret({ project_dir: dir, name: 'A' }, answer(SECRET));
  assert.ok(isIgnored(dir));
});

test('bad input is rejected', async () => {
  const dir = tempDir();
  for (const name of ['', '1BAD', 'A B', 'A=B', 'A\nB', '$(id)']) {
    await assert.rejects(requestSecret({ project_dir: dir, name }, noPrompt), /Secret names/);
  }
  await assert.rejects(requestSecret({ project_dir: 'relative', name: 'A' }, noPrompt), /absolute/);
  await assert.rejects(requestSecret({ project_dir: join(dir, 'nope'), name: 'A' }, noPrompt), /does not exist/);
});

test('list_secrets returns names only', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), `B=${SECRET}\nA=x\nBLANK=\n`);
  const result = await listSecrets({ project_dir: dir });
  assert.deepEqual(result.names, ['A', 'B']);
  assert.equal(result.gitignored, false);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

function projectWithSecret() {
  const dir = tempDir();
  writeFileSync(join(dir, '.env'), `API_KEY='${SECRET}'\nOTHER=other-secret-value\n`);
  return dir;
}

const run = (dir, command, extra = {}) => runWithSecrets({ project_dir: dir, command, secrets: ['API_KEY'], ...extra });

test('the command receives the secret, and the output masks it', async () => {
  const dir = projectWithSecret();
  const result = await run(dir, 'echo "key=$API_KEY"; echo "$API_KEY" >&2');
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, 'key=[REDACTED:API_KEY]\n');
  assert.equal(result.stderr, '[REDACTED:API_KEY]\n');
});

test('the value reaching the command is the real one', async () => {
  const dir = projectWithSecret();
  const result = await run(dir, `[ "$API_KEY" = '${SECRET}' ] && echo match`);
  assert.equal(result.stdout, 'match\n');
});

test('only named secrets are exposed, but all of .env is masked', async () => {
  const dir = projectWithSecret();
  const result = await run(dir, 'echo "[${OTHER:-unset}]"; cat .env');
  assert.ok(result.stdout.startsWith('[unset]\n'));
  assert.ok(!result.stdout.includes(SECRET));
  assert.ok(!result.stdout.includes('other-secret-value'));
});

test('base64 and URL-encoded forms are masked', async () => {
  const dir = tempDir();
  const value = 'p@ss/w0rd+long=value';
  writeFileSync(join(dir, '.env'), `API_KEY='${value}'\n`);
  const result = await run(dir, `printf %s "$API_KEY" | base64; echo "$API_KEY" | base64; echo '${encodeURIComponent(value)}'`);
  assert.equal(result.stdout, '[REDACTED:API_KEY]\n[REDACTED:API_KEY]\n[REDACTED:API_KEY]\n');
});

test('a secret split by the output cap does not leak a fragment', async () => {
  const dir = projectWithSecret();
  const filler = 1024 * 1024 - 5;
  const result = await run(dir, `head -c ${filler} /dev/zero | tr '\\0' x; printf %s "$API_KEY"`);
  assert.ok(result.stdout.endsWith('[output truncated]'));
  assert.ok(!result.stdout.includes(SECRET.slice(0, 5)));
});

test('a nonzero exit is reported, not thrown', async () => {
  const result = await run(projectWithSecret(), 'exit 7');
  assert.equal(result.exit_code, 7);
});

test('a timeout kills the command and its children', async () => {
  const started = Date.now();
  const result = await run(projectWithSecret(), 'sleep 30 & wait', { timeout_seconds: 1 });
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - started < 5000);
});

test('a missing secret is named, and nothing runs', async () => {
  const dir = projectWithSecret();
  await assert.rejects(
    runWithSecrets({ project_dir: dir, command: 'touch ran', secrets: ['API_KEY', 'MISSING'] }),
    /Not set in .*: MISSING\. Use request_secret/,
  );
  assert.ok(!existsSync(join(dir, 'ran')));
});
