---
name: mock-import
description: Import an OpenAPI YAML/JSON file into Postman - creates the spec, generates a collection with a clean example for each documented status code, caches it locally and creates the Mock Hub mock for it. If the project already has a collection for the spec, syncs it instead of importing again. Use when the user wants a Postman collection or a mock from an OpenAPI file.
---

# Import OpenAPI -> Postman spec + collection (+ hub mock)

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/` (`postman-rest.mjs`, `spec-sync.mjs`, `analyze-collection.mjs`).
State format: `../mock-setup/references/state.md`. If `.postman-mock/state.json` has no `workspaceId`, run **mock-setup** first.
Postman API budget (free plan 10,000/month): a full import costs ~5 calls plus 1 per example you fix.

## 1. Read the spec
- Read the file. Confirm OpenAPI 2.0 / 3.0 / 3.1 and < 12 MB.
- Inventory each operation: method, path, documented status codes, the example (or schema) per response.
- Note the base path of `servers[0].url` (e.g. `/v1`). The collection's `{{baseUrl}}` keeps it; the hub mock uses it.
- **If `state.json` already has `collectionUid` for this spec: do NOT import again.** Run the sync instead:
  `node <scripts>/spec-sync.mjs <projectRoot> --dry-run`, show the report, then without `--dry-run` once the user agrees
  (or the hub's "Đồng bộ từ spec" / MCP `sync_from_spec`). It updates the same collection in place, keeping ids and scenario examples.

## 2. Create spec and collection
Postman MCP tools if available, otherwise the script (same endpoints):

| Step | MCP tool | Script |
|---|---|---|
| Create spec | `createSpec` | `create-spec <file> --workspace <id>` |
| Generate collection (async) | `generateCollection` + poll `getAsyncSpecTaskStatus` with backoff | `generate-collection <specId> --name "<title>"` (polls) |

The finished task returns `details.resources[0].id` = the collection **UID** (`ownerId-collectionId`).
Fallback if generation fails: `import-openapi <file> --workspace <id>` (synchronous; no spec in Postman).
Save in `state.json`: `specId`, `collectionUid`, `sourceSpec` (path of the yml, relative to the project when possible), `specHash` (sha256 of the file).

## 3. Clean the examples
`node <scripts>/postman-rest.mjs normalize-collection <collectionUid>` (one PUT, ids kept): the lowest 2xx example of every request becomes the default (`{{baseUrl}}/path/{{var}}`, no query); other examples are tagged `?__example=<code>` and are selected with `x-mock-response-code`.
Then `export-collection <collectionUid> --out .postman-mock/collections/<collectionUid>.json` (the hub's local cache) and
`node <scripts>/analyze-collection.mjs .postman-mock/collections/<collectionUid>.json` - requests without examples, empty bodies, `<string>` placeholders.
Fix those in Postman with `upsert-example` (the Postman API only stores the legacy fields this script builds):
```json
{ "name": "200 OK", "code": 200, "body": { "id": 1 }, "request": { "method": "GET", "url": "{{baseUrl}}/pets/{{id}}" } }
```
`node <scripts>/postman-rest.mjs upsert-example <file.json> --collection <uid> --request <requestId>` (new) or `--response <exampleId>` (update).
Bodies: keep the spec example; replace placeholders with realistic data from the schema.

## 4. Mock in the Mock Hub
- If the hub is running (`http://localhost:4800`), create the mock: dashboard "+ Mock mới" (collection and base path default to the project's), or REST `POST /api/projects/<project>/mocks` `{ "mock": "<name>" }` with header `x-dashboard: 1`, or MCP `create_mock`.
- Otherwise tell the user to start it (**mock-dashboard**): `node <scripts>/dashboard.mjs --port 4800 --project <name>` and create the mock there.
- Verify: `node <scripts>/verify-mock.mjs .postman-mock/collections/<collectionUid>.json http://localhost:4800/gw/<project>/<mock>` -> expect N/N.

## 5. Report
Table endpoint | example codes, the Postman collection, the mock URL (`http://localhost:4800/gw/<project>/<mock><basePath>`), and how to add mock data (**mock-dashboard**: "+ Tạo dữ liệu mock", or MCP `upsert_case`).
