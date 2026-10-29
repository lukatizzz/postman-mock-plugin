// Data model for Postman code mocks, shared by the hub (dashboard + MCP) and app-mock.mjs.
// No dependencies; Node 18+.
//
// Definition (version 2), one file per mock: <project>/.postman-mock/code-mocks/<mock>.json
// {
//   "version": 2,
//   "name": "JumpApp code mock", "workspace": "<id>", "mockId": "<id>|null",
//   "source": { "collection": "<uid>" } | { "spec": "<path>" },
//   "basePath": "/api/v1", "stateful": false,
//   "realBaseUrl": "https://dev.example.com/api/v1",   // clients call it DIRECTLY for APIs in "real" mode
//   "defaultMode": "mock",
//   "activeFlow": "default",                           // flow the gateway serves when the client sends no header
//   "flows": ["qa-edge-cases"],                        // flows (scenarios) besides "default"
//   "retiredFlows": [],
//   "apis": {
//     "GET /constructions/:constructionNo": {
//       "mode": "mock" | "real",                       // optional, else defaultMode
//       "flows": {
//         "default": { "enabled": true, "response": {...}, "cases": [ { "name", "when", "response", "enabled" } ] },
//         "qa-edge-cases": { "enabled": false }          // disabled -> this API answers with the default flow's data
//       }
//     }
//   }
// }
// response: { "status": 200, "headers": {...}, "body": <json|string>, "delayMs": 0 }
// when (all given parts must match; "*" = present with any value):
//   { "params": { "constructionNo": "99999999" }, "query": { "searchWord": "none" },
//     "headers": { "x-role": "admin" }, "body": { "user.email": "a@b.c" } }
// Resolution for a request in flow F: F's cases (in order) -> F's response -> default cases -> default
// response -> the collection example. A disabled flow entry is skipped.

export const FLOW_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const API_KEY = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/\S*$/;

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => { throw new StoreError(400, msg); };

export function pathRegex(p) {
  return new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '([^/]+)') + '/?$');
}
export const pathParams = p => [...p.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]);

export function findApi(endpoints, method, pathname) {
  return endpoints.find(e => e.method === method && pathRegex(e.path).test(pathname));
}

// ---------- validation ----------

export function cleanResponse(r) {
  if (!r || typeof r !== 'object') bad('response must be an object');
  const status = Number(r.status ?? 200);
  if (!Number.isInteger(status) || status < 100 || status > 599) bad(`invalid status ${r.status}`);
  const out = { status };
  if (r.headers && Object.keys(r.headers).length) {
    if (typeof r.headers !== 'object') bad('response.headers must be an object');
    out.headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, String(v)]));
  }
  if (r.body !== undefined && r.body !== null && r.body !== '') out.body = r.body;
  if (Number(r.delayMs) > 0) out.delayMs = Math.min(Number(r.delayMs), 60000);
  return out;
}

export function cleanWhen(w, apiPath) {
  if (!w) return undefined;
  if (typeof w !== 'object') bad('when must be an object');
  const out = {};
  const params = pathParams(apiPath);
  for (const part of ['params', 'query', 'headers', 'body']) {
    const v = w[part];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'object' || Array.isArray(v)) bad(`when.${part} must be an object of field -> value`);
    if (!Object.keys(v).length) continue;
    if (part === 'params') for (const k of Object.keys(v)) if (!params.includes(k)) bad(`unknown path param "${k}" (this API has: ${params.join(', ') || 'none'})`);
    out[part] = part === 'headers'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toLowerCase(), String(x)]))
      : part === 'body' ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanCase(c, apiPath) {
  if (!c || typeof c !== 'object') bad('case must be an object');
  const name = String(c.name ?? '').trim();
  if (!name) bad('case.name is required');
  const when = cleanWhen(c.when, apiPath);
  if (!when) bad(`case "${name}" needs at least one condition in "when" (otherwise use the flow response)`);
  const out = { name, when, response: cleanResponse(c.response ?? c) };
  if (c.enabled === false) out.enabled = false;
  if (c.note) out.note = String(c.note);
  return out;
}

export function cleanFlowEntry(entry, apiPath) {
  const out = {};
  if (entry.enabled === false) out.enabled = false;
  if (entry.response) out.response = cleanResponse(entry.response);
  const cases = (entry.cases ?? []).map(c => cleanCase(c, apiPath));
  const names = new Set();
  for (const c of cases) { if (names.has(c.name)) bad(`duplicate case name "${c.name}"`); names.add(c.name); }
  if (cases.length) out.cases = cases;
  return out;
}

// ---------- definition helpers ----------

