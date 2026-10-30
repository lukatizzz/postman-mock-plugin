// Answers mock requests directly from a definition (mock-store.mjs) and the collection's examples.
// No Postman runtime involved: edits apply immediately. No dependencies; Node 18+.
//
// Resolution for an API in flow F (F = header x-mock-scenario, else the definition's activeFlow):
//   F's cases (first match) -> F's response -> default cases -> default response -> collection example.
// A flow entry with enabled:false is skipped. Example selection when no mock data applies:
//   x-mock-response-name: <example name>  ->  that example (scenario examples "... :: ..." included)
//   x-mock-response-code: <status>        ->  the example with that status
//   otherwise                             ->  the lowest 2xx example
// Request headers: x-mock-scenario, x-mock-response-code, x-mock-response-name, x-mock-response-delay.

import crypto from 'node:crypto';
import { allFlows, pathRegex, pathParams } from './mock-store.mjs';

// ---------- conditions ----------

function getPath(obj, p) { return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

export function eq(actual, expected) {
  if (expected === '*') return actual !== undefined && actual !== null && actual !== '';
  if (expected !== null && typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(expected);
  return actual !== undefined && actual !== null && String(actual) === String(expected);
}

function matches(when, ctx) {
  for (const [k, v] of Object.entries(when.params ?? {})) if (!eq(ctx.params[k], v)) return false;
  for (const [k, v] of Object.entries(when.query ?? {})) if (!eq(ctx.query.get(k), v)) return false;
  for (const [k, v] of Object.entries(when.headers ?? {})) if (!eq(ctx.headers[k.toLowerCase()], v)) return false;
  for (const [k, v] of Object.entries(when.body ?? {})) if (!eq(getPath(ctx.body(), k), v)) return false;
  return true;
}

// Steps of one API in one flow, in the order they are tried.
export function resolutionChain(api, flow) {
  const steps = [];
  const add = (entry, label) => {
    if (!entry || entry.enabled === false) return;
    for (const c of entry.cases ?? []) if (c.enabled !== false) steps.push({ when: c.when, response: c.response, label: `${label} case "${c.name}"` });
    if (entry.response) steps.push({ response: entry.response, label: `${label} data` });
  };
  if (flow !== 'default') add(api?.flows?.[flow], `flow ${flow}`);
  add(api?.flows?.default, 'default');
  return steps;
}

// ---------- dynamic values ----------

const FIRST = ['Minh', 'Lan', 'Huy', 'Mai', 'Alex', 'Sam'], LAST = ['Nguyen', 'Tran', 'Le', 'Pham', 'Smith', 'Lee'];
const pick = a => a[Math.floor(Math.random() * a.length)];

export function render(text, ctx) {
  const segments = ctx.fullPath.split('/').filter(Boolean);
  const dynamic = {
    $randomUUID: () => crypto.randomUUID(), $guid: () => crypto.randomUUID(),
    $timestamp: () => String(Math.floor(Date.now() / 1000)), $isoTimestamp: () => new Date().toISOString(),
    $randomInt: () => String(Math.floor(Math.random() * 1001)), $randomBoolean: () => String(Math.random() < 0.5),
    $randomFirstName: () => pick(FIRST), $randomLastName: () => pick(LAST), $randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
    $randomEmail: () => `${pick(FIRST).toLowerCase()}${Math.floor(Math.random() * 1000)}@example.com`,
  };
  return String(text).replace(/\{\{\s*(\$?[\w.-]+)((?:\s+'[^']*')*)\s*\}\}/g, (whole, name, rawArgs) => {
    const a = [...rawArgs.matchAll(/'([^']*)'/g)].map(m => m[1]);
    switch (name) {
      case '$body': {
        if (!a.length) return ctx.bodyText ?? '';
        const v = getPath(ctx.body(), a[0]);
        return v === undefined ? (a[1] ?? '') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      case '$queryParams': return ctx.query.get(a[0]) ?? a[1] ?? '';
      case '$headers': return ctx.headers[(a[0] ?? '').toLowerCase()] ?? a[1] ?? '';
      case '$pathSegments': return segments[Number(a[0])] ?? a[1] ?? '';
      case '$pathParams': return ctx.params[a[0]] ?? a[1] ?? '';
    }
    return dynamic[name] ? dynamic[name]() : whole;
  });
}

// ---------- request handling ----------

const isScenario = x => String(x.name ?? '').includes(' :: ');

function fromStep(r) {
  const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return { status: r.status ?? 200, headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) }, body, delayMs: r.delayMs ?? 0 };
}

function fromExample(x) {
  const headers = Object.fromEntries((x.headers ?? []).filter(h => !/^(content-length|transfer-encoding|connection)$/i.test(h.key)).map(h => [h.key, String(h.value)]));
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type') && /^\s*[[{]/.test(x.body ?? '')) headers['Content-Type'] = 'application/json';
  return { status: x.status, headers, body: x.body ?? '', delayMs: 0 };
}

function pickExample(examples, headers) {
  const name = headers['x-mock-response-name'];
  if (name) return examples.find(x => x.name === name) ?? null;
  const code = headers['x-mock-response-code'];
  const plain = examples.filter(x => !isScenario(x));
  if (code) return plain.find(x => String(x.status) === String(code)) ?? examples.find(x => String(x.status) === String(code)) ?? null;
  const sorted = [...plain].sort((a, b) => a.status - b.status);
  return sorted.find(x => x.status >= 200 && x.status < 300) ?? sorted[0] ?? null;
}

/**
 * @param def        mock definition (v2)
 * @param endpoints  [{ key, method, path, examples: [{ name, status, body, headers }] }]
 * @param req        { method, path (without the API base path), fullPath, query: URLSearchParams, headers (lower-case), bodyText }
 * @returns { status, headers, body, delayMs, trace: { api, flow, source } }
 */
export function respond(def, endpoints, req) {
  const api = endpoints.find(e => e.method === req.method.toUpperCase() && pathRegex(e.path).test(req.path));
  if (!api) {
    return { status: 404, headers: { 'Content-Type': 'application/json' }, delayMs: 0,
      body: JSON.stringify({ error: 'mockRequestNotFoundError', message: `No API ${req.method} ${req.path} in the collection` }), trace: { api: null } };
  }
  const m = req.path.match(pathRegex(api.path));
  const params = Object.fromEntries(pathParams(api.path).map((p, i) => [p, decodeURIComponent(m[i + 1])]));
  let parsed;
  const ctx = {
    ...req, params,
    body: () => (parsed ??= (() => { try { return req.bodyText ? JSON.parse(req.bodyText) : {}; } catch { return {}; } })()),
  };
  const asked = req.headers['x-mock-scenario'] ?? def.activeFlow ?? 'default';
  const flow = allFlows(def).includes(asked) ? asked : 'default';
  // Explicit example requests bypass the mock data, like Postman's mock headers.
  const wantsExample = req.headers['x-mock-response-name'] || req.headers['x-mock-response-code'];
  let out, source;
  if (!wantsExample) {
    for (const step of resolutionChain(def.apis?.[api.key], flow)) {
      if (!step.when || matches(step.when, ctx)) { out = fromStep(step.response); source = step.label; break; }
    }
  }
  if (!out) {
    const ex = pickExample(api.examples ?? [], req.headers);
    if (!ex) {
      const why = req.headers['x-mock-response-name'] ? `no example named "${req.headers['x-mock-response-name']}"` : req.headers['x-mock-response-code'] ? `no example with status ${req.headers['x-mock-response-code']}` : 'no example';
      return { status: 404, headers: { 'Content-Type': 'application/json' }, delayMs: 0, body: JSON.stringify({ error: 'mockRequestNotFoundError', message: `${api.key}: ${why}` }), trace: { api: api.key, flow } };
    }
    out = fromExample(ex);
    source = `example "${ex.name}"`;
  }
  const delay = Number(req.headers['x-mock-response-delay'] ?? out.delayMs) || 0;
  return { ...out, body: out.status === 204 || out.status === 304 ? '' : render(out.body, ctx), delayMs: Math.min(delay, 180000), trace: { api: api.key, flow, source } };
}
