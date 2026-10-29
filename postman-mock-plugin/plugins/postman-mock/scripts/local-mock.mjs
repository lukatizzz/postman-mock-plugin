#!/usr/bin/env node
// Local mock server that serves the saved examples of an exported Postman
// collection (v2.1), approximating Postman's mock matching algorithm.
// No dependencies; requires Node 18+.
//
// Usage:
//   node local-mock.mjs --collection .postman-mock/collection.json [--port 4010] [--match-body] [--delay 0]

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SCORE = { CASE: 10, WILDCARD: 20, ID_LIKE: 21, TRAILING_SLASH: 5, QUERY: 10 };

// Postman treats two different "ID-looking" segments (numbers, UUIDs, digit-bearing tokens) as a fuzzy match.
const ID_LIKE = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-z0-9_-]*\d)[a-z0-9_-]{6,})$/i;

// ---------- collection loading ----------

export function loadCollection(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  // GET /collections/{id} wraps the collection in { collection: ... }
  return json.collection ?? json;
}

export function extractExamples(collection) {
  const variables = Object.fromEntries((collection.variable ?? []).map(v => [v.key, v.value]));
  const examples = [];
  const walk = items => {
    for (const item of items ?? []) {
      if (item.item) walk(item.item);
      for (const res of item.response ?? []) {
        const req = res.originalRequest ?? item.request ?? {};
        examples.push({
          id: res.id ?? res.uid ?? null,
          name: res.name ?? '',
          requestName: item.name,
          method: (req.method ?? item.request?.method ?? 'GET').toUpperCase(),
          path: urlPath(req.url ?? item.request?.url, variables),
          query: urlQuery(req.url ?? item.request?.url),
          headers: Object.fromEntries((req.header ?? []).filter(h => !h.disabled).map(h => [h.key.toLowerCase(), String(h.value)])),
          requestBody: req.body?.mode === 'raw' ? req.body.raw ?? '' : '',
          code: Number(res.code ?? 200),
          responseHeaders: (res.header ?? []).filter(h => !h.disabled),
          body: res.body ?? '',
          order: examples.length,
        });
      }
    }
  };
  walk(collection.item);
  return { examples, variables };
}

const resolveVars = (s, variables) => s.replace(/\{\{([^}$]+)\}\}/g, (m, k) => (k in variables ? String(variables[k]) : m));

