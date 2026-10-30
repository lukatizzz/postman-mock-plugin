#!/usr/bin/env node
// Calls every request of an exported collection on a mock and checks that each one
// returns its own default (lowest 2xx) example. No dependencies; Node 18+.
//
// Usage: node verify-mock.mjs <collection.json> <mockBaseUrl> [--only <substring>] [--concurrency 4] [--base-path /api/v1]
// e.g.   node verify-mock.mjs .postman-mock/collections/<uid>.json http://localhost:4800/gw/<project>/<mock>
// Mock data (cases / flow data) changes the answers on purpose; run it on a mock without data, or read the FAILs.

import fs from 'node:fs';

const args = process.argv.slice(2);
const [file, baseUrl] = args;
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file || !baseUrl) {
  console.error('usage: node verify-mock.mjs <collection.json> <mockBaseUrl> [--only <substring>] [--concurrency 4]');
  process.exit(1);
}
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const collection = json.collection ?? json;
const variables = Object.fromEntries((collection.variable ?? []).map(v => [v.key, v.value]));

const norm = s => {
  try { return JSON.stringify(JSON.parse(s)); } catch { return String(s ?? '').trim(); }
};

// Index every example body so a wrong answer can be traced to the example that produced it.
const all = [];
const requests = [];
const walk = items => {
  for (const item of items ?? []) {
    if (item.item) { walk(item.item); continue; }
    const path = (item.request?.url?.path ?? []).map(s => (s.startsWith(':') || /^\{\{.+\}\}$/.test(s) ? '123' : s));
    const endpoint = `${item.request.method} /${(item.request.url.path ?? []).join('/')}`;
    for (const r of item.response ?? []) all.push({ endpoint, name: r.name, code: r.code, body: norm(r.body) });
    const ok = (item.response ?? []).filter(r => r.code >= 200 && r.code < 300).sort((a, b) => a.code - b.code)[0];
    if (ok) requests.push({ endpoint, method: item.request.method, path: '/' + path.join('/'), expected: ok });
  }
};
walk(collection.item);

const basePath = opt('base-path') ?? String(variables.baseUrl ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/$/, '');
const root = baseUrl.replace(/\/$/, '') + (baseUrl.includes(basePath) ? '' : basePath);
const headers = { 'content-type': 'application/json' };

const only = opt('only');
const queue = requests.filter(r => !only || r.endpoint.includes(only));
const results = [];
const worker = async () => {
  while (queue.length) {
    const r = queue.shift();
    let status, text;
    try {
      const res = await fetch(root + r.path, { method: r.method, headers, body: ['GET', 'HEAD'].includes(r.method) ? undefined : '{}' });
      status = res.status;
      text = norm(await res.text());
    } catch (e) {
      status = 0;
      text = e.message;
    }
    const noBody = r.expected.code === 204 || r.expected.code === 304;
    const pass = status === r.expected.code && (noBody || text === norm(r.expected.body));
    const got = pass ? null : all.find(e => e.body === text && e.code === status);
    results.push({ ...r, status, pass, got });
  }
};
await Promise.all(Array.from({ length: Number(opt('concurrency') ?? 4) }, worker));

const failed = results.filter(r => !r.pass);
for (const r of failed) {
  const why = r.got ? `got "${r.got.name}" (${r.got.code}) from ${r.got.endpoint}` : `got ${r.status}`;
  console.log(`FAIL ${r.endpoint} -> expected "${r.expected.name}" (${r.expected.code}); ${why}`);
}
console.log(`\n${results.length - failed.length}/${results.length} endpoints return their own default example`);
process.exit(failed.length ? 2 : 0);
