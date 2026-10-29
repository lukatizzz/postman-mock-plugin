#!/usr/bin/env node
// Postman "code mocks" (JavaScript mocks: config.yaml + <flow>.js) kept in Postman CLOUD.
// The code is generated in a temporary folder with the Postman CLI, the mock data of the definition is
// compiled into it, it is pushed to the workspace, and the temporary folder is deleted.
// Requires the Postman CLI (`npm install -g postman-cli`) logged in once: postman login --with-api-key <key>
// No dependencies; Node 18+. Definition format: see mock-store.mjs.
//
// Commands:
//   cloud-push <definition.json>   build + push; writes mockId back into the definition
//   build <definition.json> <dir>  build only, into <dir> (for inspection / `postman mock run <dir>`)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensureV2, migrateLegacy, allFlows, pathRegex, pathParams, definitionHash } from './mock-store.mjs';

export { definitionHash };

const fail = msg => { throw new Error(msg); };
const CONFIG = 'config.yaml';

// ---------- config.yaml ----------

function readConfig(dir) {
  const file = path.join(dir, CONFIG);
  if (!fs.existsSync(file)) fail(`No ${CONFIG} in ${dir}.`);
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

// Minimal parser for the scenarios block written by `postman mock generate`.
function parseScenarios(yaml) {
  const block = yaml.match(/^scenarios:\n((?:[ \t]+.*\n?)*)/m);
  if (!block) return [];
  return block[1].split(/^\s*-\s+/m).filter(s => s.trim()).map(entry => {
    const get = k => entry.match(new RegExp(`(?:^|\\n)\\s*${k}:\\s*(.+)`))?.[1]?.trim();
    return { name: get('name'), path: get('path'), default: get('default') === 'true' };
  });
}

function writeScenarios(dir, scenarios) {
  const yaml = readConfig(dir);
  const block = 'scenarios:\n' + scenarios.map(s =>
    `  - name: ${s.name}\n    path: ${s.path}\n` + (s.default ? '    default: true\n' : '')).join('');
  const next = /^scenarios:\n(?:[ \t]+.*\n?)*/m.test(yaml) ? yaml.replace(/^scenarios:\n(?:[ \t]+.*\n?)*/m, block) : yaml.trimEnd() + '\n' + block;
  fs.writeFileSync(path.join(dir, CONFIG), next);
}

function setConfigField(dir, key, value) {
  const yaml = readConfig(dir);
  const re = new RegExp(`^${key}: .*$`, 'm');
  fs.writeFileSync(path.join(dir, CONFIG), re.test(yaml) ? yaml.replace(re, `${key}: ${value}`) : `${key}: ${value}\n${yaml}`);
}

// ---------- code generation ----------

const HANDLER_ANCHOR = /(const pathname = url\.pathname[^\n]*;\n)/;
const SERVER_ANCHOR = /^const server = http\.createServer/m;

// Helpers added once per file: request body (cached, shared with the stateful generator's __readBody),
// dotted-path lookup and the "*" / equality comparison used by case conditions.
const HELPERS = `
// ─── postman-mock helpers ───
function __pmBody(req) {
  if (req.__pmBodyRaw !== undefined) return Promise.resolve(__pmParse(req.__pmBodyRaw));
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { req.__pmBodyRaw = data; resolve(__pmParse(data)); });
    req.on('error', () => { req.__pmBodyRaw = ''; resolve({}); });
  });
}
function __pmParse(s) { if (!s) return {}; try { return JSON.parse(s); } catch (e) { return { __raw: s }; } }
function __pmGet(obj, p) { return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function __pmEq(actual, expected) {
  if (expected === '*') return actual !== undefined && actual !== null && actual !== '';
  if (expected !== null && typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(expected);
  return actual !== undefined && actual !== null && String(actual) === String(expected);
}
`;

function responseCode(r, indent) {
  const headers = { 'Content-Type': 'application/json', ...(r.headers ?? {}) };
  const body = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  const lines = [];
  if (r.delayMs > 0) lines.push(`await new Promise(r => setTimeout(r, ${Number(r.delayMs)}));`);
  lines.push(`res.writeHead(${Number(r.status ?? 200)}, ${JSON.stringify(headers)});`);
  lines.push(`return res.end(${r.status === 204 || r.status === 304 ? '' : JSON.stringify(body)});`);
  return lines.map(l => indent + l).join('\n');
}

function conditionCode(when, params) {
  const conds = [];
  for (const [k, v] of Object.entries(when.params ?? {})) {
    const i = params.indexOf(k);
    conds.push(`__pmEq(decodeURIComponent(__m[${i + 1}]), ${JSON.stringify(v)})`);
  }
  for (const [k, v] of Object.entries(when.query ?? {})) conds.push(`__pmEq(url.searchParams.get(${JSON.stringify(k)}), ${JSON.stringify(v)})`);
  for (const [k, v] of Object.entries(when.headers ?? {})) conds.push(`__pmEq(req.headers[${JSON.stringify(k.toLowerCase())}], ${JSON.stringify(v)})`);
  for (const [k, v] of Object.entries(when.body ?? {})) conds.push(`__pmEq(__pmGet(await __pmBody(req), ${JSON.stringify(k)}), ${JSON.stringify(v)})`);
  return conds.join(' && ') || 'true';
}

// One route block per API: its resolution chain for the flow, first match wins, otherwise the generated code runs.
function apiBlock(key, chain) {
  const [method, apiPath] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
  const params = pathParams(apiPath);
  // RegExp#source already escapes "/" in current engines; escape any that are left for the literal form.
  const re = pathRegex(apiPath).source.replace(/(?<!\\)\//g, '\\/');
  const body = chain.map(step => step.when
    ? `    // ${step.label}\n    if (${conditionCode(step.when, params)}) {\n${responseCode(step.response, '      ')}\n    }`
    : `    // ${step.label}\n${responseCode(step.response, '    ')}`).join('\n');
  return `  // @endpoint ${key}  (mock data)\n  { const __m = pathname.match(/${re}/);\n  if (req.method === ${JSON.stringify(method)} && __m) {\n${body}\n  } }\n\n`;
}

// Resolution chain of one API in one flow: flow cases -> flow response -> default cases -> default response.
function chainFor(api, flow) {
  const steps = [];
  const add = (entry, label) => {
    if (!entry || entry.enabled === false) return;
    for (const c of entry.cases ?? []) if (c.enabled !== false) steps.push({ when: c.when, response: c.response, label: `${label} case "${c.name}"` });
    if (entry.response) steps.push({ response: entry.response, label: `${label} data` });
  };
  if (flow !== 'default') add(api.flows?.[flow], `flow ${flow}`);
  add(api.flows?.default, 'default');
  // Nothing unconditional at the end -> fall through to the generated example route.
  return steps;
}

function compileFlow(baseCode, def, flow) {
  const blocks = Object.entries(def.apis ?? {})
    .map(([key, api]) => [key, chainFor(api, flow)])
    .filter(([, chain]) => chain.length)
    .map(([key, chain]) => apiBlock(key, chain)).join('');
  let code = baseCode;
  if (blocks) {
    if (!HANDLER_ANCHOR.test(code)) fail('Could not find the request handler in the generated mock');
    code = code.replace('http.createServer((req, res) =>', 'http.createServer(async (req, res) =>')
      .replace(HANDLER_ANCHOR, `$1\n  // ─── mock data for flow "${flow}" (generated by postman-mock) ───\n${blocks}`);
  }
  code = code.replace(SERVER_ANCHOR, `${HELPERS}\nconst server = http.createServer`);
  // Stateful generator reads the body itself; let it reuse a body already read by a condition.
  code = code.replace(/async function __readBody\(req\) \{\n/, `async function __readBody(req) {\n  if (req.__pmBodyRaw !== undefined) return __pmBody(req);\n`);
  return code.replace(/^\/\*\*\n \* Autogenerated.*\n \*\//m, `/**\n * Flow "${flow}" - generated by postman-mock app-mock.mjs\n */`);
}

// Collection-based generation drops a relative {{baseUrl}} such as /api/v1; accept both /api/v1/x and /x.
function withBasePath(code, basePath) {
  const escaped = basePath.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
  return code.replace(/const pathname = url\.pathname[^\n]*;/, `const pathname = url.pathname.replace(/^${escaped}(?=\\/|$)/, '') || '/';`);
}

// ---------- Postman CLI ----------

// Asynchronous so a long generate/push does not block the hub's event loop.
// `postman mock push` records "config.yaml path -> cloud mock id" in <cwd>/.postman/resources.yaml and only
// UPDATES a mock it finds there, so it always runs inside the temporary folder, never the user's project.
function postman(args, cwd) {
  const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return new Promise((resolve, reject) => {
    const child = spawn(['postman', ...quoted].join(' '), { shell: true, cwd, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', reject);
    child.on('close', code => {
      out = out.trim();
      if (code !== 0) return reject(new Error(`postman ${args[0]} ${args[1] ?? ''} failed:\n${(err || out).trim()}\n` +
        'Is the Postman CLI installed (npm install -g postman-cli) and logged in (postman login --with-api-key <key>)?'));
      try { resolve(JSON.parse(out.slice(out.indexOf('{')))); } catch { resolve({ raw: out }); }
    });
  });
}

async function fetchCollection(uid, file) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) fail('POSTMAN_API_KEY is not set (needed to download the collection).');
  const base = (process.env.POSTMAN_API_BASE_URL ?? 'https://api.getpostman.com').replace(/\/$/, '');
  const res = await fetch(`${base}/collections/${encodeURIComponent(uid)}`, { headers: { 'X-Api-Key': key } });
  if (!res.ok) fail(`GET /collections/${uid} -> HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json.collection ?? json));
}

// ---------- build & push ----------

export async function build(def, defDir, outDir, workDir) {
  let source;
  if (def.source?.collection) {
    source = path.join(workDir, 'collection.json');
    await fetchCollection(def.source.collection, source);
  } else if (def.source?.spec) {
    source = path.resolve(defDir, def.source.spec);
    if (!fs.existsSync(source)) fail(`Spec not found: ${source}`);
  } else fail('source must be { "collection": "<uid>" } or { "spec": "<path>" }');

  const gen = ['mock', 'generate', source, '--output', outDir, '--name', def.name, '--json'];
  if (def.stateful) gen.push('--stateful');
  await postman(gen, workDir);
  setConfigField(outDir, 'name', def.name);
  if (def.mockId) setConfigField(outDir, 'id', def.mockId);

  const base = parseScenarios(readConfig(outDir)).find(s => s.default) ?? fail('generated config.yaml has no default scenario');
  let baseCode = fs.readFileSync(path.join(outDir, base.path), 'utf8');
  if (def.idField?.from && def.idField?.to) baseCode = baseCode.split(`['${def.idField.from}']`).join(`['${def.idField.to}']`);
  // Spec-generated routes already contain the server path; only collection sources lose it.
  const fixBase = code => (def.basePath && def.source.collection ? withBasePath(code, def.basePath) : code);

  const flows = [...allFlows(def), ...(def.retiredFlows ?? []).filter(f => !allFlows(def).includes(f))];
  const scenarios = [];
  for (const flow of flows) {
    // A push never deletes cloud scenarios; retired flows are re-pushed with the plain default data.
    const code = fixBase(compileFlow(baseCode, def, (def.retiredFlows ?? []).includes(flow) ? 'default' : flow));
    const file = flow === 'default' ? base.path : `./${flow}.js`;
    fs.writeFileSync(path.join(outDir, file), code);
    scenarios.push({ name: flow, path: file, default: flow === 'default' });
  }
  writeScenarios(outDir, scenarios);
  return flows;
}

export async function cloudPush(defFile) {
  const def = ensureV2(JSON.parse(fs.readFileSync(defFile, 'utf8')));
  if (def._legacy) fail('Definition still has v1 data; open it once in the hub (dashboard/MCP) to migrate it.');
  if (!def.name || !def.workspace || !def.source) fail('definition needs name, workspace and source');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-code-mock-'));
  try {
    const dir = path.join(tmp, 'mock');
    const flows = await build(def, path.dirname(defFile), dir, tmp);
    if (def.mockId) {
      // Make the push update the existing cloud mock instead of creating a new one.
      fs.mkdirSync(path.join(tmp, '.postman'));
      fs.writeFileSync(path.join(tmp, '.postman', 'resources.yaml'),
        `cloudResources:\n  mocks:\n    ../mock/config.yaml: ${def.mockId}\nworkspace:\n  id: ${def.workspace}\n`);
    }
    const pushed = await postman(['mock', 'push', dir, '-w', def.workspace, '--json'], tmp);
    if (!pushed.mockId) fail(`Unexpected push result: ${JSON.stringify(pushed)}`);
    // Re-read: the hub may have saved edits while the push was running; only touch our fields.
    const latest = JSON.parse(fs.readFileSync(defFile, 'utf8'));
    Object.assign(latest, { mockId: pushed.mockId, postmanUrl: pushed.postmanUrl, pushedAt: new Date().toISOString(), pushedHash: definitionHash(def) });
    fs.writeFileSync(defFile, JSON.stringify(latest, null, 2) + '\n');
    return { mockId: pushed.mockId, created: pushed.created, postmanUrl: pushed.postmanUrl, flows };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'cloud-push' && a) console.log(JSON.stringify(await cloudPush(a), null, 2));
    else if (cmd === 'build' && a && b) {
      const def = ensureV2(JSON.parse(fs.readFileSync(a, 'utf8')));
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-code-mock-'));
      try { console.log(JSON.stringify({ dir: path.resolve(b), flows: await build(def, path.dirname(a), path.resolve(b), work) }, null, 2)); }
      finally { fs.rmSync(work, { recursive: true, force: true }); }
    } else {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
      process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
