#!/usr/bin/env node
// Re-sync a Postman collection (and the mocks built on it) after the OpenAPI file changed.
// No dependencies; Node 18+. Needs POSTMAN_API_KEY.
//
//   node spec-sync.mjs <projectRoot> [--spec <file.yml>] [--collection <uid>] [--dry-run] [--force]
//
// What it does (without Postman's own "sync collection", whose effect on custom examples is unverified):
//  1. imports the new spec into a TEMPORARY collection (deleted again right away) to get its requests/examples;
//  2. merges it into the existing collection keeping the ids of matching requests, folders and examples,
//     so the collection UID, the classic mock and stored request ids stay valid;
//  3. keeps user scenario examples (names containing " :: ") of APIs that still exist;
//  4. normalizes the examples (default = lowest 2xx with {{param}} wildcards, others behind ?__example=<code>);
//  5. writes it back with ONE PUT, updates the Postman spec file (best effort) and state.json (specHash);
//  6. returns a diff: added / removed APIs, likely renames (same shape, different params) and lost scenarios.
// The hub then shows orphaned mock data (API keys that no longer exist) and schema warnings per mock.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const BASE = (process.env.POSTMAN_API_BASE_URL ?? 'https://api.getpostman.com').replace(/\/$/, '');

async function api(method, urlPath, body) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) throw new Error('POSTMAN_API_KEY is not set');
  const res = await fetch(BASE + urlPath, {
    method, headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

export const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- collection helpers ----------

const normPath = segs => '/' + (segs ?? []).filter(s => s !== '').map(s => s.replace(/^\{\{(.+)\}\}$/, ':$1')).join('/');
const itemKey = item => `${item.request?.method ?? 'GET'} ${normPath(item.request?.url?.path)}`;
const isScenario = r => String(r.name ?? '').includes(' :: ');

function walkItems(items, fn, folder = null) {
  for (const it of items ?? []) {
    if (it.item) walkItems(it.item, fn, it);
    else fn(it, folder);
  }
}

export function endpointsOf(collection) {
  const out = [];
  walkItems(collection.item, (it, folder) => {
    const examples = (it.response ?? []).filter(r => !isScenario(r)).map(r => ({ name: r.name, status: r.code, body: r.body ?? '' }));
    out.push({ key: itemKey(it), method: it.request?.method ?? 'GET', path: normPath(it.request?.url?.path), name: it.name, folder: folder?.name ?? '', examples });
  });
  return out;
}

// Same path shape: equal segment count and equal literal segments (only param names may differ).
const shape = p => p.split('/').map(s => (s.startsWith(':') ? ':' : s)).join('/');

export function diffEndpoints(oldEps, newEps) {
  const oldKeys = new Set(oldEps.map(e => e.key)), newKeys = new Set(newEps.map(e => e.key));
  const added = newEps.filter(e => !oldKeys.has(e.key));
  const removed = oldEps.filter(e => !newKeys.has(e.key));
  const renamed = [];
  for (const r of removed) {
    const cand = added.find(a => a.method === r.method && shape(a.path) === shape(r.path));
    if (cand) renamed.push({ from: r.key, to: cand.key });
  }
  return {
    added: added.map(e => e.key),
    removed: removed.map(e => e.key),
    renamed,
    unchangedCount: newEps.length - added.length,
  };
}

// Map path params of `from` onto `to` by position (e.g. :petId -> :id).
export function paramMap(fromKey, toKey) {
  const a = [...fromKey.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]);
  const b = [...toKey.matchAll(/:([A-Za-z0-9_]+)/g)].map(m => m[1]);
  return Object.fromEntries(a.map((p, i) => [p, b[i] ?? p]));
}

// Normalization used by mock-import (see postman-rest.mjs normalize-collection).
function normalizeItem(item) {
  const responses = item.response ?? [];
  const pathSegs = (item.request?.url?.path ?? []).map(s => (s.startsWith(':') ? `{{${s.slice(1)}}}` : s));
  const generated = responses.filter(r => !isScenario(r));
  const def = [...generated].sort((a, b) => a.code - b.code).find(r => r.code >= 200 && r.code < 300) ?? [...generated].sort((a, b) => a.code - b.code)[0];
  for (const r of generated) {
    const isDefault = r === def;
    const query = isDefault ? [] : [{ key: '__example', value: String(r.code) }];
    r.originalRequest = {
      ...(r.originalRequest ?? {}),
      method: item.request.method,
      url: { raw: `{{baseUrl}}/${pathSegs.join('/')}${isDefault ? '' : `?__example=${r.code}`}`, host: ['{{baseUrl}}'], path: pathSegs, ...(query.length ? { query } : {}) },
    };
  }
}

// ---------- merge ----------

export function mergeCollections(oldCol, newCol) {
  const oldItems = new Map();
  walkItems(oldCol.item, it => oldItems.set(itemKey(it), it));
  const oldFolders = new Map((oldCol.item ?? []).filter(i => i.item).map(f => [f.name, f]));
  const lostScenarios = [];
  const keepScenarios = new Set();

  // Exact key first; otherwise an unused old item with the same method and path shape (a path param rename).
  const used = new Set();
  const newKeys = new Set();
  walkItems(newCol.item, it => newKeys.add(itemKey(it)));
  const findOld = it => {
    const exact = oldItems.get(itemKey(it));
    if (exact) return exact;
    const [m, p] = [it.request?.method ?? 'GET', normPath(it.request?.url?.path)];
    for (const [k, o] of oldItems) {
      if (used.has(k) || newKeys.has(k)) continue;
      if (k.startsWith(m + ' ') && shape(k.slice(m.length + 1)) === shape(p)) { used.add(k); return o; }
    }
    return null;
  };

  const mergeItem = it => {
    const old = findOld(it);
    if (!old) { delete it.id; for (const r of it.response ?? []) delete r.id; return it; }
    it.id = old.id;
    const oldResp = old.response ?? [];
    for (const r of it.response ?? []) {
      const match = oldResp.find(o => !isScenario(o) && o.code === r.code && o.name === r.name)
        ?? oldResp.find(o => !isScenario(o) && o.code === r.code);
      if (match) r.id = match.id; else delete r.id;
    }
    // Ids must stay unique inside the item.
    const seen = new Set();
    for (const r of it.response ?? []) { if (r.id && seen.has(r.id)) delete r.id; else if (r.id) seen.add(r.id); }
    for (const s of oldResp.filter(isScenario)) { it.response = [...(it.response ?? []), s]; keepScenarios.add(s.id); }
    return it;
  };

  const merged = {
    info: { ...oldCol.info, schema: oldCol.info?.schema ?? newCol.info?.schema },
    variable: mergeVariables(oldCol.variable, newCol.variable),
    item: (newCol.item ?? []).map(i => {
      if (!i.item) return mergeItem(i);
      const oldF = oldFolders.get(i.name);
      return { ...i, ...(oldF ? { id: oldF.id } : { id: undefined }), item: i.item.map(x => (x.item ? x : mergeItem(x))) };
    }),
  };
  for (const k of ['auth', 'event']) if (oldCol[k]) merged[k] = oldCol[k];
  walkItems(merged.item, normalizeItem);
  walkItems(oldCol.item, it => {
    for (const s of (it.response ?? []).filter(isScenario)) if (!keepScenarios.has(s.id)) lostScenarios.push({ api: itemKey(it), name: s.name });
  });
  return { merged, lostScenarios };
}

function mergeVariables(oldVars = [], newVars = []) {
  const byKey = new Map(oldVars.map(v => [v.key, v]));
  for (const v of newVars) byKey.set(v.key, { ...(byKey.get(v.key) ?? {}), ...v });
  return [...byKey.values()];
}

// ---------- sync ----------

export async function syncFromSpec({ projectRoot, specFile, collectionUid, workspace, specId, dryRun = false, force = false, log = () => {} }) {
  const statePath = path.join(projectRoot, '.postman-mock', 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, '')) : {};
  specFile = specFile ?? state.sourceSpec;
  collectionUid = collectionUid ?? state.collectionUid;
  workspace = workspace ?? state.workspaceId;
  specId = specId ?? state.specId;
  if (!specFile) throw new Error('No OpenAPI file: pass --spec or set "sourceSpec" in .postman-mock/state.json');
  const specPath = path.resolve(projectRoot, specFile);
  if (!fs.existsSync(specPath)) throw new Error(`OpenAPI file not found: ${specPath}`);
  if (!collectionUid) throw new Error('No collection: pass --collection or set "collectionUid" in .postman-mock/state.json');

  const hash = fileHash(specPath);
  if (!force && hash === state.specHash) return { unchanged: true, specFile: specPath, specHash: hash };

  log('Reading the current collection...');
  const { collection: oldCol } = await api('GET', `/collections/${encodeURIComponent(collectionUid)}`);

  log('Importing the new spec into a temporary collection...');
  const imported = await api('POST', `/import/openapi${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`, {
    type: 'string', input: fs.readFileSync(specPath, 'utf8'),
    options: { folderStrategy: 'Tags', requestParametersResolution: 'Example', exampleParametersResolution: 'Example' },
  });
  const tmp = imported.collections?.[0];
  if (!tmp?.uid) throw new Error(`Unexpected import result: ${JSON.stringify(imported).slice(0, 300)}`);
  let newCol;
  try {
    ({ collection: newCol } = await api('GET', `/collections/${encodeURIComponent(tmp.uid)}`));
  } finally {
    // The temporary collection was created by this sync; remove it again.
    await api('DELETE', `/collections/${encodeURIComponent(tmp.uid)}`).catch(e => log(`Warning: could not delete temporary collection ${tmp.uid}: ${e.message}`));
  }

  const oldEps = endpointsOf(oldCol);
  const { merged, lostScenarios } = mergeCollections(oldCol, newCol);
  const newEps = endpointsOf(merged);
  const diff = diffEndpoints(oldEps, newEps);
  const report = { specFile: specPath, specHash: hash, previousHash: state.specHash ?? null, collectionUid, dryRun, ...diff, lostScenarios, warnings: [] };
  if (dryRun) return { ...report, endpoints: newEps };

  log('Writing the merged collection (one PUT, ids kept)...');
  await api('PUT', `/collections/${encodeURIComponent(collectionUid)}`, { collection: merged });

  if (specId) {
    try {
      const files = await api('GET', `/specs/${encodeURIComponent(specId)}/files`);
      const root = (files.files ?? []).find(f => f.type === 'ROOT') ?? files.files?.[0];
      if (root) await api('PATCH', `/specs/${encodeURIComponent(specId)}/files/${encodeURIComponent(root.path)}`, { content: fs.readFileSync(specPath, 'utf8') });
      log('Updated the spec in Postman.');
    } catch (e) {
      report.warnings.push(`Spec in Postman not updated (${e.message.slice(0, 120)}); the collection and mocks are updated.`);
    }
  }

  const next = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, '')) : {};
  Object.assign(next, { sourceSpec: specFile, specHash: hash, lastSpecSyncAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');
  return { ...report, endpoints: newEps };
}

// ---------- mock data checks (used by the hub) ----------

// API keys of a v2 definition that no longer exist, with a suggested target.
export function orphansOf(def, endpoints, renamed = []) {
  const keys = new Set(endpoints.map(e => e.key));
  return Object.keys(def.apis ?? {}).filter(k => !keys.has(k)).map(k => {
    const hint = renamed.find(r => r.from === k)?.to
      ?? endpoints.find(e => e.method === k.split(' ')[0] && shape(e.path) === shape(k.slice(k.indexOf(' ') + 1)))?.key ?? null;
    const a = def.apis[k];
    const flows = Object.entries(a.flows ?? {}).map(([f, x]) => `${f}: ${(x.cases ?? []).length} case${x.response ? ' + data' : ''}${x.enabled === false ? ' (off)' : ''}`);
    return { key: k, suggestion: hint, mode: a.mode ?? null, flows };
  });
}

const topKeys = v => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  if (Array.isArray(x)) x = x[0];
  return x && typeof x === 'object' ? Object.keys(x) : null;
};

