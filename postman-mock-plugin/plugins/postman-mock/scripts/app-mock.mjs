#!/usr/bin/env node
// Helpers for Postman app "local mocks" (postman/mocks/<mock>/config.yaml + <scenario>.js),
// the JavaScript mocks that run in the Postman desktop app (Local View) or with `postman mock run`.
// Generate the mock itself with the Postman CLI:  postman mock generate <spec> --output postman/mocks/<name>
// No dependencies; Node 18+.
//
// Commands:
//   add-scenario <mockDir> <name> <overrides.json> [--make-default]
//       Copies the default scenario's handler into <name>.js, injects the overrides in front of the
//       generated routes and registers the scenario in config.yaml. Select it per request with
//       the header `x-mock-scenario: <name>`, or make it the default with --make-default.
//       overrides.json: [{ "method": "GET", "path": "/v1/pets/:petId", "status": 200,
//                          "body": {...}, "headers"?: {...}, "query"?: {"k": "v"}, "delayMs"?: 0 }]
//   remove-scenario <mockDir> <name>
//   list <mockDir>
//   set-base-path <mockDir> </api/v1>
//       Accept requests under a base path that the generator dropped (relative {{baseUrl}}).
//   rename-id-field <mockDir> <fromField> <toField>
//       Stateful mocks key entities by the path variable (e.g. petId); rename it to the schema's id field.

import fs from 'node:fs';
import path from 'node:path';

const fail = msg => { console.error(msg); process.exit(1); };
const CONFIG = 'config.yaml';

function readConfig(dir) {
  const file = path.join(dir, CONFIG);
  if (!fs.existsSync(file)) fail(`No ${CONFIG} in ${dir}. Generate the mock first: postman mock generate <spec> --output ${dir}`);
  return fs.readFileSync(file, 'utf8');
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

const commands = {
  list([dir]) {
    console.log(JSON.stringify(parseScenarios(readConfig(dir)), null, 2));
  },

  'add-scenario'([dir, name, overridesFile], opts) {
    if (!dir || !name || !overridesFile) fail('usage: add-scenario <mockDir> <name> <overrides.json> [--make-default]');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('Scenario name must be lower-case ASCII, digits and dashes (it is sent in a header).');
    const yaml = readConfig(dir);
    const scenarios = parseScenarios(yaml);
    const base = scenarios.find(s => s.name === 'default') ?? scenarios.find(s => s.default) ?? scenarios[0];
    if (!base) fail('config.yaml has no scenario to copy');
    let code = fs.readFileSync(path.join(dir, base.path), 'utf8');
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
    const injected = (Array.isArray(overrides) ? overrides : [overrides]).map(routeCode).join('');
    // Inject right after `const pathname = url.pathname...;` in the request handler; handler must be async for delays.
    const anchor = /(const pathname = url\.pathname[^\n]*;\n)/;
    if (!anchor.test(code)) fail(`Could not find the request handler in ${base.path}`);
    code = code.replace('http.createServer((req, res) =>', 'http.createServer(async (req, res) =>')
      .replace(anchor, `$1\n  // ─── scenario "${name}" overrides ───\n${injected}`)
      .replace(/^\/\*\*\n \* Autogenerated.*\n \*\//m, `/**\n * Scenario "${name}" - generated by postman-mock app-mock.mjs from ${base.path}\n */`);
    const file = `./${name}.js`;
    fs.writeFileSync(path.join(dir, file), code);
    const next = scenarios.filter(s => s.name !== name).map(s => ({ ...s, default: opts['make-default'] ? false : s.default }));
    next.push({ name, path: file, default: !!opts['make-default'] });
    writeScenarios(dir, yaml, next);
    console.log(JSON.stringify({ scenario: name, file: path.join(dir, file), default: !!opts['make-default'], header: `x-mock-scenario: ${name}` }, null, 2));
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
    console.log(JSON.stringify({ removed: name }, null, 2));
  },

  // Mocks generated from a collection whose {{baseUrl}} is relative (e.g. /api/v1) lose that prefix.
  // This makes every scenario accept both /api/v1/x and /x.
  'set-base-path'([dir, basePath]) {
    if (!dir || !basePath?.startsWith('/')) fail('usage: set-base-path <mockDir> </base/path>');
    const escaped = basePath.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/');
    let changed = 0;
    for (const s of parseScenarios(readConfig(dir))) {
      const file = path.join(dir, s.path);
      const code = fs.readFileSync(file, 'utf8');
      const next = code.replace(/const pathname = url\.pathname[^\n]*;/,
        `const pathname = url.pathname.replace(/^${escaped}(?=\\/|$)/, '') || '/';`);
      if (next !== code) { fs.writeFileSync(file, next); changed++; }
    }
    console.log(JSON.stringify({ basePath, filesChanged: changed }, null, 2));
  },

  'rename-id-field'([dir, from, to]) {
    if (!dir || !from || !to) fail('usage: rename-id-field <mockDir> <fromField> <toField>');
    const scenarios = parseScenarios(readConfig(dir));
    let changed = 0;
    for (const s of scenarios) {
      const file = path.join(dir, s.path);
      const code = fs.readFileSync(file, 'utf8');
      const next = code.split(`['${from}']`).join(`['${to}']`);
      if (next !== code) { fs.writeFileSync(file, next); changed++; }
    }
    console.log(JSON.stringify({ from, to, filesChanged: changed }, null, 2));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
const positional = rest.filter(a => !a.startsWith('--'));
const opts = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => [a.slice(2), true]));
commands[cmd](positional, opts);
