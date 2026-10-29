---
name: mock-app
description: Create or update a Postman code mock (JavaScript mock with flows/scenarios, conditional cases, optional state) stored only in the Postman cloud workspace - nothing is written to the project except a small definition file. Builds it from a Postman collection or an OpenAPI spec and pushes it; run it with `postman mock run <mockId>`, the Postman app, or the Mock Hub gateway. Use when the user wants a mock in Postman's Mocks (code mocks).
---

# Postman code mock in the cloud

Reply in the user's language. Scripts: `<this skill dir>/../../scripts/` (`app-mock.mjs` build/push, `mock-store.mjs` data model, `dashboard.mjs` hub).
The mock code lives **only in the Postman cloud workspace**. Never write `postman/mocks/` folders into the project and never touch the project's `.postman/` folder (it belongs to the Postman app's Git link).

For editing data afterwards - UI, conditional cases, per-flow enable, Mock/Real per API, or MCP for the team - use **mock-dashboard** (the Mock Hub). It edits the same definition file.

## 0. Requirements
- Postman CLI: `postman --version` (install: `npm install -g postman-cli`, published by Postman). Logged in: ask the user to run `postman login --with-api-key <key>` themselves if a call says it is not.
- `POSTMAN_API_KEY` set (to download the collection). Workspace id: `.postman-mock/state.json` (`workspaceId`).
- Free plan: create / update / run code mocks works; `postman mock deploy` (public mock-server URL) needs a paid plan.

## 1. Definition (version 2)
File `.postman-mock/code-mocks/<mock>.json` (git-ignored). Full format and resolution order: header of `mock-store.mjs`; example: `<plugin>/examples/petstore-code-mock.json`.
```json
{
  "version": 2, "name": "JumpApp code mock", "workspace": "<id>", "mockId": null,
  "source": { "collection": "<collectionUid>" }, "basePath": "/api/v1",
  "realBaseUrl": "", "defaultMode": "mock", "activeFlow": "default", "flows": ["qa-edge-cases"],
  "apis": {
    "GET /constructions/:constructionNo": { "flows": {
      "default": { "cases": [ { "name": "not found", "when": { "params": { "constructionNo": "99999999" } }, "response": { "status": 404, "body": { "message": "not found" } } } ] },
      "qa-edge-cases": { "enabled": false }
    } }
  }
}
```
- **source**: prefer `{ "collection": "<uid>" }` (cleaned by **mock-import**). `{ "spec": "<path>" }` works too, but deep `$ref`/`allOf` schemas give `"<Error: Too many levels of nesting...>"` bodies.
- **basePath** (collection sources only): e.g. `/api/v1`; the mock then answers `/api/v1/x` and `/x`. Spec-generated routes already include the server path (API keys like `GET /v1/pets/:petId`).
- **API keys**: `"METHOD /path/:param"` exactly as generated - the hub's `list_apis` / `GET .../mocks/<m>` shows them.
- **Conditions** (`when`): `params`, `query`, `headers`, `body` (dotted paths); all must match; `"*"` = any value. First matching case wins; then the flow response; then the default flow; then the collection example. `enabled: false` on a flow entry -> default data for that API in that flow.
- Flow names: lower-case ASCII + dashes (sent in `x-mock-scenario`).
- `stateful: true` -> CRUD handlers on `pm.state`; `"idField": { "from": "petId", "to": "id" }` if entities get keyed by the path variable.
- Validate bodies against the OpenAPI response schema and warn on mismatches.

## 2. Push
`node <scripts>/app-mock.mjs cloud-push .postman-mock/code-mocks/<mock>.json`
- Generates in a temp folder, compiles the data into one JS file per flow, pushes, deletes the folder, writes `mockId`/`postmanUrl`/`pushedHash` back. Re-run to update the same cloud mock.
- A push never deletes a cloud scenario: removed flows are listed in `retiredFlows` and re-pushed with default data (delete them for good in the Postman app).
- Inspect without pushing: `node <scripts>/app-mock.mjs build <definition.json> <emptyDir>` then `postman mock run <emptyDir>`.
- v1 definitions (with `defaults` / `scenarios`) are migrated automatically when the hub opens them; `cloud-push` refuses them until then.

## 3. Run and verify
- `postman mock run <mockId> --port <port>` (background), or the hub gateway `http://localhost:4800/gw/<project>/<mock>/...` which starts it on demand.
- Check with curl, including `x-mock-scenario: <flow>` and the request parts used in conditions.
- Stop only processes you started. **Never kill every `postman` / `Postman.exe` process** - that closes the user's Postman desktop app.

## Verified behaviour (2026-10-30, Postman CLI 1.82.0, free plan)
- Conditions on path params, headers, query and body, flow fallback and disabled flows: 14/14 on Petstore, 18/18 + 20/20 through the hub on a 96-endpoint spec.
- `postman mock push` records path -> mock id in `<cwd>/.postman/resources.yaml`; pushes run inside the temp folder so the project is untouched.
- `postman mock generate --collection <uid> -w <ws>` creates a linked mock that `push` cannot update; always create mocks through `cloud-push`.
- The mock sandbox blocks outbound network (no proxying to real APIs from mock code).