export function ensureV2(def) {
  if (def.version === 2) return def;
  def.version = 2;
  def.apis ??= {};
  def.flows = Object.keys(def.scenarios ?? {});
  def.retiredFlows = def.retiredScenarios ?? [];
  def.activeFlow = def.activeScenario ?? 'default';
  def._legacy = { defaults: def.defaults ?? [], scenarios: def.scenarios ?? {}, endpoints: def.endpoints ?? {} };
  delete def.defaults; delete def.scenarios; delete def.retiredScenarios; delete def.activeScenario; delete def.endpoints;
  return def;
}

// v1 overrides were { method, path (pattern or literal), query?, status, body, ... }; map them onto APIs.
export function migrateLegacy(def, endpoints) {
  const legacy = def._legacy;
  if (!legacy) return false;
  const place = (flow, o) => {
    const api = endpoints.find(e => e.method === o.method && (e.path === o.path || pathRegex(e.path).test(o.path)));
    if (!api) return;
    const entry = flowEntry(def, api.key, flow, true);
    const response = cleanResponse(o);
    const when = {};
    if (o.path !== api.path) {
      const m = o.path.match(pathRegex(api.path));
      when.params = Object.fromEntries(pathParams(api.path).map((p, i) => [p, decodeURIComponent(m[i + 1])]));
    }
    if (o.query && Object.keys(o.query).length) when.query = o.query;
    if (Object.keys(when).length) (entry.cases ??= []).push({ name: `case ${(entry.cases?.length ?? 0) + 1}`, when, response, ...(o.enabled === false ? { enabled: false } : {}) });
    else entry.response = response;
  };
  for (const o of legacy.defaults) place('default', o);
  for (const [flow, list] of Object.entries(legacy.scenarios)) for (const o of list) place(flow, o);
  for (const [key, v] of Object.entries(legacy.endpoints)) if (v.mode) (def.apis[key] ??= { flows: {} }).mode = v.mode;
  delete def._legacy;
  return true;
}

export function allFlows(def) { return ['default', ...(def.flows ?? [])]; }

export function checkFlow(def, flow) {
  if (!allFlows(def).includes(flow)) throw new StoreError(404, `No flow "${flow}" (flows: ${allFlows(def).join(', ')})`);
}

export function checkApi(endpoints, key) {
  const api = endpoints.find(e => e.key === key);
  if (!api) throw new StoreError(404, `No API "${key}". Use list_apis to see the keys (format "METHOD /path/:param").`);
  return api;
}

export function flowEntry(def, key, flow, create = false) {
  const api = def.apis?.[key];
  if (!create) return api?.flows?.[flow];
  def.apis ??= {};
  const a = (def.apis[key] ??= { flows: {} });
  a.flows ??= {};
  return (a.flows[flow] ??= {});
}

function prune(def, key) {
  const a = def.apis?.[key];
  if (!a) return;
  for (const [f, e] of Object.entries(a.flows ?? {})) {
    if (!e.response && !(e.cases?.length) && e.enabled !== false) delete a.flows[f];
  }
  if (!a.mode && !Object.keys(a.flows ?? {}).length) delete def.apis[key];
}

// ---------- operations (used by the dashboard API and the MCP tools) ----------