// Heuristic: compare the top-level fields of saved bodies with the collection example of the same status.
export function schemaWarnings(def, endpoints) {
  const out = [];
  for (const [key, a] of Object.entries(def.apis ?? {})) {
    const ep = endpoints.find(e => e.key === key);
    if (!ep) continue;
    for (const [flow, entry] of Object.entries(a.flows ?? {})) {
      const items = [...(entry.cases ?? []).map(c => ({ label: `case "${c.name}"`, r: c.response })), ...(entry.response ? [{ label: 'data', r: entry.response }] : [])];
      for (const { label, r } of items) {
        const ex = ep.examples.find(x => x.status === r.status);
        const want = ex && topKeys(ex.body), have = topKeys(r.body);
        if (!want || !have) continue;
        const missing = want.filter(k => !have.includes(k)), extra = have.filter(k => !want.includes(k));
        if (missing.length || extra.length) out.push({ api: key, flow, item: label, status: r.status, missing, extra });
      }
    }
  }
  return out;
}

// Moves the mock data of an orphaned key to a new API key (renaming path params in conditions), or deletes it.
export function resolveOrphan(def, from, to) {
  const data = def.apis?.[from];
  if (!data) throw Object.assign(new Error(`No mock data under "${from}"`), { status: 404 });
  delete def.apis[from];
  if (!to) return { deleted: from };
  if (def.apis[to] && Object.keys(def.apis[to].flows ?? {}).length) throw Object.assign(new Error(`"${to}" already has mock data; remove it first or delete the orphan`), { status: 409 });
  const map = paramMap(from, to);
  for (const entry of Object.values(data.flows ?? {})) {
    for (const c of entry.cases ?? []) {
      if (c.when?.params) c.when.params = Object.fromEntries(Object.entries(c.when.params).map(([k, v]) => [map[k] ?? k, v]));
    }
  }
  def.apis[to] = { ...(def.apis[to] ?? {}), ...data };
  return { moved: from, to, params: map };
}

// ---------- CLI ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const root = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) ?? process.cwd();
  try {
    const r = await syncFromSpec({
      projectRoot: path.resolve(root), specFile: opt('spec'), collectionUid: opt('collection'),
      dryRun: args.includes('--dry-run'), force: args.includes('--force'), log: m => console.error(m),
    });
    const { endpoints, ...summary } = r;
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
