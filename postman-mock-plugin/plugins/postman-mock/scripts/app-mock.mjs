#!/usr/bin/env node
// Postman "code mocks" (JavaScript mocks: config.yaml + <scenario>.js) kept in Postman CLOUD.
// The code is built in a temporary folder with the Postman CLI, pushed to the workspace, and the
// temporary folder is deleted - nothing is left in the project except a small definition file.
// Run a cloud mock with `postman mock run <mockId>` or from the Postman app.
// Requires the Postman CLI (`npm install -g postman-cli`) logged in once:
//   postman login --with-api-key <key>
// No dependencies; Node 18+.
//
// Main command:
//   cloud-push <definition.json>
//       Builds and pushes the mock described by the definition, then writes the cloud mockId back into it.
//       Re-run after editing the definition to update the same cloud mock.
//       definition.json:
//       {
//         "name": "Petstore mock",              // shown in Postman
//         "workspace": "<workspaceId>",
//         "mockId": null,                       // filled in after the first push
//         "source": { "collection": "<collectionUid>" }   // or { "spec": "path/to/openapi.yaml" }
//         "stateful": false,                    // CRUD handlers backed by pm.state
//         "basePath": "/api/v1",                // collection source only: also accept requests under this prefix
//         "idField": { "from": "petId", "to": "id" },     // optional, stateful only
//         "scenarios": {                        // selected per request with header x-mock-scenario: <name>
//           "pet-sold": [{ "method": "GET", "path": "/pets/:petId", "status": 200, "body": {...},
//                          "headers"?: {...}, "query"?: {"k": "v"}, "delayMs"?: 0 }]
//         }
//       }
//       Override paths are the routes as generated: from a collection without the base path (/pets/:petId),
//       from a spec with the server path included (/v1/pets/:petId).
//       "retiredScenarios": ["old-name"]  - a push cannot delete a cloud scenario; listed ones are reset
//       to the default behaviour (delete them for good in the Postman app).
//
// Low-level commands on a mock folder (used by cloud-push, handy for debugging):
//   add-scenario <mockDir> <name> <overrides.json> [--make-default]
//   remove-scenario <mockDir> <name>
//   list <mockDir>
//   set-base-path <mockDir> </api/v1>
//   rename-id-field <mockDir> <fromField> <toField>

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fail = msg => { console.error(msg); process.exit(1); };
const print = data => console.log(JSON.stringify(data, null, 2));
const CONFIG = 'config.yaml';

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

function writeScenarios(dir, yaml, scenarios) {
  const block = 'scenarios:\n' + scenarios.map(s =>
    `  - name: ${s.name}\n    path: ${s.path}\n` + (s.default ? '    default: true\n' : '')).join('');
  const next = /^scenarios:\n(?:[ \t]+.*\n?)*/m.test(yaml)
    ? yaml.replace(/^scenarios:\n(?:[ \t]+.*\n?)*/m, block)
    : yaml.trimEnd() + '\n' + block;
  fs.writeFileSync(path.join(dir, CONFIG), next);
}

function setConfigField(dir, key, value) {
  const yaml = readConfig(dir);
  const re = new RegExp(`^${key}: .*$`, 'm');
  fs.writeFileSync(path.join(dir, CONFIG), re.test(yaml) ? yaml.replace(re, `${key}: ${value}`) : `${key}: ${value}\n${yaml}`);
}

function routeCode(o) {
  const method = String(o.method ?? 'GET').toUpperCase();
  const regex = '^' + o.path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}|:[A-Za-z0-9_]+/g, '[^/]+') + '$';
  const conds = [`req.method === ${JSON.stringify(method)}`, `/${regex.replace(/\//g, '\\/')}/.test(pathname)`];
  for (const [k, v] of Object.entries(o.query ?? {})) conds.push(`url.searchParams.get(${JSON.stringify(k)}) === ${JSON.stringify(String(v))}`);
  const headers = { 'Content-Type': 'application/json', ...(o.headers ?? {}) };
  const body = o.body === undefined ? '' : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const delay = Number(o.delayMs) > 0 ? `await new Promise(r => setTimeout(r, ${Number(o.delayMs)}));\n    ` : '';
  return `  // @endpoint ${method} ${o.path}  (scenario override)\n` +
    `  if (${conds.join(' && ')}) {\n` +
    `    ${delay}res.writeHead(${Number(o.status ?? 200)}, ${JSON.stringify(headers)});\n` +
    `    return res.end(${o.status === 204 ? '' : JSON.stringify(body)});\n  }\n\n`;
}

