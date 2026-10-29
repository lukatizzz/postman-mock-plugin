---
name: mock-import
description: Import an OpenAPI YAML/JSON file into Postman and build a mock - creates the spec, generates a collection, makes sure every API has a clean example for each documented status code, creates a (private) mock server and records everything in .postman-mock/state.json. Use when the user wants a Postman mock server, mock URL or mock examples from an OpenAPI file.
---

# Import OpenAPI -> Postman collection, examples, mock server

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/` (call as `node <scripts>/postman-rest.mjs ...`).
State format: `../mock-setup/references/state.md`. If `.postman-mock/state.json` is missing or has no `workspaceId`, run the **mock-setup** steps first.
Matching rules and pitfalls verified on real Postman: `../mock-set/references/postman-matching.md`.

Free plan budget: a full import of a small spec costs ~5 Postman API calls plus 1 per example you fix. Answer from state instead of listing again.

## 1. Read the spec
- Read the file. Confirm OpenAPI 2.0 / 3.0 / 3.1 and < 12 MB.
- Inventory each operation: method, path, documented status codes, the example (or schema) per response.
- Note the **base path** of `servers[0].url` (e.g. `/v1` in `https://api.example.com/v1`). The mock serves paths *under* it: `<mockUrl>/v1/pets`.
- Compute `sha256` of the file. If state already has a collection for this spec, do NOT import again: run the spec sync (`node <scripts>/spec-sync.mjs <projectRoot> --dry-run`, then without `--dry-run` after the user agrees; or the hub's "Đồng bộ từ spec" / MCP `sync_from_spec`). It updates the existing collection in place and keeps ids and scenario examples. Only create a new collection if the user explicitly wants a separate one.

## 2. Create the collection
Use the Postman MCP tools if available, otherwise the script (same endpoints):

| Step | MCP tool | Script |
|---|---|---|
| Create spec | `createSpec` | `create-spec <file> --workspace <id>` |
| Generate collection (async) | `generateCollection` + poll `getAsyncSpecTaskStatus` with backoff | `generate-collection <specId> --name "<title>"` (polls for you) |

The finished task returns `details.resources[0].id` = the collection **UID** (`ownerId-collectionId`). Save `specId`, `collectionUid`, `specHash`, `sourceSpec`.
Fallback if generation fails: `import-openapi <file> --workspace <id>` (synchronous).

## 3. Normalize the examples (required - without it ~50% of a real spec answers wrongly)
Postman generates one example per documented status code from the spec. Out of the box they break matching
(measured on a real 96-endpoint spec: 48/96 endpoints returned the wrong example or 404):
- path variables saved with values like `"string"` are NOT wildcards -> 404 for real ids;
- item endpoints (`/x/:id`) get answered by list endpoints (`/x`);
- endpoints whose success code is 201/204 get answered by a 401/500 example (Postman's tie-break prefers 200 only);
- random query values (`?searchWord=string&page=1`) skew the score.

Fix everything in one call (keeps all ids):
```
node <scripts>/postman-rest.mjs normalize-collection <collectionUid>
```
It makes the lowest 2xx example of every request the default (`{{baseUrl}}/path/{{var}}`, no query) and moves every other example behind `?__example=<code>`, so errors only answer when asked for with `x-mock-response-code: <code>`. Examples named `... :: ...` (user scenarios) are left alone.

Then:
- `export-collection <collectionUid> --out .postman-mock/collection.json`
- `node <scripts>/analyze-collection.mjs .postman-mock/collection.json` - lists requests without examples, empty bodies, `<string>` placeholders. Fill/fix those with `upsert-example` (format in **mock-set**). Never send collection v2.1 fields to `createCollectionResponse`/`updateCollectionResponse`: they are silently dropped.
- Record request ids and default example ids per endpoint in state.

## 4. Create the mock
MCP `createMock` (collection = UID, `private: true`) or `create-mock <collectionUid> --workspace <id> --name "<title> mock"`.
Private by default; callers send `x-api-key`. Public only if the user asks (`publishMock`). Save `mock.id`, `mock.url`.

## 5. Local copy
`export-collection <collectionUid> --out .postman-mock/collection.json` again after the fixes.

## 6. Verify and report
- `node <scripts>/verify-mock.mjs .postman-mock/collection.json <mockUrl>` calls every endpoint once and checks it returns its own default example (uses ~1 mock call per endpoint). Expect N/N; re-run single failures with `--only <path>` (Postman occasionally returns a transient 500 under parallel load).
- Table: endpoint | example codes. Then the URLs:
  ```
  curl -H "x-api-key: $POSTMAN_API_KEY" <mockUrl><basePath>/pets/1
  node <scripts>/local-mock.mjs --collection .postman-mock/collection.json --port 4010   # http://localhost:4010<basePath>
  ```
- Suggest **mock-set** for custom cases.