// Path segments of a resolved base URL such as https://api.example.com/v1 or /api/v1 -> ['v1'] / ['api', 'v1'].
function basePathSegments(host) {
  if (host.startsWith('/')) return host.split(/[?#]/)[0].split('/').filter(Boolean);
  const m = host.match(/^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i) ?? host.match(/^[^/{}]+(\/[^?#]*)?$/);
  return (m?.[1] ?? '').split('/').filter(Boolean);
}

// Returns the path the mock is called with, including the base path of {{baseUrl}}
// (Postman resolves collection variables before matching).
// A segment is { value } for literals or { wildcard: true, value? } for path variables;
// Postman treats a path variable's saved value as a literal when the request uses that exact value.
function urlPath(url, variables) {
  let segments;
  if (!url) return { segments: [], trailingSlash: false };
  const pathVars = Object.fromEntries((url.variable ?? []).map(v => [v.key, v.value]));
  if (typeof url === 'string' || !url.path) {
    let raw = resolveVars((typeof url === 'string' ? url : url.raw ?? '').split('?')[0], variables);
    raw = raw.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z]+:\/\/[^/]+/i, '');
    segments = raw.split('/').filter((s, i, a) => s !== '' || i === a.length - 1);
  } else {
    const host = resolveVars(Array.isArray(url.host) ? url.host.join('.') : url.host ?? '', variables);
    segments = [...basePathSegments(host), ...(Array.isArray(url.path) ? url.path : String(url.path).split('/'))];
  }
  const trailingSlash = segments.length > 0 && segments[segments.length - 1] === '';
  if (trailingSlash) segments.pop();
  return {
    trailingSlash,
    segments: segments.filter(s => s !== '').map(s => {
      const v = s.match(/^\{\{(.+)\}\}$/);
      if (v) return v[1] in variables ? { value: String(variables[v[1]]) } : { wildcard: true };
      if (s.startsWith(':')) {
        const saved = pathVars[s.slice(1)];
        return saved ? { wildcard: true, value: String(saved) } : { wildcard: true };
      }
      return { value: s };
    }),
  };
}

function urlQuery(url) {
  if (!url) return [];
  if (typeof url === 'string' || !url.query) {
    const raw = typeof url === 'string' ? url : url.raw ?? '';
    const q = raw.split('?')[1];
    return q ? [...new URLSearchParams(q)].map(([key, value]) => ({ key, value })) : [];
  }
  return url.query.filter(q => !q.disabled).map(q => ({ key: q.key, value: q.value ?? '' }));
}

// ---------- matching ----------

function scorePath(example, reqSegments, reqTrailingSlash) {
  const ex = example.path.segments;
  if (ex.length !== reqSegments.length) return null;
  let caseMismatch = false, wildcard = false, idLike = false;
  for (let i = 0; i < ex.length; i++) {
    if (ex[i].wildcard) {
      if (ex[i].value !== reqSegments[i]) wildcard = true;
      continue;
    }
    const want = safeDecode(ex[i].value), got = reqSegments[i];
    if (want === got) continue;
    if (want.toLowerCase() === got.toLowerCase()) { caseMismatch = true; continue; }
    if (ID_LIKE.test(want) && ID_LIKE.test(got)) { idLike = true; continue; }
    return null;
  }
  let score = 100;
  if (caseMismatch) score -= SCORE.CASE;
  if (wildcard) score -= SCORE.WILDCARD;
  else if (idLike) score -= SCORE.ID_LIKE;
  if (reqTrailingSlash !== example.path.trailingSlash) score -= SCORE.TRAILING_SLASH;
  return score;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function scoreQuery(example, reqQuery) {
  let matches = 0, partial = 0, missing = 0;
  const reqKeys = new Set(reqQuery.keys());
  for (const { key, value } of example.query) {
    if (!reqQuery.has(key)) { missing++; continue; }
    reqKeys.delete(key);
    if (reqQuery.get(key) === value) matches++; else partial++;
  }
  missing += reqKeys.size;
  const total = matches + partial + missing;
  // Verified on Postman: a key with a different value still beats a missing key.
  return { pct: total === 0 ? 1 : (matches + partial * 0.5) / total, partial };
}

function bodiesEqual(exampleBody, requestBody) {
  try {
    return JSON.stringify(sortKeys(JSON.parse(exampleBody))) === JSON.stringify(sortKeys(JSON.parse(requestBody)));
  } catch {
    return exampleBody.trim() === requestBody.trim();
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

// req: { method, path, query: URLSearchParams, headers (lower-case keys), body }
// Returns { example } or { error, status }.
export function selectExample(examples, req, options = {}) {
  let candidates = examples.filter(e => e.method === req.method.toUpperCase());

  const code = req.headers['x-mock-response-code'];
  if (code) candidates = candidates.filter(e => String(e.code) === String(code));

  const id = req.headers['x-mock-response-id'];
  if (id) {
    const hit = candidates.find(e => e.id === id);
    return hit ? { example: hit } : notFound(`No example with id "${id}"`);
  }
  const name = headerText(req.headers['x-mock-response-name']);
  if (name) {
    const hits = candidates.filter(e => e.name === name);
    return hits.length ? { example: preferOk(hits) } : notFound(`No example named "${name}"`);
  }

  const trailingSlash = req.path.length > 1 && req.path.endsWith('/');
  const reqSegments = req.path.split('/').filter(Boolean).map(safeDecode);
  const matchBody = (req.headers['x-mock-match-request-body'] ?? String(!!options.matchBody)) === 'true';
  const matchHeaders = (req.headers['x-mock-match-request-headers'] ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const scored = [];
  for (const e of candidates) {
    let score = scorePath(e, reqSegments, trailingSlash);
    if (score === null) continue;
    const q = scoreQuery(e, req.query);
    score -= (1 - q.pct) * SCORE.QUERY;
    if (matchHeaders.some(h => e.headers[h] !== undefined && e.headers[h] !== req.headers[h])) continue;
    if (e.requestBody && req.body) {
      const same = bodiesEqual(e.requestBody, req.body);
      if (matchBody && !same) continue;
      if (same) score += 1;
    }
    scored.push({ e, score, partial: q.partial });
  }
  if (!scored.length) return notFound(`No example matches ${req.method} ${req.path}`);
  scored.sort((a, b) =>
    b.score - a.score || a.partial - b.partial ||
    (a.e.code === 200 ? 0 : 1) - (b.e.code === 200 ? 0 : 1) || a.e.order - b.e.order);
  return { example: scored[0].e };
}

// Node decodes header bytes as latin1; restore UTF-8 names (e.g. Japanese) and accept %-encoded ones.
function headerText(value) {
  if (!value) return value;
  const utf8 = /[\u0080-ÿ]/.test(value) ? Buffer.from(value, 'latin1').toString('utf8') : value;
  return /%[0-9a-f]{2}/i.test(utf8) ? safeDecode(utf8) : utf8;
}

function preferOk(list) {
  return list.find(e => e.code === 200) ?? list[0];
}

function notFound(message) {
  return { status: 404, error: { name: 'mockRequestNotFoundError', message } };
}

// ---------- response templating ----------

const FIRST_NAMES = ['Minh', 'Lan', 'Huy', 'Mai', 'Alex', 'Sam'];
const LAST_NAMES = ['Nguyen', 'Tran', 'Le', 'Pham', 'Smith', 'Lee'];
const pick = a => a[Math.floor(Math.random() * a.length)];

export function renderBody(body, req, variables = {}) {
  const parsedBody = (() => {
    try { return JSON.parse(req.body || 'null'); } catch { return null; }
  })();
  const segments = req.path.split('/').filter(Boolean);
  const dynamic = {
    $randomUUID: () => crypto.randomUUID(),
    $guid: () => crypto.randomUUID(),
    $timestamp: () => String(Math.floor(Date.now() / 1000)),
    $isoTimestamp: () => new Date().toISOString(),
    $randomInt: () => String(Math.floor(Math.random() * 1001)),
    $randomBoolean: () => String(Math.random() < 0.5),
    $randomFirstName: () => pick(FIRST_NAMES),
    $randomLastName: () => pick(LAST_NAMES),
    $randomFullName: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`,
    $randomEmail: () => `${pick(FIRST_NAMES).toLowerCase()}${Math.floor(Math.random() * 1000)}@example.com`,
  };
  return String(body).replace(/\{\{\s*(\$?[\w.-]+)((?:\s+'[^']*')*)\s*\}\}/g, (whole, name, rawArgs) => {
    const args = [...rawArgs.matchAll(/'([^']*)'/g)].map(m => m[1]);
    switch (name) {
      case '$body': {
        if (!args.length) return req.body ?? '';
        const v = args[0].split('.').reduce((o, k) => (o == null ? undefined : o[k]), parsedBody);
        return v === undefined ? (args[1] ?? '') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      case '$queryParams': return req.query.get(args[0]) ?? args[1] ?? '';
      case '$headers': return req.headers[(args[0] ?? '').toLowerCase()] ?? args[1] ?? '';
      case '$pathSegments': return segments[Number(args[0])] ?? args[1] ?? '';
    }
    if (dynamic[name]) return dynamic[name]();
    if (name in variables) return String(variables[name]);
    return whole;
  });
}

// ---------- server ----------

export function createServer({ collection, matchBody = false, delay = 0, log = console.log }) {
  let cache = { mtime: 0, examples: [], variables: {} };
  const load = () => {
    const mtime = fs.statSync(collection).mtimeMs;
    if (mtime !== cache.mtime) cache = { mtime, ...extractExamples(loadCollection(collection)) };
    return cache;
  };
  load();

  return http.createServer((request, response) => {
    handle(request, response).catch(err => {
      log(`${request.method} ${request.url} -> 500 ${err.message}`);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { name: 'localMockError', message: err.message } }));
    });
  });

  async function handle(request, response) {
    const cors = {
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
      'access-control-expose-headers': '*',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();
      return;
    }
    const chunks = [];
    for await (const c of request) chunks.push(c);
    const url = new URL(request.url, 'http://localhost');
    const req = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };

    const { examples, variables } = load();
    const result = selectExample(examples, req, { matchBody });
    const wait = Number(req.headers['x-mock-response-delay'] ?? delay) || 0;
    if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 180000)));

    if (result.error) {
      log(`${req.method} ${req.path} -> 404 (no match)`);
      response.writeHead(result.status, { ...cors, 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: result.error }));
      return;
    }
    const e = result.example;
    log(`${req.method} ${req.path} -> ${e.code} "${e.name}"`);
    const headers = { ...cors };
    for (const h of e.responseHeaders) {
      if (!['content-length', 'transfer-encoding', 'connection'].includes(h.key.toLowerCase())) headers[h.key] = h.value;
    }
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type') && /^\s*[[{]/.test(e.body)) {
      headers['content-type'] = 'application/json';
    }
    response.writeHead(e.code, headers);
    response.end(e.code === 204 || e.code === 304 ? undefined : renderBody(e.body, req, variables));
  }
}

function parseArgs(argv) {
  const opts = { collection: '.postman-mock/collection.json', port: 4010, matchBody: false, delay: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') opts.collection = argv[++i];
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--match-body') opts.matchBody = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node local-mock.mjs --collection <file> [--port 4010] [--match-body] [--delay ms]');
    process.exit(0);
  }
  if (!fs.existsSync(opts.collection)) {
    console.error(`Collection file not found: ${opts.collection}`);
    process.exit(1);
  }
  createServer(opts).listen(opts.port, () => {
    const { examples } = extractExamples(loadCollection(opts.collection));
    console.log(`Local mock on http://localhost:${opts.port} serving ${examples.length} examples from ${opts.collection}`);
  });
}