function addScenario(dir, name, overrides, makeDefault = false) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`Scenario name "${name}" must be lower-case ASCII, digits and dashes (it is sent in a header).`);
  const yaml = readConfig(dir);
  const scenarios = parseScenarios(yaml);
  const base = scenarios.find(s => s.name === 'default') ?? scenarios.find(s => s.default) ?? scenarios[0];
  if (!base) fail('config.yaml has no scenario to copy');
  let code = fs.readFileSync(path.join(dir, base.path), 'utf8');
  const injected = (Array.isArray(overrides) ? overrides : [overrides]).map(routeCode).join('');
  const anchor = /(const pathname = url\.pathname[^\n]*;\n)/;
  if (!anchor.test(code)) fail(`Could not find the request handler in ${base.path}`);
  code = code.replace('http.createServer((req, res) =>', 'http.createServer(async (req, res) =>')
    .replace(anchor, `$1\n  // ─── scenario "${name}" overrides ───\n${injected}`)
    .replace(/^\/\*\*\n \* Autogenerated.*\n \*\//m, `/**\n * Scenario "${name}" - generated by postman-mock app-mock.mjs from ${base.path}\n */`);
  const file = `./${name}.js`;
  fs.writeFileSync(path.join(dir, file), code);
  const next = scenarios.filter(s => s.name !== name).map(s => ({ ...s, default: makeDefault ? false : s.default }));
  next.push({ name, path: file, default: makeDefault });
  writeScenarios(dir, readConfig(dir), next);
  return { scenario: name, header: `x-mock-scenario: ${name}`, default: makeDefault };
}

// Collection-based generation drops a relative {{baseUrl}} such as /api/v1; accept both /api/v1/x and /x.
function setBasePath(dir, basePath) {
  const escaped = basePath.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
  let changed = 0;
  for (const s of parseScenarios(readConfig(dir))) {
    const file = path.join(dir, s.path);
    const code = fs.readFileSync(file, 'utf8');
    const next = code.replace(/const pathname = url\.pathname[^\n]*;/,
      `const pathname = url.pathname.replace(/^${escaped}(?=\\/|$)/, '') || '/';`);
    if (next !== code) { fs.writeFileSync(file, next); changed++; }
  }
  return changed;
}

// Stateful mocks key entities by the path variable (e.g. petId); rename it to the schema's id field.
function renameIdField(dir, from, to) {
  let changed = 0;
  for (const s of parseScenarios(readConfig(dir))) {
    const file = path.join(dir, s.path);
    const code = fs.readFileSync(file, 'utf8');
    const next = code.split(`['${from}']`).join(`['${to}']`);
    if (next !== code) { fs.writeFileSync(file, next); changed++; }
  }
  return changed;
}

// Runs the Postman CLI in `cwd` and returns its parsed --json output.
// `postman mock push` records "config.yaml path -> cloud mock id" in <cwd>/.postman/resources.yaml and
// only UPDATES a mock it finds there, so pushes always run inside the temporary folder (never the
// user's project, whose .postman/resources.yaml belongs to the Postman app's Git link).
function postman(args, cwd) {
  // One command string: the CLI is a .cmd/.ps1 shim on Windows, so it needs a shell.
  const quoted = args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  const r = spawnSync(['postman', ...quoted].join(' '), { shell: true, encoding: 'utf8', cwd });
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0) throw new Error(`postman ${args[0]} ${args[1] ?? ''} failed:\n${(r.stderr || out).trim()}\n` +
    'Is the Postman CLI installed (npm install -g postman-cli) and logged in (postman login --with-api-key <key>)?');
  try { return JSON.parse(out.slice(out.indexOf('{'))); } catch { return { raw: out }; }
}

