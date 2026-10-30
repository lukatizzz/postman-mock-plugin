#!/usr/bin/env node
// Small Postman REST API helper for the operations the Postman MCP server
// does not expose (or that are cheaper to do in one call). No dependencies; Node 18+.
// Reads the API key from POSTMAN_API_KEY. Set POSTMAN_API_BASE_URL=https://api.eu.postman.com for the EU region.
//
// Commands:
//   me                                         account + monthly API usage
//   import-openapi <file> [--workspace <id>]   OpenAPI file -> collection (synchronous)
//   create-spec <file> --workspace <id> [--name <name>]
//   generate-collection <specId> [--name <name>]   async; polls until the task finishes
//   upsert-example <example.json> --collection <uid> (--request <requestId> | --response <responseId>)
//       example.json: { "name", "code", "body", "headers"?, "request": { "method", "url", "pathVariables"?, "body"? } }
//   delete-example <responseId> --collection <uid>
//   normalize-collection <collectionUid> [--dry-run] [--out <file>]   one clear default example per request
//   export-collection <collectionId> [--out <file>]
//   task-status <specId> <taskId>
//   request <METHOD> <path> [--data <json>|@<file>]

import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.POSTMAN_API_BASE_URL ?? 'https://api.getpostman.com').replace(/\/$/, '');

