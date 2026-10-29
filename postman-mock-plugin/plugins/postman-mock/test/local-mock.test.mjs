// Run: node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, extractExamples, loadCollection } from '../scripts/local-mock.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-collection.json');
let server, base;

before(async () => {
  server = createServer({ collection: fixture, log: () => {} });
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, p, { headers = {}, body } = {}) => {
  // The fixture's {{baseUrl}} is https://api.example.com/v1, so the mock serves under /v1 like Postman.
  const res = await fetch(base + '/v1' + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('extracts every example', () => {
  const { examples } = extractExamples(loadCollection(fixture));
  assert.equal(examples.length, 10);
});

test('path is matched under the base path of {{baseUrl}}', async () => {
  const res = await fetch(base + '/pets/1');
  assert.equal(res.status, 404);
});

test('a saved path variable value acts as a literal', async () => {
  assert.equal((await call('GET', '/pets/42')).body.name, 'Rex');
  assert.equal((await call('GET', '/pets/7')).body.name, 'Milo');
});

test('wildcard path returns the default 200 example', async () => {
  const r = await call('GET', '/pets/1');
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Milo');
});

test('literal path scenario beats the wildcard (strategy A)', async () => {
  const r = await call('GET', '/pets/999');
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'PET_NOT_FOUND');
});

test('x-mock-response-name picks a named scenario (strategy B)', async () => {
  const r = await call('GET', '/pets/1', { headers: { 'x-mock-response-name': 'GET /pets/{petId} :: pet-sold' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'sold');
});

test('unknown x-mock-response-name returns mockRequestNotFoundError', async () => {
  const r = await call('GET', '/pets/1', { headers: { 'x-mock-response-name': 'nope' } });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.name, 'mockRequestNotFoundError');
});

test('x-mock-response-code filters by status', async () => {
  const r = await call('GET', '/pets/1', { headers: { 'x-mock-response-code': '404' } });
  assert.equal(r.status, 404);
});

test('query match selects the filtered list', async () => {
  assert.equal((await call('GET', '/pets?status=sold')).body.length, 1);
  assert.equal((await call('GET', '/pets')).body.length, 2);
  // Verified on Postman: a scenario with the same query key also wins for other values of that key.
  assert.equal((await call('GET', '/pets?status=available')).body.length, 1);
});

test('ID-like segments match fuzzily (Postman -21 rule)', async () => {
  const r = await call('GET', '/pets/5', { headers: { 'x-mock-response-code': '404' } });
  assert.equal(r.status, 404);
});

test('UTF-8 x-mock-response-name is decoded', async () => {
  const name = Buffer.from('GET /pets/{petId} :: pet-sold', 'utf8').toString('latin1');
  assert.equal((await call('GET', '/pets/1', { headers: { 'x-mock-response-name': name } })).body.status, 'sold');
});

test('matching request body wins (strategy C)', async () => {
  const wrong = await call('POST', '/auth/login', { body: { email: 'user@example.com', password: 'wrong' } });
  assert.equal(wrong.status, 401);
  const ok = await call('POST', '/auth/login', { body: { email: 'user@example.com', password: 'anything' } });
  assert.equal(ok.status, 200);
});

test('strict body match rejects unknown payloads', async () => {
  const r = await call('POST', '/auth/login', {
    headers: { 'x-mock-match-request-body': 'true' },
    body: { email: 'x@example.com', password: 'x' },
  });
  assert.equal(r.status, 404);
});

test('templating fills dynamic values and echoes request data', async () => {
  const r = await call('POST', '/pets', { body: { name: 'Bông' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'Bông');
  assert.match(r.body.id, /^[0-9a-f-]{36}$/);
});

test('unknown route returns 404', async () => {
  assert.equal((await call('GET', '/nothing')).status, 404);
});

test('CORS preflight', async () => {
  const res = await fetch(base + '/pets', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
});
