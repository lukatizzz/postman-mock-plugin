---
name: mock-app
description: Build a Postman app "local mock" (JavaScript mock in postman/mocks/<name>/ with config.yaml and scenario .js files) from an OpenAPI spec or a Postman collection, add scenarios selectable with the x-mock-scenario header, optionally stateful (CRUD with pm.state), and run it with the Postman desktop app (Local View) or `postman mock run`. Use when the user wants a mock that runs in the Postman app, a stateful mock, or scenario-based mocks without the cloud.
---

# Postman app local mock (JavaScript, scenarios, optional state)

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/` (`app-mock.mjs`, `verify-mock.mjs`, `postman-rest.mjs`).
Verified on real specs - see the notes at the end before choosing options.

## 0. Requirements
- Postman CLI: `postman --version` (install: `npm install -g postman-cli`, published by Postman). No login needed for local mocks.
- Mocks live in `postman/mocks/<mock-name>/` of the user's **Git project**. To see/start them in the desktop app the project must be connected with Native Git and opened in **Local View** (all plans). Deploying to the cloud (`postman mock deploy`) needs Solo/Team/Enterprise - not on the free plan.

## 1. Generate
Pick the source:
- **From the Postman collection (preferred when one exists, e.g. after mock-import)** - bodies come from the cleaned examples:
  `node <scripts>/postman-rest.mjs export-collection <collectionUid> --out .postman-mock/collection.json`, unwrap it
  (`{ "collection": {...} }` -> the inner object) to e.g. `.postman-mock/collection.v21.json`, then
  `postman mock generate .postman-mock/collection.v21.json --output postman/mocks/<name> --name "<Name>" --port <port>`
- **From the OpenAPI file** (no Postman account needed):
  `postman mock generate <spec.yaml> --output postman/mocks/<name> --name "<Name>" --port <port>` (add `--stateful` for CRUD).

Generator output: `config.yaml` (name, port, `scenarios` list, `default: true`) and `default.js` (a plain `http.createServer` handler with `// @endpoint` comments; non-default status codes answer `x-mock-response-code: <code>`).

## 2. Post-fix (check each)
- **Placeholders**: `grep -c "Too many levels of nesting" postman/mocks/<name>/default.js`. Spec-based generation leaves `"<Error: Too many levels of nesting to fake this schema>"` for deep `$ref`/`allOf` schemas (363 occurrences on a 96-endpoint spec). If > 0, regenerate from the collection instead.
- **Base path**: collection-based generation drops a relative `{{baseUrl}}` such as `/api/v1`. Run `node <scripts>/app-mock.mjs set-base-path postman/mocks/<name> /api/v1` so both `/api/v1/x` and `/x` work.
- **Stateful id field**: `--stateful` keys entities by the path variable name (`petId`). If the schema uses `id`: `node <scripts>/app-mock.mjs rename-id-field postman/mocks/<name> petId id`.

## 3. Scenarios (the "set a value for a specific case" feature)
Write the overrides as JSON (paths as in the `// @endpoint` lines, after any base-path stripping):
```json
[
  { "method": "GET", "path": "/constructions/99999999", "status": 404, "body": { "message": "not found" } },
  { "method": "GET", "path": "/tasks", "query": { "searchWord": "none" }, "status": 200, "body": { "tasks": [] } },
  { "method": "POST", "path": "/auth/login", "status": 401, "delayMs": 800, "body": { "code": "ACCOUNT_LOCKED" } }
]
```
`node <scripts>/app-mock.mjs add-scenario postman/mocks/<name> <scenario-name> <overrides.json> [--make-default]`
- Scenario names: lower-case ASCII + dashes (they travel in a header).
- The scenario file is a copy of the default handler with the overrides in front, so every other endpoint keeps working.
- Callers pick it with `x-mock-scenario: <scenario-name>`; without the header the default scenario answers. `--make-default` makes it answer without a header.
- List / remove: `app-mock.mjs list <dir>`, `app-mock.mjs remove-scenario <dir> <name>` (ask before removing).
- Re-running `postman mock generate --update <dir>` regenerates only `default.js`; re-apply `set-base-path` / `rename-id-field` afterwards. Scenario files are kept but were copied from the old default - re-create them if endpoints changed.

## 4. Run and verify
- CLI: run `postman mock run postman/mocks/<name>` as a background process (it prints `Mock server started: <Name> at http://localhost:<port>`).
- Desktop app: Local View -> Mocks -> select the mock -> Start (port from `config.yaml`, editable in the mock's Edit dialog).
- If a collection export exists: `node <scripts>/verify-mock.mjs .postman-mock/collection.json http://localhost:<port>` (add `--base-path ""` to test without the prefix). Expect N/N.
- Print ready-to-run curl commands, including one with `x-mock-scenario`.
- Stopping: stop only the processes you started (`postman.exe ... mock run ...` and its `mock-server-worker` child). **Never kill every `postman`/`Postman.exe` process - that closes the user's Postman desktop app.**

## Verified notes (PoC 2026-10-30, Postman CLI 1.82.0)
- Petstore: static + stateful mocks, scenario switching via `x-mock-scenario`, `x-mock-response-code`, override delay - all OK with `postman mock run`.
- JumpApp (96 requests): collection-based + `set-base-path` -> 96/96 endpoints return their default example, both with and without `/api/v1`; scenario overrides OK.
- Unknown `x-mock-scenario` value silently falls back to the default scenario.
- Not verified yet: starting the mock from the Postman desktop app UI (Local View / Native Git).