async function api(method, urlPath, body) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) fail('POSTMAN_API_KEY is not set. Create a key at https://postman.co/settings/me/api-keys and set it as an environment variable.');
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) fail(`${method} ${urlPath} -> HTTP ${res.status}\n${JSON.stringify(data, null, 2)}`);
  return data;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function flags(argv) {
  const positional = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

const print = data => console.log(JSON.stringify(data, null, 2));

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const commands = {
  async me() {
    const data = await api('GET', '/me');
    const { user = {}, operations = [] } = data;
    print({
      user: { id: user.id, username: user.username, teamId: user.teamId },
      usage: operations.map(o => ({ name: o.name, usage: o.usage, limit: o.limit, overage: o.overage })),
    });
  },

  async 'import-openapi'([file], opts) {
    if (!file) fail('usage: import-openapi <file> [--workspace <id>]');
    const input = fs.readFileSync(file, 'utf8');
    const query = opts.workspace ? `?workspace=${encodeURIComponent(opts.workspace)}` : '';
    const data = await api('POST', `/import/openapi${query}`, {
      type: 'string',
      input,
      options: {
        folderStrategy: 'Tags',
        requestParametersResolution: 'Example',
        exampleParametersResolution: 'Example',
      },
    });
    print(data);
  },

  async 'create-spec'([file], opts) {
    if (!file || !opts.workspace) fail('usage: create-spec <file> --workspace <id> [--name <name>]');
    const content = fs.readFileSync(file, 'utf8');
    const version = content.match(/^\s*["']?openapi["']?\s*:\s*["']?(3\.1|3\.0)/m)?.[1]
      ?? (/^\s*["']?swagger["']?\s*:/m.test(content) ? '2.0' : null);
    if (!version) fail('Not an OpenAPI 2.0 / 3.0 / 3.1 file');
    const name = opts.name ?? content.match(/^\s*title:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? path.basename(file);
    const data = await api('POST', `/specs?workspaceId=${encodeURIComponent(opts.workspace)}`, {
      name,
      type: version === '2.0' ? 'OPENAPI:2.0' : `OPENAPI:${version}`,
      files: [{ path: path.extname(file) === '.json' ? 'index.json' : 'index.yaml', content }],
    });
    print({ id: data.id, name: data.name, type: data.type });
  },

  async 'generate-collection'([specId], opts) {
    if (!specId) fail('usage: generate-collection <specId> [--name <name>]');
    const gen = await api('POST', `/specs/${encodeURIComponent(specId)}/generations/collection`, {
      name: opts.name ?? 'Generated collection',
      options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' },
    });
    const taskId = gen.taskId ?? gen.task?.id;
    if (!taskId) { print(gen); return; }
    for (let i = 0, wait = 2000; i < 8; i++, wait *= 2) {
      await new Promise(r => setTimeout(r, wait));
      const task = await api('GET', `/specs/${encodeURIComponent(specId)}/tasks/${encodeURIComponent(taskId)}`);
      if (task.status && task.status !== 'pending' && task.status !== 'in-progress') {
        print({ taskId, polls: i + 1, ...task });
        return;
      }
    }
    fail(`Task ${taskId} still running; check later with: task-status ${specId} ${taskId}`);
  },

  // The /collections/{id}/responses endpoints only accept the legacy v1 response
  // format (responseCode, text, requestObject). v2.1-style fields are silently dropped,
  // so examples are always written through this command.
  async 'upsert-example'([file], opts) {
    if (!file || !opts.collection || (!opts.request && !opts.response)) {
      fail('usage: upsert-example <example.json> --collection <collectionUid> (--request <requestId> | --response <responseId>)');
    }
    const ex = JSON.parse(fs.readFileSync(file, 'utf8'));
    const body = ex.body === undefined ? '' : typeof ex.body === 'string' ? ex.body : JSON.stringify(ex.body, null, 2);
    const headers = ex.headers ?? [{ key: 'Content-Type', value: 'application/json' }];
    const req = ex.request ?? {};
    const reqBody = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const requestObject = {
      method: (req.method ?? 'GET').toUpperCase(),
      url: req.url,
      headers: Object.entries(req.headers ?? (reqBody ? { 'Content-Type': 'application/json' } : {})).map(([k, v]) => `${k}: ${v}`).join('\n'),
      pathVariables: req.pathVariables ?? {},
      queryParams: [],
      ...(reqBody !== undefined ? { dataMode: 'raw', rawModeData: reqBody } : {}),
    };
    const statusName = ex.status ?? STATUS_TEXT[ex.code] ?? '';
    const payload = {
      name: ex.name,
      status: statusName,
      responseCode: { code: Number(ex.code), name: statusName },
      headers,
      language: 'json',
      rawDataType: 'text',
      text: body,
      requestObject: JSON.stringify(requestObject),
    };
    if (!payload.name || !ex.code || !req.url) fail('example.json needs name, code and request.url');
    const col = encodeURIComponent(opts.collection);
    const data = opts.response
      ? await api('PUT', `/collections/${col}/responses/${encodeURIComponent(opts.response)}`, payload)
      : await api('POST', `/collections/${col}/responses?request=${encodeURIComponent(opts.request)}`, payload);
    print({ id: data.data?.id ?? data.model_id, name: data.data?.name, code: data.data?.responseCode?.code ?? Number(ex.code), action: opts.response ? 'updated' : 'created' });
  },

  async 'delete-example'([responseId], opts) {
    if (!responseId || !opts.collection) fail('usage: delete-example <responseId> --collection <collectionUid>');
    await api('DELETE', `/collections/${encodeURIComponent(opts.collection)}/responses/${encodeURIComponent(responseId)}`);
    print({ id: responseId, action: 'deleted' });
  },

  // Cleans the generated examples in ONE API call so every request has one clear default:
  //  - default example (lowest 2xx) of each request: {{baseUrl}}/path with {{var}} wildcards, no query
  //  - every other example: same path + ?__example=<code> (selected with x-mock-response-code)
  // Examples whose name contains " :: " are user scenarios and are left untouched.
  async 'normalize-collection'([collectionUid], opts) {
    if (!collectionUid) fail('usage: normalize-collection <collectionUid> [--dry-run] [--out <file>]');
    const { collection } = await api('GET', `/collections/${encodeURIComponent(collectionUid)}`);
    const stats = { requests: 0, defaults: 0, alternates: 0, scenariosKept: 0 };
    const walk = items => {
      for (const item of items ?? []) {
        if (item.item) { walk(item.item); continue; }
        const responses = item.response ?? [];
        if (!responses.length) continue;
        stats.requests++;
        const path = (item.request?.url?.path ?? []).map(s => (s.startsWith(':') ? `{{${s.slice(1)}}}` : s));
        const generated = responses.filter(r => !String(r.name).includes(' :: '));
        stats.scenariosKept += responses.length - generated.length;
        const byCode = [...generated].sort((a, b) => a.code - b.code);
        const def = byCode.find(r => r.code >= 200 && r.code < 300) ?? byCode[0];
        for (const r of generated) {
          const isDefault = r === def;
          const query = isDefault ? [] : [{ key: '__example', value: String(r.code) }];
          const raw = `{{baseUrl}}/${path.join('/')}${query.length ? `?__example=${r.code}` : ''}`;
          r.originalRequest = {
            ...(r.originalRequest ?? {}),
            method: item.request.method,
            url: { raw, host: ['{{baseUrl}}'], path, ...(query.length ? { query } : {}) },
          };
          isDefault ? stats.defaults++ : stats.alternates++;
        }
      }
    };
    walk(collection.item);
    if (opts['dry-run'] !== 'true') {
      await api('PUT', `/collections/${encodeURIComponent(collectionUid)}`, { collection });
    }
    if (opts.out) {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify({ collection }, null, 2));
    }
    print({ ...stats, updated: opts['dry-run'] !== 'true', apiCalls: opts['dry-run'] === 'true' ? 1 : 2 });
  },

  async 'export-collection'([collectionId], opts) {
    if (!collectionId) fail('usage: export-collection <collectionId> [--out <file>]');
    const { collection } = await api('GET', `/collections/${encodeURIComponent(collectionId)}`);
    const out = opts.out ?? '.postman-mock/collection.json';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Same shape as the hub's cache (.postman-mock/collections/<uid>.json): the collection itself, not { collection }.
    fs.writeFileSync(out, JSON.stringify(collection, null, 2));
    let count = 0;
    const walk = items => (items ?? []).forEach(i => { count += (i.response ?? []).length; walk(i.item); });
    walk(collection.item);
    print({ out, examples: count });
  },

  async 'task-status'([specId, taskId]) {
    if (!specId || !taskId) fail('usage: task-status <specId> <taskId>');
    print(await api('GET', `/specs/${encodeURIComponent(specId)}/tasks/${encodeURIComponent(taskId)}`));
  },

  async request([method, urlPath], opts) {
    if (!method || !urlPath) fail('usage: request <METHOD> <path> [--data <json>|@<file>]');
    let body;
    if (opts.data) body = JSON.parse(opts.data.startsWith('@') ? fs.readFileSync(opts.data.slice(1), 'utf8') : opts.data);
    print(await api(method.toUpperCase(), urlPath, body));
  },
};

const [command, ...rest] = process.argv.slice(2);
if (!commands[command]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(command ? 1 : 0);
}
const { positional, opts } = flags(rest);
await commands[command](positional, opts);
