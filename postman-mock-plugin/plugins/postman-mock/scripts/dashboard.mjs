#!/usr/bin/env node
// Mock hub: dashboard + MCP server + dev gateway for Postman code mocks. No dependencies; Node 18+.
//
// Local (one project = the current folder, http://127.0.0.1 only, no login):
//   node dashboard.mjs [--port 4800] [--root <project dir>] [--project <name>]
// Shared team hub (several projects, token login, reachable on the network):
//   node dashboard.mjs --hub hub.json
//   node dashboard.mjs --hub hub.json --new-token <person> [--projects a,b]   prints a token once, stores its hash
//
// hub.json: { "host": "0.0.0.0", "port": 4800, "publicUrl": "http://mock-hub.local:4800",
//             "dataDir": "./projects", "defaultWorkspace": "<postman workspace id>",
//             "projects": { "jumpapp": { "root": "C:/work/jumpapp" } },
//             "tokens": [ { "name": "loi", "sha256": "...", "projects": ["*"] } ] }
//
//   /                          dashboard (edit mock data per API / flow / case, enable per flow, modes, push)
//   /mcp                       MCP endpoint (streamable HTTP, JSON responses) - tools to create mock data
//   /gw/<project>/<mock>/...   gateway for client apps: serves the MOCK side; APIs switched to "real"
//                              are answered with 307 to realBaseUrl - clients should call those directly,
//                              using /gw/<project>/<mock>/__routes (JSON) or /__client.js (baseUrlFor()).
// Postman's mock sandbox blocks outbound network, so "real" can never be done inside the mock code.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudPush } from './app-mock.mjs';
import { syncFromSpec, orphansOf, schemaWarnings, resolveOrphan, fileHash } from './spec-sync.mjs';
import {
  ensureV2, migrateLegacy, ops, routes, clientModule, definitionHash, modeOf, allFlows,
  findApi, checkApi, pathRegex, FLOW_NAME, StoreError,
} from './mock-store.mjs';

const VERSION = '0.3.0';
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

// ---------- configuration ----------

const hubFile = opt('hub') ? path.resolve(opt('hub')) : null;
const readHub = () => JSON.parse(fs.readFileSync(hubFile, 'utf8'));
const writeHub = h => fs.writeFileSync(hubFile, JSON.stringify(h, null, 2) + '\n');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

if (hubFile && opt('new-token')) {
  const hub = readHub();
  const token = 'mh_' + crypto.randomBytes(24).toString('base64url');
  const projects = (opt('projects') ?? '*').split(',').map(s => s.trim()).filter(Boolean);
  hub.tokens = [...(hub.tokens ?? []).filter(t => t.name !== opt('new-token')), { name: opt('new-token'), sha256: sha256(token), projects }];
  writeHub(hub);
  console.log(`Token for ${opt('new-token')} (projects: ${projects.join(', ')}). Shown once - store it safely:\n${token}`);
  process.exit(0);
}

