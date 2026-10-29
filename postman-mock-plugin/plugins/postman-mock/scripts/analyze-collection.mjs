#!/usr/bin/env node
// Reports problems in an exported Postman collection that break mock matching.
// No dependencies; Node 18+.
//
// Usage: node analyze-collection.mjs <collection.json> [--json]

import fs from 'node:fs';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('usage: node analyze-collection.mjs <collection.json> [--json]');
  process.exit(1);
}
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const collection = json.collection ?? json;

const PLACEHOLDER = /<(string|integer|number|boolean|long|double|float|dateTime|date|uuid|email|uri|object|array)>/;
const report = { variables: collection.variable ?? [], requests: 0, examples: 0, issues: {} };
const add = (kind, entry) => (report.issues[kind] ??= []).push(entry);
const names = new Map();

const walk = (items, folder) => {
  for (const item of items ?? []) {
    if (item.item) { walk(item.item, item.name); continue; }
    report.requests++;
    const method = item.request?.method;
    const endpoint = `${method} /${(item.request?.url?.path ?? []).join('/')}`;
    const responses = item.response ?? [];
    if (!responses.length) add('noExamples', { endpoint, requestId: item.id });
    for (const r of responses) {
      report.examples++;
      const ref = { endpoint, requestId: item.id, exampleId: r.id, name: r.name, code: r.code };
      const url = r.originalRequest?.url ?? {};
      const query = (url.query ?? []).filter(q => !q.disabled);
      if (query.length) add('queryInExample', { ...ref, query: query.map(q => `${q.key}=${q.value}`).join('&') });
      const pathVars = (url.variable ?? []).filter(v => v.value !== undefined && v.value !== '');
      if (pathVars.length) add('pathVariableWithValue', { ...ref, vars: pathVars.map(v => `${v.key}=${v.value}`).join(',') });
      const emptyVars = (url.variable ?? []).filter(v => v.value === '' || v.value === undefined);
      if (emptyVars.length) add('pathVariableEmpty', { ...ref, vars: emptyVars.map(v => v.key).join(',') });
      const body = String(r.body ?? '');
      if (!body.trim() && r.code !== 204 && r.code !== 304) add('emptyBody', ref);
      if (PLACEHOLDER.test(body)) add('placeholderInBody', { ...ref, sample: body.match(PLACEHOLDER)[0] });
      const key = r.name;
      if (names.has(key)) add('duplicateName', { ...ref, alsoIn: names.get(key) });
      else names.set(key, endpoint);
    }
  }
};
walk(collection.item);

if (flag === '--json') {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`variables: ${report.variables.map(v => `${v.key}=${v.value}`).join(', ')}`);
  console.log(`requests: ${report.requests}, examples: ${report.examples}`);
  for (const [kind, list] of Object.entries(report.issues)) {
    console.log(`\n${kind}: ${list.length}`);
    for (const e of list.slice(0, 5)) console.log('  ' + JSON.stringify(e));
    if (list.length > 5) console.log(`  ... ${list.length - 5} more`);
  }
}
