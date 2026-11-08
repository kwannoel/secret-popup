import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { envValues, readEnv, upsert, writeEnv } from '../src/envfile.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'secret-popup-'));

test('reads the common .env syntaxes', () => {
  const values = envValues(
    [
      '# A=commented',
      'PLAIN=value # trailing comment',
      'export EXPORTED=yes',
      "SINGLE='a $b \\n'",
      'DOUBLE="line1\\nline2 \\"q\\""',
      'MULTI="first',
      'second"',
      'SPACED = padded  ',
      'EMPTY=',
      'CRLF=windows\r',
      'not an assignment',
    ].join('\n'),
  );
  assert.deepEqual(Object.fromEntries(values), {
    PLAIN: 'value',
    EXPORTED: 'yes',
    SINGLE: 'a $b \\n',
    DOUBLE: 'line1\nline2 "q"',
    MULTI: 'first\nsecond',
    SPACED: 'padded',
    EMPTY: '',
    CRLF: 'windows',
  });
});

test('an unterminated quote does not swallow the rest of the file', () => {
  const values = envValues('BROKEN="oops\nNEXT=fine\n');
  assert.equal(values.get('NEXT'), 'fine');
});

test('upsert appends a new key, adding a newline if needed', () => {
  assert.equal(upsert('', 'K', 'v'), "K='v'\n");
  assert.equal(upsert('A=1', 'K', 'v'), "A=1\nK='v'\n");
  assert.equal(upsert('A=1\n', 'K', 'v'), "A=1\nK='v'\n");
});

test('upsert replaces in place and leaves everything else untouched', () => {
  const before = '# header\nA=1\n\nK=old # note\nB="two"\n';
  assert.equal(upsert(before, 'K', 'new'), "# header\nA=1\n\nK='new'\nB=\"two\"\n");
});

test('upsert collapses existing duplicates, including multi-line ones', () => {
  const before = 'K=one\nA=1\nK="multi\nline"\nB=2\nexport K=three\n';
  const after = upsert(before, 'K', 'new');
  assert.equal(after, "K='new'\nA=1\nB=2\n");
  assert.equal(upsert(after, 'K', 'new'), after);
});

test('upsert keeps an export prefix so sourcing still works', () => {
  assert.equal(upsert('export K=old\n', 'K', 'new'), "export K='new'\n");
});

test('a similarly named key is not treated as a duplicate', () => {
  assert.equal(upsert('MY_K=1\nK_2=2\n', 'K', 'v'), "MY_K=1\nK_2=2\nK='v'\n");
});

const TRICKY = ["it's", 'a"b', '$HOME', '`id`', '$(id)', 'back\\slash', "'; touch pwned; '", "both ' and \" and $x and \\", 'a#b c', 'pässwörd🔑'];

test('tricky values survive being written and parsed back', () => {
  for (const value of [...TRICKY, 'line1\nline2']) {
    assert.equal(envValues(upsert('', 'K', value)).get('K'), value);
  }
});

test('tricky values survive `source .env` and execute nothing', () => {
  const dir = tempDir();
  for (const value of TRICKY) {
    writeEnv(dir, upsert('', 'K', value));
    const output = execFileSync('/bin/sh', ['-c', '. ./.env; printf %s "$K"'], { cwd: dir, encoding: 'utf8' });
    assert.equal(output, value);
  }
});

test('writeEnv creates the file readable only by its owner', () => {
  const dir = tempDir();
  writeEnv(dir, 'A=1\n');
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  writeFileSync(join(dir, '.env'), 'A=1\n', { mode: 0o644 });
  writeEnv(dir, 'A=2\n');
  assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
  assert.equal(readEnv(dir), 'A=2\n');
});

test('a symlinked .env is refused', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'target'), 'A=1\n');
  symlinkSync(join(dir, 'target'), join(dir, '.env'));
  assert.throws(() => readEnv(dir), /not a regular file/);
  assert.throws(() => writeEnv(dir, 'A=2\n'), /not a regular file/);
});