const HUB = hubFile ? readHub() : null;
const PORT = Number(opt('port', HUB?.port ?? 4800));
const HOST = HUB ? (HUB.host ?? '0.0.0.0') : '127.0.0.1';
const PUBLIC = (HUB?.publicUrl ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const LOCAL_ROOT = path.resolve(opt('root', process.cwd()));
const LOCAL_NAME = opt('project') ?? (path.basename(LOCAL_ROOT).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project');

function projectsMap() {
  if (!HUB) return { [LOCAL_NAME]: { root: LOCAL_ROOT } };
  return readHub().projects ?? {};
}
function project(name) {
  const p = projectsMap()[name];
  if (!p) throw new StoreError(404, `No project "${name}"`);
  const root = path.resolve(hubFile ? path.dirname(hubFile) : process.cwd(), p.root);
  return { name, root, defsDir: path.join(root, '.postman-mock', 'code-mocks') };
}
// Project-wide settings live in <project>/.postman-mock/state.json (shared with the other skills):
// workspaceId and realBaseUrl, so every mock of the project - including new ones - reuses them.
const stateFile = proj => path.join(proj.root, '.postman-mock', 'state.json');
function readProjectState(proj) {
  try { return JSON.parse(fs.readFileSync(stateFile(proj), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
function writeProjectState(proj, patch) {
  const next = { ...readProjectState(proj), ...patch };
  fs.mkdirSync(path.dirname(stateFile(proj)), { recursive: true });
  fs.writeFileSync(stateFile(proj), JSON.stringify(next, null, 2) + '\n');
  return next;
}
const defaultWorkspace = proj => readProjectState(proj).workspaceId ?? HUB?.defaultWorkspace ?? null;
// A mock's own realBaseUrl overrides the project's.
const effectiveReal = (proj, def) => def.realBaseUrl || readProjectState(proj).realBaseUrl || '';
const withReal = (proj, def) => ({ ...def, realBaseUrl: effectiveReal(proj, def) });

function setProjectRealBaseUrl(proj, url) {
  const probe = {};
  ops.setSettings(probe, { realBaseUrl: url ?? '' });   // same validation as per-mock values
  writeProjectState(proj, { realBaseUrl: probe.realBaseUrl });
  return probe.realBaseUrl;
}

// realScope "project" (default): save for the whole project and drop this mock's own value; "mock": this mock only.
function applySettings(proj, def, b) {
  const { realBaseUrl, realScope, ...rest } = b;
  if (realBaseUrl !== undefined) {
    if (realScope === 'mock') ops.setSettings(def, { realBaseUrl });
    else { setProjectRealBaseUrl(proj, realBaseUrl); def.realBaseUrl = ''; }
  }
  ops.setSettings(def, rest);
}

// ---------- auth ----------

function authenticate(req) {
  if (!HUB) return { name: 'local', projects: ['*'] };
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const t = m && (readHub().tokens ?? []).find(x => x.sha256 === sha256(m[1].trim()));
  if (!t) throw new StoreError(401, 'Missing or invalid token (Authorization: Bearer <token>)');
  return t;
}
const canAccess = (auth, name) => auth.projects.includes('*') || auth.projects.includes(name);
function guard(auth, name) {
  if (!canAccess(auth, name)) throw new StoreError(403, `Token "${auth.name}" has no access to project "${name}"`);
  return project(name);
}

// ---------- mocks ----------

const defPath = (proj, mock) => {
  if (!SLUG.test(mock)) throw new StoreError(400, `Invalid mock name "${mock}" (lower-case ASCII, digits, dashes)`);
  return path.join(proj.defsDir, `${mock}.json`);
};
const listMocks = proj => (fs.existsSync(proj.defsDir) ? fs.readdirSync(proj.defsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(s => SLUG.test(s)) : []);
const writeDef = (proj, mock, def) => fs.writeFileSync(defPath(proj, mock), JSON.stringify(def, null, 2) + '\n');

const endpointCache = new Map();

async function postmanApi(urlPath) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) throw new StoreError(500, 'POSTMAN_API_KEY is not set on the hub');
  const base = (process.env.POSTMAN_API_BASE_URL ?? 'https://api.getpostman.com').replace(/\/$/, '');
  const res = await fetch(base + urlPath, { headers: { 'X-Api-Key': key } });
  if (!res.ok) throw new StoreError(502, `Postman API ${urlPath} -> HTTP ${res.status}`);
  return res.json();
}

const normPath = segments => '/' + segments.filter(s => s !== '').map(s => s.replace(/^\{\{(.+)\}\}$/, ':$1')).join('/');

async function loadEndpoints(cacheKey, def, refresh) {
  const key = `${cacheKey}:${JSON.stringify(def.source)}`;
  if (!refresh && endpointCache.has(key)) return endpointCache.get(key);
  const endpoints = [];
  if (def.source?.collection) {
    const { collection } = await postmanApi(`/collections/${encodeURIComponent(def.source.collection)}`);
    const walk = (items, folder) => {
      for (const item of items ?? []) {
        if (item.item) { walk(item.item, item.name); continue; }
        const method = item.request?.method ?? 'GET';
        const p = normPath(item.request?.url?.path ?? []);
        const examples = (item.response ?? []).filter(r => !String(r.name).includes(' :: '))
          .map(r => ({ name: r.name, status: r.code, body: r.body ?? '' })).sort((a, b) => a.status - b.status);
        endpoints.push({ key: `${method} ${p}`, method, path: p, name: item.name, folder: folder ?? '', examples });
      }
    };
    walk(collection.item);
  } else if (def.mockId) {
    const r = spawnSync(`postman mock get ${def.mockId} --json`, { shell: true, encoding: 'utf8', windowsHide: true });
    const info = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    const seen = new Set();
    for (const sc of info.scenarios ?? []) for (const e of sc.endpoints ?? []) {
      const k = `${e.method} ${e.path}`;
      if (!seen.has(k)) { seen.add(k); endpoints.push({ key: k, method: e.method, path: e.path, name: '', folder: '', examples: [] }); }
    }
  }
  endpointCache.set(key, endpoints);
  return endpoints;
}

// Loads a definition (migrating v1 files on the fly) together with its API list.
async function loadMock(proj, mock, { refresh = false } = {}) {
  const file = defPath(proj, mock);
  if (!fs.existsSync(file)) throw new StoreError(404, `No mock "${mock}" in project "${proj.name}"`);
  const def = ensureV2(JSON.parse(fs.readFileSync(file, 'utf8')));
  const endpoints = await loadEndpoints(`${proj.name}/${mock}`, def, refresh);
  if (migrateLegacy(def, endpoints) || def.version !== JSON.parse(fs.readFileSync(file, 'utf8')).version) writeDef(proj, mock, def);
  return { def, endpoints };
}

// OpenAPI file behind a mock: its own "specFile", else the project's (when the mock uses the project's collection).
function specInfo(proj, def) {
  const st = readProjectState(proj);
  const file = def.specFile ?? (def.source?.collection && def.source.collection === st.collectionUid ? st.sourceSpec : null);
  if (!file || !def.source?.collection) return { file: file ?? null, syncable: false, changed: false };
  const full = path.resolve(proj.root, file);
  if (!fs.existsSync(full)) return { file, syncable: false, changed: false, error: 'file not found' };
  return { file, syncable: true, changed: fileHash(full) !== st.specHash, lastSyncAt: st.lastSpecSyncAt ?? null };
}

const syncs = new Map();

function startSync(proj, mock, { dryRun = false, force = false } = {}) {
  const k = `${proj.name}/${mock}`;
  const current = syncs.get(k);
  if (current?.running) return current;
  const def = ensureV2(JSON.parse(fs.readFileSync(defPath(proj, mock), 'utf8')));
  const spec = specInfo(proj, def);
  if (!spec.syncable) throw new StoreError(400, spec.file ? `Spec file not usable: ${spec.file} (${spec.error ?? 'mock is not built from a collection'})` : 'This mock has no OpenAPI file to sync from (set "specFile" in its definition or "sourceSpec" in state.json)');
  const job = { running: true, dryRun, log: [`Syncing from ${spec.file}${dryRun ? ' (dry run)' : ''}...`], report: null, error: null, at: new Date().toISOString() };
  syncs.set(k, job);
  job.done = (async () => {
    try {
      const r = await syncFromSpec({ projectRoot: proj.root, specFile: spec.file, collectionUid: def.source.collection, workspace: def.workspace, dryRun, force, log: m => job.log.push(m) });
      if (r.unchanged) { job.report = { unchanged: true }; job.log.push('The spec has not changed since the last sync.'); return; }
      const { endpoints, ...summary } = r;
      if (!dryRun) {
        for (const key of [...endpointCache.keys()]) if (key.includes(def.source.collection)) endpointCache.delete(key);
      }
      // Mock data of every mock in the project built on this collection.
      const mocks = listMocks(proj).map(m => {
        const d = ensureV2(JSON.parse(fs.readFileSync(defPath(proj, m), 'utf8')));
        if (d.source?.collection !== def.source.collection) return null;
        return { mock: m, orphans: orphansOf(d, endpoints, summary.renamed), schemaWarnings: schemaWarnings(d, endpoints) };
      }).filter(Boolean);
      job.report = { ...summary, mocks };
      job.log.push(`${dryRun ? 'Would change' : 'Synced'}: +${summary.added.length} / -${summary.removed.length} APIs, ${summary.renamed.length} renamed, ${summary.lostScenarios.length} scenario examples dropped.`);
      if (!dryRun) job.log.push('Push the code mocks to apply the new APIs/examples (orphaned data: see the report).');
    } catch (e) {
      job.error = e.message;
      job.log.push(`Error: ${e.message}`);
    } finally {
      job.running = false;
    }
  })();
  return job;
}

const publicJob = j => (j ? (({ done, ...rest }) => rest)(j) : null);

const gatewayBase = (proj, mock, def) =>`${PUBLIC}/gw/${proj.name}/${mock}${def.basePath ?? ''}`;

function summary(proj, mock, def) {
  const k = `${proj.name}/${mock}`;
  const runner = runners.get(k);
  return {
    project: proj.name, mock, name: def.name, mockId: def.mockId ?? null, postmanUrl: def.postmanUrl ?? null,
    pushedAt: def.pushedAt ?? null, dirty: !def.mockId || definitionHash(def) !== def.pushedHash,
    realBaseUrl: effectiveReal(proj, def), mockRealBaseUrl: def.realBaseUrl || '', projectRealBaseUrl: readProjectState(proj).realBaseUrl || '',
    realBaseUrlScope: def.realBaseUrl ? 'mock' : readProjectState(proj).realBaseUrl ? 'project' : 'none',
    defaultMode: def.defaultMode ?? 'mock', activeFlow: def.activeFlow ?? 'default',
    flows: allFlows(def), basePath: def.basePath ?? '',
    gateway: gatewayBase(proj, mock, def),
    routesUrl: `${PUBLIC}/gw/${proj.name}/${mock}/__routes`, clientModuleUrl: `${PUBLIC}/gw/${proj.name}/${mock}/__client.js`,
    runner: runner ? { status: runner.status, port: runner.port, log: runner.log.slice(-15) } : { status: 'stopped' },
    push: publicJob(pushes.get(k)),
    spec: specInfo(proj, def),
    sync: publicJob(syncs.get(k)),
  };
}

function apiView(def, e) {
  const a = def.apis?.[e.key] ?? {};
  return { key: e.key, method: e.method, path: e.path, name: e.name, folder: e.folder, mode: a.mode ?? null, effectiveMode: modeOf(def, e.key), flows: a.flows ?? {} };
}

async function createMock(proj, b) {
  const mock = String(b.mock ?? '').toLowerCase();
  if (!SLUG.test(mock)) throw new StoreError(400, 'mock: lower-case ASCII, digits and dashes');
  if (fs.existsSync(defPath(proj, mock))) throw new StoreError(409, `Mock "${mock}" already exists`);
  if (!b.collection && !b.spec) throw new StoreError(400, 'collection (Postman collection UID) or spec (path) is required');
  const workspace = b.workspace || defaultWorkspace(proj);
  if (!workspace) throw new StoreError(400, 'workspace is required (no default workspace for this project)');
  const def = {
    version: 2, name: b.name || mock, workspace, mockId: null,
    source: b.collection ? { collection: b.collection } : { spec: b.spec },
    ...(b.basePath ? { basePath: b.basePath } : {}),
    stateful: !!b.stateful, realBaseUrl: '', defaultMode: 'mock', activeFlow: 'default', flows: [], apis: {},
  };
  // A URL given when creating a mock becomes the project's default unless one is already saved.
  if (b.realBaseUrl) {
    if (!readProjectState(proj).realBaseUrl) setProjectRealBaseUrl(proj, b.realBaseUrl);
    else if (b.realBaseUrl.replace(/\/$/, '') !== readProjectState(proj).realBaseUrl) ops.setSettings(def, { realBaseUrl: b.realBaseUrl });
  }
  fs.mkdirSync(proj.defsDir, { recursive: true });
  writeDef(proj, mock, def);
  return summary(proj, mock, def);
}

// ---------- runner (cloud mock run locally) and push ----------

const runners = new Map();
const pushes = new Map();

const portOpen = port => new Promise(resolve => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function freePort(def) {
  if (def.runnerPort) return Number(def.runnerPort);
  const used = new Set([...runners.values()].filter(r => r.status !== 'stopped').map(r => r.port));
  for (let p = 4900; p < 5100; p++) if (!used.has(p) && !(await portOpen(p))) return p;
  throw new StoreError(503, 'No free port for the mock runner');
}

async function startRunner(proj, mock) {
  const k = `${proj.name}/${mock}`;
  const current = runners.get(k);
  if (current && current.status !== 'stopped') {
    for (let i = 0; i < 60 && current.status === 'starting'; i++) await new Promise(r => setTimeout(r, 500));
    return current;
  }
  const def = ensureV2(JSON.parse(fs.readFileSync(defPath(proj, mock), 'utf8')));
  if (!def.mockId) throw new StoreError(409, 'Push the mock to the cloud first');
  const port = await freePort(def);
  // Runs in the temp dir so the CLI never writes into a project.
  const child = spawn(`postman mock run ${def.mockId} --port ${port}`, { shell: true, cwd: os.tmpdir(), windowsHide: true, detached: process.platform !== 'win32' });
  const runner = { child, port, status: 'starting', log: [] };
  runners.set(k, runner);
  const onData = d => { runner.log.push(...String(d).split(/\r?\n/).filter(Boolean)); runner.log = runner.log.slice(-200); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', code => { runner.status = 'stopped'; runner.log.push(`[exited ${code}]`); });
  for (let i = 0; i < 60 && runner.status === 'starting'; i++) {
    if (await portOpen(port)) runner.status = 'running';
    else await new Promise(r => setTimeout(r, 500));
  }
  if (runner.status !== 'running') { stopRunner(proj, mock); throw new StoreError(502, `Mock did not start:\n${runner.log.join('\n')}`); }
  return runner;
}

// Stops only the process tree this hub started (never other Postman processes, e.g. the desktop app).
function stopRunner(proj, mock) {
  const runner = runners.get(`${proj.name}/${mock}`);
  if (!runner || runner.status === 'stopped') return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(runner.child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-runner.child.pid, 'SIGTERM');
  } catch { /* already gone */ }
  runner.status = 'stopped';
}

function startPush(proj, mock) {
  const k = `${proj.name}/${mock}`;
  const current = pushes.get(k);
  if (current?.running) return current;
  const job = { running: true, log: ['Building the mock code and pushing it to Postman cloud...'], result: null, error: null, at: new Date().toISOString() };
  pushes.set(k, job);
  job.done = (async () => {
    try {
      job.result = await cloudPush(defPath(proj, mock));
      job.log.push(`Pushed: ${job.result.created ? 'created' : 'updated'} ${job.result.mockId} (flows: ${job.result.flows.join(', ')})`);
      const runner = runners.get(k);
      if (runner && runner.status !== 'stopped') {
        job.log.push('Restarting the local mock with the new code...');
        stopRunner(proj, mock);
        await new Promise(r => setTimeout(r, 800));
        await startRunner(proj, mock);
        job.log.push('Local mock restarted.');
      }
    } catch (e) {
      job.error = e.message;
      job.log.push(`Error: ${e.message}`);
    } finally {
      job.running = false;
    }
  })();
  return job;
}

// ---------- gateway ----------

const HOP = ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-connection', 'te', 'trailer'];

function cors(req) {
  return {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'access-control-expose-headers': '*',
  };
}

function forward(target, req, res, extraHeaders) {
  const u = new URL(target);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.includes(k)));
  Object.assign(headers, extraHeaders, { host: u.host });
  const up = http.request(u, { method: req.method, headers }, upRes => {
    const out = Object.fromEntries(Object.entries(upRes.headers).filter(([k]) => !HOP.includes(k) && !k.startsWith('access-control-')));
    res.writeHead(upRes.statusCode, { ...out, ...cors(req), 'x-gateway-mode': 'mock' });
    upRes.pipe(res);
  });
  up.on('error', e => sendJson(res, 502, { error: 'gatewayError', message: e.message }, cors(req)));
  req.pipe(up);
}

async function gateway(req, res, projName, mock, rest, search) {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
  const proj = project(projName);
  const { def, endpoints } = await loadMock(proj, mock);
  const real = effectiveReal(proj, def);
  if (rest === '/__routes') return sendJson(res, 200, routes(withReal(proj, def), endpoints, gatewayBase(proj, mock, def)), cors(req));
  if (rest === '/__client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...cors(req) });
    return res.end(clientModule(routes(withReal(proj, def), endpoints, gatewayBase(proj, mock, def))));
  }
  const base = def.basePath ?? '';
  const inner = base && (rest === base || rest.startsWith(base + '/')) ? rest.slice(base.length) || '/' : rest;
  const ep = findApi(endpoints, req.method, inner);
  const mode = ep ? modeOf(def, ep.key) : (def.defaultMode ?? 'mock');
  if (mode === 'real') {
    if (!real) return sendJson(res, 502, { error: 'realBaseUrlMissing', message: 'This API is in Real mode but neither the project nor the mock has a realBaseUrl' }, cors(req));
    // Real APIs are called directly by the client; a request that still reaches the gateway is redirected there.
    res.writeHead(307, { location: real + inner + search, 'x-gateway-mode': 'real', ...cors(req) });
    return res.end();
  }
  const runner = await startRunner(proj, mock);
  const flow = req.headers['x-mock-scenario'] ?? (def.activeFlow && def.activeFlow !== 'default' ? def.activeFlow : undefined);
  forward(`http://127.0.0.1:${runner.port}${rest}${search}`, req, res, flow ? { 'x-mock-scenario': flow } : {});
}

// ---------- shared operations (REST API + MCP) ----------

async function mutate(proj, mock, fn) {
  const { def, endpoints } = await loadMock(proj, mock);
  const result = fn(def, endpoints);
  writeDef(proj, mock, def);
  return { result, dirty: definitionHash(def) !== def.pushedHash || !def.mockId };
}

async function waitPush(job, seconds) {
  await Promise.race([job.done, new Promise(r => setTimeout(r, seconds * 1000))]);
  return { running: job.running, error: job.error, result: job.result, log: job.log };
}

// ---------- MCP ----------

const S = { type: 'string' };
const projectArg = { project: { ...S, description: 'Project name (list_projects)' } };
const mockArg = { ...projectArg, mock: { ...S, description: 'Mock name (list_mocks)' } };
const apiArg = { ...mockArg, api: { ...S, description: 'API key exactly as list_apis returns it, e.g. "GET /tasks/:taskId"' } };
const flowArg = { flow: { ...S, description: 'Flow (scenario) name; "default" is the data clients get without choosing a flow', default: 'default' } };
const responseSchema = {
  type: 'object', description: 'Response to return',
  properties: { status: { type: 'integer', minimum: 100, maximum: 599 }, body: { description: 'JSON value or text' }, headers: { type: 'object', additionalProperties: S }, delayMs: { type: 'integer', minimum: 0 } },
  required: ['status'],
};
const whenSchema = {
  type: 'object',
  description: 'Conditions; all given parts must match. Values compare as strings, "*" means present with any value.',
  properties: {
    params: { type: 'object', description: 'Path params by name, e.g. {"constructionNo":"99999999"}', additionalProperties: S },
    query: { type: 'object', description: 'Query params, e.g. {"searchWord":"none"}', additionalProperties: S },
    headers: { type: 'object', description: 'Request headers (case-insensitive names)', additionalProperties: S },
    body: { type: 'object', description: 'JSON body fields by dotted path, e.g. {"user.email":"a@b.c"}' },
  },
};

const TOOLS = [
  { name: 'list_projects', description: 'List the projects this token can use.', inputSchema: { type: 'object', properties: {} },
    run: (a, auth) => Object.keys(projectsMap()).filter(p => canAccess(auth, p)).map(p => {
      const proj = project(p);
      return { project: p, mocks: listMocks(proj), realBaseUrl: readProjectState(proj).realBaseUrl ?? '' };
    }) },
  { name: 'create_project', description: 'Create a project on the hub (its data lives in the hub data folder).',
    inputSchema: { type: 'object', properties: { project: S, workspace: { ...S, description: 'Default Postman workspace id' } }, required: ['project'] },
    run: (a, auth) => {
      if (!HUB) throw new StoreError(400, 'create_project is only available on a shared hub (--hub)');
      if (!auth.projects.includes('*')) throw new StoreError(403, 'Only tokens with access to all projects can create projects');
      if (!SLUG.test(a.project)) throw new StoreError(400, 'project: lower-case ASCII, digits and dashes');
      const hub = readHub();
      if (hub.projects?.[a.project]) throw new StoreError(409, `Project "${a.project}" exists`);
      const dataDir = hub.dataDir ?? './projects';
      hub.projects = { ...(hub.projects ?? {}), [a.project]: { root: path.join(dataDir, a.project) } };
      writeHub(hub);
      const proj = project(a.project);
      fs.mkdirSync(path.join(proj.root, '.postman-mock', 'code-mocks'), { recursive: true });
      if (a.workspace) fs.writeFileSync(path.join(proj.root, '.postman-mock', 'state.json'), JSON.stringify({ workspaceId: a.workspace }, null, 2));
      return { project: a.project, root: proj.root };
    } },
  { name: 'list_mocks', description: 'List the code mocks of a project with gateway URL, push state and flows.',
    inputSchema: { type: 'object', properties: projectArg, required: ['project'] },
    run: async (a, auth) => { const proj = guard(auth, a.project); return Promise.all(listMocks(proj).map(async m => summary(proj, m, (await loadMock(proj, m)).def))); } },
  { name: 'create_mock', description: 'Create a code mock from a Postman collection (UID) or an OpenAPI spec path on the hub. Push it afterwards.',
    inputSchema: { type: 'object', properties: { ...mockArg, name: S, collection: { ...S, description: 'Postman collection UID' }, spec: { ...S, description: 'OpenAPI file path (relative to .postman-mock/code-mocks)' }, basePath: { ...S, description: 'e.g. /api/v1 (collection sources)' }, realBaseUrl: S, workspace: S, stateful: { type: 'boolean' } }, required: ['project', 'mock'] },
    run: (a, auth) => createMock(guard(auth, a.project), a) },
  { name: 'list_apis', description: 'List the APIs of a mock: key, name, mode (mock/real) and the mock data per flow. Use the key in other tools.',
    inputSchema: { type: 'object', properties: { ...mockArg, filter: { ...S, description: 'Substring of method, path, name or folder' } }, required: ['project', 'mock'] },
    run: async (a, auth) => {
      const { def, endpoints } = await loadMock(guard(auth, a.project), a.mock);
      const q = (a.filter ?? '').toLowerCase();
      return endpoints.filter(e => !q || `${e.key} ${e.name} ${e.folder}`.toLowerCase().includes(q)).map(e => {
        const v = apiView(def, e);
        return { key: v.key, name: v.name, folder: v.folder, mode: v.effectiveMode, flows: Object.fromEntries(Object.entries(v.flows).map(([f, x]) => [f, { enabled: x.enabled !== false, hasResponse: !!x.response, cases: (x.cases ?? []).map(c => c.name) }])) };
      });
    } },
  { name: 'get_api', description: 'Full mock data of one API (all flows, cases, conditions) plus the collection examples to start from.',
    inputSchema: { type: 'object', properties: apiArg, required: ['project', 'mock', 'api'] },
    run: async (a, auth) => {
      const { def, endpoints } = await loadMock(guard(auth, a.project), a.mock);
      const e = checkApi(endpoints, a.api);
      return { ...apiView(def, e), allFlows: allFlows(def), examples: e.examples.map(x => ({ ...x, body: String(x.body).slice(0, 4000) })) };
    } },
  { name: 'set_api_response', description: 'Set the unconditional data an API returns in a flow (used when no case matches).',
    inputSchema: { type: 'object', properties: { ...apiArg, ...flowArg, response: responseSchema }, required: ['project', 'mock', 'api', 'response'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => ops.setResponse(def, checkApi(eps, a.api), a.flow ?? 'default', a.response))) },
  { name: 'clear_api_response', description: 'Remove the unconditional data of an API in a flow (falls back to default / example).',
    inputSchema: { type: 'object', properties: { ...apiArg, ...flowArg }, required: ['project', 'mock', 'api'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => ops.clearResponse(def, checkApi(eps, a.api), a.flow ?? 'default'))) },
  { name: 'upsert_case', description: 'Add or replace (by name) a conditional case: when the request matches "when", return "response". Cases are checked in order; if none matches the flow data / default applies.',
    inputSchema: { type: 'object', properties: { ...apiArg, ...flowArg, name: S, when: whenSchema, response: responseSchema, enabled: { type: 'boolean' }, position: { type: 'integer', description: '0 = first (only for new cases)' } }, required: ['project', 'mock', 'api', 'name', 'when', 'response'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => ops.upsertCase(def, checkApi(eps, a.api), a.flow ?? 'default', { name: a.name, when: a.when, response: a.response, enabled: a.enabled }, a.position))) },
  { name: 'remove_case', description: 'Remove a case by name.',
    inputSchema: { type: 'object', properties: { ...apiArg, ...flowArg, name: S }, required: ['project', 'mock', 'api', 'name'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => ops.removeCase(def, checkApi(eps, a.api), a.flow ?? 'default', a.name))) },
  { name: 'set_api_enabled', description: 'Enable or disable the mock data of an API in a flow. Disabled: the API answers with the default flow data in that flow (default flow disabled: the collection example).',
    inputSchema: { type: 'object', properties: { ...apiArg, ...flowArg, enabled: { type: 'boolean' } }, required: ['project', 'mock', 'api', 'enabled'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => ops.setEnabled(def, checkApi(eps, a.api), a.flow ?? 'default', a.enabled))) },
  { name: 'set_api_mode', description: 'Use the mock or the real deployed API for an API ("real": clients call realBaseUrl directly). api="*" sets every API. Takes effect immediately (no push).',
    inputSchema: { type: 'object', properties: { ...mockArg, api: { ...S, description: 'API key or "*"' }, mode: { type: 'string', enum: ['mock', 'real', 'inherit'] } }, required: ['project', 'mock', 'api', 'mode'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, (def, eps) => (a.api === '*' ? ops.setAllModes(def, a.mode) : ops.setMode(def, checkApi(eps, a.api).key, a.mode)))) },
  { name: 'set_mock_settings', description: 'Set realBaseUrl (real environment; saved for the whole project unless realScope="mock"), defaultMode and activeFlow (flow served when the client sends no x-mock-scenario header).',
    inputSchema: { type: 'object', properties: { ...mockArg, realBaseUrl: S, realScope: { type: 'string', enum: ['project', 'mock'], default: 'project' }, defaultMode: { type: 'string', enum: ['mock', 'real'] }, activeFlow: S }, required: ['project', 'mock'] },
    run: async (a, auth) => {
      const proj = guard(auth, a.project);
      const { project: _p, mock: _m, ...settings } = a;
      return mutate(proj, a.mock, def => applySettings(proj, def, settings));
    } },
  { name: 'set_project_settings', description: 'Save project-wide settings reused by every mock of the project (also new ones): realBaseUrl, workspace.',
    inputSchema: { type: 'object', properties: { ...projectArg, realBaseUrl: S, workspace: S }, required: ['project'] },
    run: (a, auth) => {
      const proj = guard(auth, a.project);
      if (a.realBaseUrl !== undefined) setProjectRealBaseUrl(proj, a.realBaseUrl);
      if (a.workspace) writeProjectState(proj, { workspaceId: a.workspace });
      const s = readProjectState(proj);
      return { project: proj.name, realBaseUrl: s.realBaseUrl ?? '', workspace: s.workspaceId ?? null };
    } },
  { name: 'add_flow', description: 'Add a flow (scenario). Clients select it with header x-mock-scenario: <flow>.',
    inputSchema: { type: 'object', properties: { ...mockArg, flow: S }, required: ['project', 'mock', 'flow'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, def => ops.addFlow(def, a.flow))) },
  { name: 'remove_flow', description: 'Remove a flow; on the next push the cloud copy is reset to default data (delete it for good in the Postman app).',
    inputSchema: { type: 'object', properties: { ...mockArg, flow: S }, required: ['project', 'mock', 'flow'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, def => ops.removeFlow(def, a.flow))) },
  { name: 'push_mock', description: 'Regenerate the JS files of the mock and push them to the Postman cloud mock. Waits up to waitSeconds (default 120).',
    inputSchema: { type: 'object', properties: { ...mockArg, waitSeconds: { type: 'integer', minimum: 0, maximum: 300 } }, required: ['project', 'mock'] },
    run: async (a, auth) => { const proj = guard(auth, a.project); await loadMock(proj, a.mock); return waitPush(startPush(proj, a.mock), a.waitSeconds ?? 120); } },
  { name: 'sync_from_spec', description: 'After the OpenAPI file changed: update the Postman collection in place (ids kept), keep scenario examples, and report added / removed / renamed APIs, orphaned mock data and schema warnings. dryRun only reports. Push the mock afterwards.',
    inputSchema: { type: 'object', properties: { ...mockArg, dryRun: { type: 'boolean' }, force: { type: 'boolean', description: 'Sync even if the file hash did not change' }, waitSeconds: { type: 'integer', minimum: 0, maximum: 300 } }, required: ['project', 'mock'] },
    run: async (a, auth) => {
      const proj = guard(auth, a.project);
      await loadMock(proj, a.mock);
      const job = startSync(proj, a.mock, { dryRun: !!a.dryRun, force: !!a.force });
      await Promise.race([job.done, new Promise(r => setTimeout(r, (a.waitSeconds ?? 180) * 1000))]);
      return publicJob(job);
    } },
  { name: 'resolve_orphan', description: 'Mock data whose API no longer exists after a spec change: move it to another API key (path params in conditions are renamed by position) or delete it (omit "to").',
    inputSchema: { type: 'object', properties: { ...mockArg, from: { ...S, description: 'Orphaned API key' }, to: { ...S, description: 'New API key; omit to delete the data' } }, required: ['project', 'mock', 'from'] },
    run: async (a, auth) => (await mutate(guard(auth, a.project), a.mock, def => resolveOrphan(def, a.from, a.to || null))) },
  { name: 'get_push_status', description: 'Status of the last push of a mock.',
    inputSchema: { type: 'object', properties: mockArg, required: ['project', 'mock'] },
    run: (a, auth) => { guard(auth, a.project); return publicJob(pushes.get(`${a.project}/${a.mock}`)) ?? { running: false, log: ['no push yet'] }; } },
  { name: 'get_routes', description: 'Routing table for client apps: which base URL (mock gateway or real API) each API should use, plus the URLs of /__routes and /__client.js.',
    inputSchema: { type: 'object', properties: mockArg, required: ['project', 'mock'] },
    run: async (a, auth) => {
      const proj = guard(auth, a.project);
      const { def, endpoints } = await loadMock(proj, a.mock);
      const s = summary(proj, a.mock, def);
      return { routesUrl: s.routesUrl, clientModuleUrl: s.clientModuleUrl, ...routes(withReal(proj, def), endpoints, s.gateway) };
    } },
];

const MCP_INSTRUCTIONS = 'Mock hub for Postman code mocks. Typical flow: list_projects -> list_mocks -> list_apis -> get_api (see examples) -> ' +
  'set_api_response / upsert_case (conditions on path params, query, headers, body) -> push_mock. Flows are scenarios selected with header ' +
  'x-mock-scenario; set_api_enabled turns an API\'s data on/off per flow (off = default data). set_api_mode switches an API between the mock ' +
  'and the real deployed API (realBaseUrl), which clients then call directly. Data changes need push_mock; modes/settings do not. ' +
  'When the OpenAPI file changed (list_mocks shows spec.changed): sync_from_spec (dryRun first if unsure) -> resolve_orphan for each orphan -> push_mock.';

async function mcp(req, res) {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  let auth;
  try { auth = authenticate(req); } catch (e) { return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: e.message } }, { 'www-authenticate': 'Bearer' }); }
  const msg = await readJson(req);
  const handle = async m => {
    if (m.id === undefined || m.id === null) return null;   // notification
    const reply = result => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'postman-mock-hub', version: VERSION }, instructions: MCP_INSTRUCTIONS });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === m.params?.name);
        if (!tool) return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } };
        try {
          const out = await tool.run(m.params.arguments ?? {}, auth);
          return reply({ content: [{ type: 'text', text: JSON.stringify(out ?? { ok: true }, null, 2) }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default: return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  sendJson(res, 200, out);
}

// ---------- REST API for the dashboard ----------

function sendJson(res, status, data, extra = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  try { return body ? JSON.parse(body) : {}; } catch { throw new StoreError(400, 'Invalid JSON body'); }
}

async function api(req, res, parts) {
  const auth = authenticate(req);
  // CSRF guard for the local (no login) mode: writes must carry the dashboard's custom header.
  if (!HUB && req.method !== 'GET' && req.headers['x-dashboard'] !== '1') throw new StoreError(403, 'Missing x-dashboard header');
  const [, , p, , mock, sub, sub2] = parts;   // /api/projects/<p>/mocks/<mock>/<sub>/<sub2>
  if (!p) {
    if (req.method === 'GET') return sendJson(res, 200, { hub: !!HUB, version: VERSION, user: auth.name, projects: await TOOLS[0].run({}, auth) });
    if (req.method === 'POST') return sendJson(res, 201, await TOOLS[1].run(await readJson(req), auth));
  }
  const proj = guard(auth, p);
  if (!mock) {
    if (req.method === 'GET') return sendJson(res, 200, await TOOLS[2].run({ project: p }, auth));
    if (req.method === 'POST') return sendJson(res, 201, await createMock(proj, await readJson(req)));
  }
  if (!sub && req.method === 'GET') {
    const refresh = new URL(req.url, 'http://x').searchParams.get('refresh') === '1';
    const { def, endpoints } = await loadMock(proj, mock, { refresh });
    return sendJson(res, 200, {
      ...summary(proj, mock, def),
      apis: endpoints.map(e => ({ ...apiView(def, e), examples: e.examples })),
      orphans: orphansOf(def, endpoints, syncs.get(`${proj.name}/${mock}`)?.report?.renamed ?? []),
      schemaWarnings: schemaWarnings(def, endpoints),
    });
  }
  const b = req.method === 'GET' ? {} : await readJson(req);
  const done = r => sendJson(res, 200, r ?? { ok: true });
  switch (`${req.method} ${sub ?? ''}${sub2 ? '/' + sub2 : ''}`) {
    case 'PUT settings': return done(await mutate(proj, mock, def => applySettings(proj, def, b)));
    case 'PUT flow-entry': return done(await mutate(proj, mock, (def, eps) => ops.setFlowEntry(def, checkApi(eps, b.api), b.flow ?? 'default', b.entry)));
    case 'PUT case': return done(await mutate(proj, mock, (def, eps) => ops.upsertCase(def, checkApi(eps, b.api), b.flow ?? 'default', b.case ?? {}, b.position)));
    case 'PUT response': return done(await mutate(proj, mock, (def, eps) => ops.setResponse(def, checkApi(eps, b.api), b.flow ?? 'default', b.response ?? {})));
    case 'PUT enabled': return done(await mutate(proj, mock, (def, eps) => ops.setEnabled(def, checkApi(eps, b.api), b.flow ?? 'default', !!b.enabled)));
    case 'PUT mode': return done(await mutate(proj, mock, (def, eps) => (b.api === '*' ? ops.setAllModes(def, b.mode) : ops.setMode(def, checkApi(eps, b.api).key, b.mode))));
    case 'POST flows': return done(await mutate(proj, mock, def => ops.addFlow(def, b.flow)));
    case 'DELETE flows': return done(await mutate(proj, mock, def => ops.removeFlow(def, b.flow)));
    case 'POST push': await loadMock(proj, mock); return sendJson(res, 202, publicJob(startPush(proj, mock)));
    case 'POST sync': await loadMock(proj, mock); return sendJson(res, 202, publicJob(startSync(proj, mock, { dryRun: !!b.dryRun, force: !!b.force })));
    case 'PUT orphan': return done(await mutate(proj, mock, def => resolveOrphan(def, b.from, b.to || null)));
    case 'POST runner/start': await startRunner(proj, mock); return done(summary(proj, mock, (await loadMock(proj, mock)).def));
    case 'POST runner/stop': stopRunner(proj, mock); return done(summary(proj, mock, (await loadMock(proj, mock)).def));
    default: throw new StoreError(404, 'Unknown API');
  }
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'gw' && parts[1] && parts[2]) {
      return await gateway(req, res, parts[1], parts[2], '/' + parts.slice(3).join('/'), url.search);
    }
    if (url.pathname === '/mcp') return await mcp(req, res);
    if (parts[0] === 'api' && parts[1] === 'projects') return await api(req, res, parts);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(HTML));
    }
    throw new StoreError(404, 'Not found');
  } catch (e) {
    const status = e instanceof StoreError ? e.status : 500;
    sendJson(res, status, { error: e.message }, parts[0] === 'gw' ? cors(req) : {});
  }
});

const shutdown = () => {
  for (const k of runners.keys()) { const [p, m] = k.split('/'); try { stopRunner(project(p), m); } catch { /* project removed */ } }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Mock hub ${VERSION} (${HUB ? 'shared, token login' : 'local'}) on http://${HOST}:${PORT}`);
  console.log(`  Dashboard: ${PUBLIC}/`);
  console.log(`  MCP:       ${PUBLIC}/mcp`);
  for (const [p] of Object.entries(projectsMap())) {
    try { for (const m of listMocks(project(p))) console.log(`  Gateway:   ${PUBLIC}/gw/${p}/${m}`); } catch { /* skip */ }
  }
});
