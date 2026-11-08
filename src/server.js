#!/usr/bin/env node
// A minimal MCP stdio server. It has no dependencies on purpose: this process
// handles secrets, so there is no third-party code to trust or audit.
import { createInterface } from 'node:readline';
import { TOOLS } from './tools.js';

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function callTool({ name, arguments: args = {} }) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    const result = await tool.handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
}

const METHODS = {
  initialize: ({ protocolVersion }) => ({
    protocolVersion: protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'secret-popup', version: '0.1.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }),
  'tools/call': callTool,
};

async function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (message.id === undefined) return; // Notifications need no reply.
  const method = METHODS[message.method];
  if (!method) return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  send({ id: message.id, result: await method(message.params ?? {}) });
}

// Requests aren't awaited in sequence, so an open popup doesn't block other calls.
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() !== '') handle(line);
});
