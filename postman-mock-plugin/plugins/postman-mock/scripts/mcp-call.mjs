#!/usr/bin/env node
// Minimal client for the remote Postman MCP server (streamable HTTP), for diagnostics
// and for agents whose MCP connection is not loaded yet. No dependencies; Node 18+.
// Uses POSTMAN_API_KEY as a bearer token. POSTMAN_MCP_URL overrides the endpoint.
//
// Usage:
//   node mcp-call.mjs list [filter]              tool names (+ required args) containing filter
//   node mcp-call.mjs schema <toolName>          full input schema of one tool
//   node mcp-call.mjs call <toolName> <json|@file>

import fs from 'node:fs';

const URL_ = process.env.POSTMAN_MCP_URL ?? 'https://mcp.postman.com/mcp';
let sessionId;
let nextId = 1;

async function rpc(method, params, notify = false) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) throw new Error('POSTMAN_API_KEY is not set');
  const headers = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: nextId++ }) };
  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) });
  sessionId = res.headers.get('mcp-session-id') ?? sessionId;
  const text = await res.text();
  if (notify) return null;
  if (!res.ok) throw new Error(`${method} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  // Either plain JSON or an SSE stream whose data lines carry JSON-RPC messages.
  const messages = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const reply = messages.find(m => m.id === body.id) ?? messages.at(-1);
  if (reply.error) throw new Error(`${method} -> ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function connect() {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'postman-mock-plugin', version: '0.1.0' },
  });
  await rpc('notifications/initialized', undefined, true);
}

async function listTools() {
  const tools = [];
  let cursor;
  do {
    const r = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor);
  return tools;
}

const [cmd, a, b] = process.argv.slice(2);
try {
  await connect();
  if (cmd === 'list') {
    const tools = (await listTools()).filter(t => !a || t.name.toLowerCase().includes(a.toLowerCase()));
    for (const t of tools) console.log(`${t.name}(${(t.inputSchema?.required ?? []).join(', ')})`);
    console.log(`\n${tools.length} tools`);
  } else if (cmd === 'schema') {
    const t = (await listTools()).find(x => x.name === a);
    if (!t) throw new Error(`No tool ${a}`);
    console.log(JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }, null, 2));
  } else if (cmd === 'call') {
    const args = b ? JSON.parse(b.startsWith('@') ? fs.readFileSync(b.slice(1), 'utf8') : b) : {};
    const r = await rpc('tools/call', { name: a, arguments: args });
    for (const c of r.content ?? []) console.log(c.type === 'text' ? c.text : JSON.stringify(c));
    if (r.isError) process.exitCode = 2;
  } else {
    console.log('usage: node mcp-call.mjs list [filter] | schema <tool> | call <tool> <json|@file>');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