export const ops = {
  setFlowEntry(def, api, flow, entry) {
    checkFlow(def, flow);
    const clean = cleanFlowEntry(entry ?? {}, api.path);
    def.apis ??= {};
    const a = (def.apis[api.key] ??= { flows: {} });
    a.flows = { ...(a.flows ?? {}), [flow]: clean };
    prune(def, api.key);
  },
  setResponse(def, api, flow, response) {
    checkFlow(def, flow);
    flowEntry(def, api.key, flow, true).response = cleanResponse(response);
  },
  clearResponse(def, api, flow) {
    checkFlow(def, flow);
    const e = flowEntry(def, api.key, flow);
    if (e) delete e.response;
    prune(def, api.key);
  },
  upsertCase(def, api, flow, c, position) {
    checkFlow(def, flow);
    const clean = cleanCase(c, api.path);
    const e = flowEntry(def, api.key, flow, true);
    e.cases ??= [];
    const i = e.cases.findIndex(x => x.name === clean.name);
    if (i >= 0) e.cases[i] = clean;
    else if (Number.isInteger(position)) e.cases.splice(Math.max(0, position), 0, clean);
    else e.cases.push(clean);
    return clean;
  },
  removeCase(def, api, flow, name) {
    checkFlow(def, flow);
    const e = flowEntry(def, api.key, flow);
    const i = e?.cases?.findIndex(x => x.name === name) ?? -1;
    if (i < 0) throw new StoreError(404, `No case "${name}" in ${api.key} / ${flow}`);
    e.cases.splice(i, 1);
    prune(def, api.key);
  },
  setEnabled(def, api, flow, enabled) {
    checkFlow(def, flow);
    const e = flowEntry(def, api.key, flow, true);
    if (enabled) delete e.enabled; else e.enabled = false;
    prune(def, api.key);
  },
  setMode(def, key, mode) {
    if (!['mock', 'real', 'inherit'].includes(mode)) bad('mode must be mock, real or inherit');
    def.apis ??= {};
    const a = (def.apis[key] ??= { flows: {} });
    if (mode === 'inherit') delete a.mode; else a.mode = mode;
    prune(def, key);
  },
  setAllModes(def, mode) {
    if (!['mock', 'real'].includes(mode)) bad('mode must be mock or real');
    def.defaultMode = mode;
    for (const key of Object.keys(def.apis ?? {})) { delete def.apis[key].mode; prune(def, key); }
  },
  addFlow(def, flow) {
    if (!FLOW_NAME.test(flow) || flow === 'default') bad('flow names: lower-case ASCII, digits and dashes (not "default")');
    if (!(def.flows ?? []).includes(flow)) def.flows = [...(def.flows ?? []), flow];
    def.retiredFlows = (def.retiredFlows ?? []).filter(f => f !== flow);
  },
  removeFlow(def, flow) {
    if (flow === 'default') bad('the default flow cannot be removed');
    checkFlow(def, flow);
    def.flows = def.flows.filter(f => f !== flow);
    def.retiredFlows = [...new Set([...(def.retiredFlows ?? []), flow])];
    for (const key of Object.keys(def.apis ?? {})) { delete def.apis[key].flows?.[flow]; prune(def, key); }
    if (def.activeFlow === flow) def.activeFlow = 'default';
  },
  setSettings(def, s) {
    if (s.realBaseUrl !== undefined) {
      if (s.realBaseUrl && !/^https?:\/\/[^\s]+$/.test(s.realBaseUrl)) bad('realBaseUrl must start with http:// or https://');
      def.realBaseUrl = s.realBaseUrl.replace(/\/$/, '');
    }
    if (s.defaultMode !== undefined) {
      if (!['mock', 'real'].includes(s.defaultMode)) bad('defaultMode must be mock or real');
      def.defaultMode = s.defaultMode;
    }
    if (s.activeFlow !== undefined) { checkFlow(def, s.activeFlow); def.activeFlow = s.activeFlow; }
    if (s.runnerPort !== undefined) def.runnerPort = Number(s.runnerPort) || undefined;
  },
};

export function modeOf(def, key) {
  return def.apis?.[key]?.mode ?? def.defaultMode ?? 'mock';
}

// Routing table for client apps: real-mode APIs go straight to realBaseUrl, the rest to the mock gateway.
export function routes(def, endpoints, gatewayBase) {
  return {
    mock: def.name,
    mockBaseUrl: gatewayBase,
    realBaseUrl: def.realBaseUrl || null,
    defaultMode: def.defaultMode ?? 'mock',
    routes: endpoints.map(e => {
      const mode = modeOf(def, e.key);
      return { method: e.method, path: e.path, mode, baseUrl: mode === 'real' && def.realBaseUrl ? def.realBaseUrl : gatewayBase };
    }),
  };
}

// Small ES module a client app can import in development: baseUrlFor(method, path).
export function clientModule(r) {
  const fallback = r.defaultMode === 'real' && r.realBaseUrl ? r.realBaseUrl : r.mockBaseUrl;
  return `// Generated by the mock hub for "${r.mock}". Development only.
export const routes = ${JSON.stringify(r.routes.map(({ method, path, baseUrl }) => ({ method, path, baseUrl })))};
export const mockBaseUrl = ${JSON.stringify(r.mockBaseUrl)};
export const realBaseUrl = ${JSON.stringify(r.realBaseUrl)};
const same = (pattern, path) => {
  const a = pattern.split('/'), b = path.replace(/\\/$/, '').split('/');
  return a.length === b.length && a.every((s, i) => s.startsWith(':') ? b[i] !== '' : s === b[i]);
};
/** Base URL to use for METHOD + path (path without the API base path, e.g. "/tasks"). */
export function baseUrlFor(method, path) {
  const p = path.split('?')[0];
  const hit = routes.find(r => r.method === method.toUpperCase() && same(r.path, p));
  return hit ? hit.baseUrl : ${JSON.stringify(fallback)};
}
/** Full URL, e.g. urlFor('GET', '/tasks?page=2'). */
export const urlFor = (method, path) => baseUrlFor(method, path) + path;
`;
}

// Everything that ends up in the pushed code (not modes / gateway settings), to show "not pushed yet".
export function definitionHash(def) {
  const relevant = JSON.stringify([def.name, def.source, def.stateful, def.basePath, def.idField, def.flows, def.retiredFlows,
    Object.fromEntries(Object.entries(def.apis ?? {}).map(([k, a]) => [k, a.flows ?? {}]))]);
  let h = 0;
  for (let i = 0; i < relevant.length; i++) h = (h * 31 + relevant.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
