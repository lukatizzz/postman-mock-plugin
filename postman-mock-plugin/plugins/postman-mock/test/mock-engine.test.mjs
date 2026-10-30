// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../scripts/mock-engine.mjs';

const ex = (name, status, body) => ({ name, status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: [{ key: 'Content-Type', value: 'application/json' }] });
const endpoints = [
  { key: 'GET /pets', method: 'GET', path: '/pets', examples: [ex('List', 200, [{ id: 1 }, { id: 2 }])] },
  { key: 'GET /pets/:petId', method: 'GET', path: '/pets/:petId', examples: [
    ex('Not found', 404, { code: 'NOT_FOUND' }), ex('The pet', 200, { id: 1, name: 'Milo' }), ex('GET /pets/{petId} :: legacy-scenario', 200, { legacy: true }),
  ] },
  { key: 'POST /pets', method: 'POST', path: '/pets', examples: [ex('Created', 201, '{"id":"{{$randomUUID}}","name":"{{$body \'name\' \'none\'}}","pet":"{{$pathParams \'petId\'}}"}')] },
  { key: 'DELETE /pets/:petId', method: 'DELETE', path: '/pets/:petId', examples: [{ name: 'Deleted', status: 204, body: '', headers: [] }] },
  { key: 'POST /auth/login', method: 'POST', path: '/auth/login', examples: [ex('OK', 200, { token: 't' }), ex('Wrong', 401, { code: 'INVALID' })] },
];
const def = {
  version: 2, flows: ['sold-out', 'off'], activeFlow: 'default',
  apis: {
    'GET /pets/:petId': { flows: {
      default: { cases: [
        { name: '999', when: { params: { petId: '999' } }, response: { status: 404, body: { code: 'PET_999' } } },
        { name: 'admin', when: { headers: { 'x-role': 'admin' } }, response: { status: 200, body: { admin: true } } },
      ] },
      'sold-out': { response: { status: 200, body: { status: 'sold' } } },
      off: { enabled: false, response: { status: 500, body: { never: true } } },
    } },
    'GET /pets': { flows: { default: {
      response: { status: 200, body: [{ id: 9 }] },
      cases: [{ name: 'sold', when: { query: { status: 'sold' } }, response: { status: 200, body: [] } }],
    } } },
    'POST /auth/login': { flows: { default: { cases: [
      { name: 'locked', when: { body: { 'user.email': 'locked@x.y' } }, response: { status: 423, delayMs: 300, body: { code: 'LOCKED' } } },
      { name: 'any token', when: { headers: { authorization: '*' } }, response: { status: 200, body: { via: 'header' } } },
    ] } } },
  },
};
const call = (method, p, { headers = {}, body, d = def } = {}) => {
  const [path, qs = ''] = p.split('?');
  const r = respond(d, endpoints, { method, path, fullPath: path, query: new URLSearchParams(qs), headers, bodyText: body && JSON.stringify(body) });
  return { ...r, json: r.body ? JSON.parse(r.body) : null };
};

test('no mock data -> lowest 2xx example', () => {
  const r = call('GET', '/pets/1');
  assert.equal(r.status, 200); assert.equal(r.json.name, 'Milo');
});
test('case on path param', () => assert.equal(call('GET', '/pets/999').json.code, 'PET_999'));
test('case on header', () => assert.equal(call('GET', '/pets/5', { headers: { 'x-role': 'admin' } }).json.admin, true));
test('flow response wins over default cases', () => assert.equal(call('GET', '/pets/999', { headers: { 'x-mock-scenario': 'sold-out' } }).json.status, 'sold'));
test('disabled flow -> default chain', () => {
  assert.equal(call('GET', '/pets/999', { headers: { 'x-mock-scenario': 'off' } }).json.code, 'PET_999');
  assert.equal(call('GET', '/pets/1', { headers: { 'x-mock-scenario': 'off' } }).json.name, 'Milo');
});
test('unknown flow -> default', () => assert.equal(call('GET', '/pets/999', { headers: { 'x-mock-scenario': 'nope' } }).json.code, 'PET_999'));
test('activeFlow is used without header', () => assert.equal(call('GET', '/pets/1', { d: { ...def, activeFlow: 'sold-out' } }).json.status, 'sold'));
test('query case, otherwise flow response', () => {
  assert.deepEqual(call('GET', '/pets?status=sold').json, []);
  assert.deepEqual(call('GET', '/pets?status=available').json, [{ id: 9 }]);
});
test('body case with dotted path + delay', () => {
  const r = call('POST', '/auth/login', { body: { user: { email: 'locked@x.y' } } });
  assert.equal(r.status, 423); assert.equal(r.delayMs, 300);
});
test('"*" means present', () => {
  assert.equal(call('POST', '/auth/login', { headers: { authorization: 'Bearer x' }, body: {} }).json.via, 'header');
  assert.equal(call('POST', '/auth/login', { body: {} }).json.token, 't');
});
test('x-mock-response-code picks the example and bypasses mock data', () => {
  const r = call('GET', '/pets/999', { headers: { 'x-mock-response-code': '404' } });
  assert.equal(r.status, 404); assert.equal(r.json.code, 'NOT_FOUND');
});
test('x-mock-response-name picks any example, scenarios included', () => {
  assert.equal(call('GET', '/pets/1', { headers: { 'x-mock-response-name': 'GET /pets/{petId} :: legacy-scenario' } }).json.legacy, true);
  assert.equal(call('GET', '/pets/1', { headers: { 'x-mock-response-name': 'missing' } }).status, 404);
});
test('templating: $randomUUID, $body, default value', () => {
  const r = call('POST', '/pets', { body: { name: 'Bông' } });
  assert.equal(r.status, 201); assert.equal(r.json.name, 'Bông'); assert.match(r.json.id, /^[0-9a-f-]{36}$/);
  assert.equal(call('POST', '/pets', { body: {} }).json.name, 'none');
});
test('204 has no body', () => { const r = call('DELETE', '/pets/1'); assert.equal(r.status, 204); assert.equal(r.body, ''); });
test('x-mock-response-delay header', () => assert.equal(call('GET', '/pets/1', { headers: { 'x-mock-response-delay': '1200' } }).delayMs, 1200));
test('unknown API -> 404', () => assert.equal(call('GET', '/nothing').status, 404));
test('trace says where the answer came from', () => {
  assert.match(call('GET', '/pets/999').trace.source, /case "999"/);
  assert.match(call('GET', '/pets/1').trace.source, /example "The pet"/);
});
