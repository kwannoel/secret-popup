import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const SECRET = 'sk-test-abcdef123456';

test('speaks MCP over stdio and never prints a secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-popup-'));
  writeFileSync(join(dir, '.env'), `API_KEY='${SECRET}'\n`);

  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const raw = [];
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    raw.push(line);
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const callTool = async (name, args) => {
    const { result } = await request('tools/call', { name, arguments: args });
    return { ...result, text: result.content[0].text };
  };

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const { result: { tools } } = await request('tools/list', {});
  assert.deepEqual(tools.map((tool) => tool.name), ['request_secret', 'list_secrets', 'run_with_secrets']);
  assert.ok(tools.every((tool) => tool.inputSchema.type === 'object' && !('handler' in tool)));

  const listed = await callTool('list_secrets', { project_dir: dir });
  assert.deepEqual(JSON.parse(listed.text).names, ['API_KEY']);

  const already = await callTool('request_secret', { project_dir: dir, name: 'API_KEY' });
  assert.equal(JSON.parse(already.text).status, 'already_set');

  const ran = await callTool('run_with_secrets', { project_dir: dir, command: 'echo "$API_KEY"', secrets: ['API_KEY'] });
  assert.equal(JSON.parse(ran.text).stdout, '[REDACTED:API_KEY]\n');

  const failed = await callTool('list_secrets', { project_dir: 'relative' });
  assert.equal(failed.isError, true);

  const unknown = await request('no/such/method', {});
  assert.equal(unknown.error.code, -32601);

  assert.ok(!raw.join('\n').includes(SECRET));
});
