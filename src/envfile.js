// Reads and edits .env files. Never put a value in an error message: these
// errors are returned to Claude.
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([\s\S]*)$/;

function closingQuote(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (quote !== "'" && text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}

function decodeDoubleQuoted(body) {
  const escapes = { n: '\n', r: '\r', t: '\t' };
  return body.replace(/\\([\s\S])/g, (match, c) => {
    if (c in escapes) return escapes[c];
    return '\\"$`'.includes(c) ? c : match;
  });
}

// Splits a file into blocks, one per line except for quoted multi-line values.
// Each block keeps its raw text so edits leave everything else byte-identical.
export function parseEnv(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(ASSIGNMENT);
    if (!match || lines[i].trimStart().startsWith('#')) {
      blocks.push({ raw: lines[i] });
      continue;
    }
    const [, exported, name, rest] = match;
    const quote = /^["'`]/.test(rest) ? rest[0] : null;
    let value;
    let end = i;
    if (quote) {
      let body = rest.slice(1);
      let close = closingQuote(body, quote);
      while (close === -1 && end + 1 < lines.length) {
        end++;
        body += `\n${lines[end]}`;
        close = closingQuote(body, quote);
      }
      if (close === -1) {
        // Unterminated quote: treat it as one line rather than swallow the file.
        end = i;
        value = rest.trim();
      } else {
        value = body.slice(0, close);
        if (quote === '"') value = decodeDoubleQuoted(value);
      }
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    blocks.push({ raw: lines.slice(i, end + 1).join('\n'), name, value, exported: Boolean(exported) });
    i = end;
  }
  return blocks;
}

// Last assignment wins, matching how dotenv-style shell sourcing behaves.
export function envValues(text) {
  const values = new Map();
  for (const block of parseEnv(text)) {
    if (block.name) values.set(block.name, block.value);
  }
  return values;
}

// Single quotes are literal for dotenv and for `source .env`, so prefer them.
export function encodeValue(value) {
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

// Sets `name`, replacing the first assignment in place and dropping any others,
// so the key appears exactly once.
export function upsert(text, name, value) {
  const line = (exported) => `${exported ? 'export ' : ''}${name}=${encodeValue(value)}`;
  const output = [];
  let written = false;
  for (const block of parseEnv(text)) {
    if (block.name !== name) {
      output.push(block.raw);
    } else if (!written) {
      output.push(line(block.exported));
      written = true;
    }
  }
  if (written) return output.join('\n');
  const body = output.join('\n');
  const separator = body === '' || body.endsWith('\n') ? '' : '\n';
  return `${body}${separator}${line(false)}\n`;
}

export function envPath(dir) {
  return join(dir, '.env');
}

function assertRegularFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${path} is not a regular file (is it a symlink?); refusing to use it.`);
  return true;
}

export function readEnv(dir) {
  const path = envPath(dir);
  return assertRegularFile(path) ? readFileSync(path, 'utf8') : '';
}

// Atomic, so a crash can't truncate an existing .env. Created 0600 from the
// start, so the secret is never briefly readable by other users.
export function writeEnv(dir, text) {
  const path = envPath(dir);
  assertRegularFile(path);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