async function fetchCollection(uid, file) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) throw new Error('POSTMAN_API_KEY is not set (needed to download the collection).');
  const base = (process.env.POSTMAN_API_BASE_URL ?? 'https://api.getpostman.com').replace(/\/$/, '');
  const res = await fetch(`${base}/collections/${encodeURIComponent(uid)}`, { headers: { 'X-Api-Key': key } });
  if (!res.ok) throw new Error(`GET /collections/${uid} -> HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  fs.writeFileSync(file, JSON.stringify(json.collection ?? json));
}

async function cloudPush(defFile) {
  const def = JSON.parse(fs.readFileSync(defFile, 'utf8'));
  if (!def.name || !def.workspace || !def.source) fail('definition needs name, workspace and source');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-code-mock-'));
  try {
    let source;
    if (def.source.collection) {
      source = path.join(tmp, 'collection.json');
      await fetchCollection(def.source.collection, source);
    } else if (def.source.spec) {
      source = path.resolve(path.dirname(defFile), def.source.spec);
      if (!fs.existsSync(source)) throw new Error(`Spec not found: ${source}`);
    } else throw new Error('source must be { "collection": "<uid>" } or { "spec": "<path>" }');

    const dir = path.join(tmp, 'mock');
    const gen = ['mock', 'generate', source, '--output', dir, '--name', def.name, '--json'];
    if (def.stateful) gen.push('--stateful');
    postman(gen, tmp);

    setConfigField(dir, 'name', def.name);
    if (def.mockId) {
      // Make the push update the existing cloud mock instead of creating a new one.
      setConfigField(dir, 'id', def.mockId);
      fs.mkdirSync(path.join(tmp, '.postman'));
      fs.writeFileSync(path.join(tmp, '.postman', 'resources.yaml'),
        `cloudResources:\n  mocks:\n    ../mock/config.yaml: ${def.mockId}\nworkspace:\n  id: ${def.workspace}\n`);
    }

    if (def.idField?.from && def.idField?.to) renameIdField(dir, def.idField.from, def.idField.to);
    const added = Object.entries(def.scenarios ?? {}).map(([name, overrides]) => addScenario(dir, name, overrides));
    // A push never deletes cloud scenarios; retired ones are overwritten with the plain default behaviour.
    for (const name of def.retiredScenarios ?? []) {
      if (!def.scenarios?.[name]) addScenario(dir, name, []);
    }
    // Spec-generated routes already contain the server path (e.g. /v1/pets); only collection-generated
    // routes lose a relative {{baseUrl}}, so the prefix is only stripped for collection sources.
    if (def.basePath && def.source.collection) setBasePath(dir, def.basePath);
    else if (def.basePath) console.error(`basePath ignored: routes generated from a spec already include it.`);

    const pushed = postman(['mock', 'push', dir, '-w', def.workspace, '--json'], tmp);
    if (!pushed.mockId) throw new Error(`Unexpected push result: ${JSON.stringify(pushed)}`);
    def.mockId = pushed.mockId;
    def.postmanUrl = pushed.postmanUrl;
    fs.writeFileSync(defFile, JSON.stringify(def, null, 2) + '\n');
    print({
      mockId: pushed.mockId,
      created: pushed.created,
      postmanUrl: pushed.postmanUrl,
      scenarios: ['default', ...added.map(a => a.scenario)],
      run: `postman mock run ${pushed.mockId} --port 4500`,
    });
  } catch (e) {
    // Not fail(): process.exit() would skip the cleanup below.
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const commands = {
  'cloud-push': ([defFile]) => (defFile ? cloudPush(defFile) : fail('usage: cloud-push <definition.json>')),

  list([dir]) { print(parseScenarios(readConfig(dir))); },

  'add-scenario'([dir, name, overridesFile], opts) {
    if (!dir || !name || !overridesFile) fail('usage: add-scenario <mockDir> <name> <overrides.json> [--make-default]');
    print(addScenario(dir, name, JSON.parse(fs.readFileSync(overridesFile, 'utf8')), !!opts['make-default']));
  },

  'remove-scenario'([dir, name]) {
    if (!dir || !name) fail('usage: remove-scenario <mockDir> <name>');
    if (name === 'default') fail('Refusing to remove the default scenario');
    const yaml = readConfig(dir);
    const scenarios = parseScenarios(yaml);
    const target = scenarios.find(s => s.name === name);
    if (!target) fail(`No scenario "${name}"`);
    const next = scenarios.filter(s => s !== target);
    if (target.default && next.length) next[0].default = true;
    writeScenarios(dir, yaml, next);
    fs.rmSync(path.join(dir, target.path), { force: true });
    print({ removed: name });
  },

  'set-base-path'([dir, basePath]) {
    if (!dir || !basePath?.startsWith('/')) fail('usage: set-base-path <mockDir> </base/path>');
    print({ basePath, filesChanged: setBasePath(dir, basePath) });
  },

  'rename-id-field'([dir, from, to]) {
    if (!dir || !from || !to) fail('usage: rename-id-field <mockDir> <fromField> <toField>');
    print({ from, to, filesChanged: renameIdField(dir, from, to) });
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
const positional = rest.filter(a => !a.startsWith('--'));
const opts = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => [a.slice(2), true]));
await commands[cmd](positional, opts);
