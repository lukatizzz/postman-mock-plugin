---
name: mock-app
description: Create or update a Postman code mock (JavaScript mock with scenarios, optionally stateful) stored only in the Postman cloud workspace - nothing is written to the project except a small definition file. Builds it from a Postman collection or an OpenAPI spec, adds scenarios selectable with the x-mock-scenario header, and runs it with `postman mock run <mockId>` or from the Postman app. Use when the user wants a mock in Postman's Mocks (code mocks), scenario-based or stateful mocks.
---

# Postman code mock in the cloud (JavaScript, scenarios, optional state)

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/` (`app-mock.mjs`, `verify-mock.mjs`, `postman-rest.mjs`).
The mock code lives **only in the Postman cloud workspace** (Mocks in the Postman app). Never write `postman/mocks/` folders into the user's project and never touch the project's `.postman/` folder (it belongs to the Postman app's Git link).

## 0. Requirements (check once)
- Postman CLI: `postman --version`; install with `npm install -g postman-cli` (published by Postman).
- Logged in: if a CLI call says it is not logged in, ask the user to run `postman login --with-api-key <their key>` themselves (do not put the key in the chat).
- `POSTMAN_API_KEY` set (used to download the collection).
- Workspace id: from `.postman-mock/state.json` (`workspaceId`) or `getWorkspaces`.
- Free plan: creating, updating and running code mocks works. Deploying a mock to a public mock-server URL (`postman mock deploy`) needs Solo/Team/Enterprise - only offer it if the user asks.

## 1. Write the definition
File: `.postman-mock/code-mocks/<slug>.json` (git-ignored; this is the only local file).
```json
{
  "name": "JumpApp code mock",
  "workspace": "<workspaceId>",
  "mockId": null,
  "source": { "collection": "<collectionUid>" },
  "basePath": "/api/v1",
  "stateful": false,
  "scenarios": {
    "qa-edge-cases": [
      { "method": "GET", "path": "/constructions/99999999", "status": 404, "body": { "message": "not found" } },
      { "method": "GET", "path": "/tasks", "query": { "searchWord": "none" }, "status": 200, "body": { "tasks": [] } },
      { "method": "POST", "path": "/auth/login", "status": 401, "delayMs": 800, "body": { "code": "ACCOUNT_LOCKED" } }
    ]
  }
}
```
- **source**: prefer `{ "collection": "<uid>" }` (the cleaned collection from **mock-import**). `{ "spec": "<path>" }` also works but deep `$ref`/`allOf` schemas then produce `"<Error: Too many levels of nesting to fake this schema>"` bodies.
- **basePath** (collection source only): the base path of `servers[0].url` (e.g. `/api/v1`, `/v1`). Collection generation drops it; with this set the mock answers both `/api/v1/x` and `/x`. Spec generation keeps the server path in the routes, so leave `basePath` out there (it is ignored).
- **paths in scenarios**: the routes as generated, path params as `:name` - collection source: without the base path (`/pets/:petId`); spec source: with it (`/v1/pets/:petId`). When unsure, run `postman mock get <mockId> --json` after the first push to list the endpoints.
- **scenario names**: lower-case ASCII + dashes (sent in the `x-mock-scenario` header).
- **stateful: true** builds CRUD handlers on `pm.state` (POST then GET returns it). If entities get keyed by the path variable (`petId`) while the schema uses `id`, add `"idField": { "from": "petId", "to": "id" }`.
- Map the user's request ("when X return Y") to overrides exactly like **mock-set** does; validate bodies against the OpenAPI schema and warn on mismatches.

## 2. Push to the cloud
`node <scripts>/app-mock.mjs cloud-push .postman-mock/code-mocks/<slug>.json`
- Builds the code in a temporary folder, pushes it, deletes the folder, and writes `mockId` + `postmanUrl` back into the definition.
- Re-run after any change to update **the same** cloud mock (`created: false`).
- A push never deletes a cloud scenario. To retire one, remove it from `scenarios` and add its name to `"retiredScenarios": ["name"]` (it is reset to default behaviour); tell the user they can delete it for good in the Postman app (Mocks -> the mock -> scenario).
- Record the mock in `.postman-mock/state.json` under `codeMocks` (name, mockId, definition file).

## 3. Run and verify
- Run from the cloud: `postman mock run <mockId> --port <port>` as a background process (prints `Mock server started: <name> at http://localhost:<port>`), or open the mock in the Postman app (Mocks) and start it there.
- Verify when a collection export exists: `node <scripts>/verify-mock.mjs .postman-mock/collection.json http://localhost:<port>` -> expect N/N. Then call one scenario endpoint with `x-mock-scenario: <name>`.
- Show the user: Postman URL of the mock, the run command, and curl examples:
  `curl http://localhost:<port>/api/v1/tasks`, `curl -H "x-mock-scenario: qa-edge-cases" http://localhost:<port>/api/v1/constructions/99999999`, `curl -H "x-mock-response-code: 401" ...`.
- Stop only processes you started (`postman ... mock run <mockId>` and its `mock-server-worker` child). **Never kill every `postman` / `Postman.exe` process - that closes the user's Postman desktop app.**

## Behaviour notes (verified 2026-10-30, Postman CLI 1.82.0, free plan)
- Without `x-mock-scenario` the default scenario answers; an unknown scenario name silently falls back to default.
- Non-default status codes of the collection answer `x-mock-response-code: <code>`.
- `postman mock generate --collection <uid> -w <ws>` also creates a cloud mock linked to the collection, but it cannot be updated by `push` ("A scenario with this name already exists"); this skill therefore always creates the mock through `cloud-push`.
- `postman mock push` records path -> mock id in `<cwd>/.postman/resources.yaml`; `cloud-push` runs it inside the temp folder so the user's project is untouched.
