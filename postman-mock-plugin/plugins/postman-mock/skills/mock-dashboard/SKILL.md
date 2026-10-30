---
name: mock-dashboard
description: Run and use the Mock Hub - a mock server built on the project's Postman collection with a dashboard to edit what every API returns per flow (scenario) using conditional cases with a default fallback, per-API enable/disable per flow, per-API Mock/Real switch (real APIs are called directly via a routing table), spec-change sync, and an MCP endpoint so teammates can create mock data from Claude/Codex. Changes apply immediately. Use for mock URLs, mock data, scenarios, mixing mocked and real APIs, or the shared hub / MCP.
---

# Mock Hub (mock server + dashboard + MCP)

Reply in the user's language. Scripts: `<this skill dir>/../../scripts/` - `dashboard.mjs` (server), `dashboard.html` (UI),
`mock-engine.mjs` (answers requests), `mock-store.mjs` (data model), `spec-sync.mjs` (OpenAPI changes).
Needs a collection from **mock-import** (`state.json` `collectionUid`). No Postman mock servers and no Postman CLI are involved.

## Concepts
- The hub serves `http://<hub>/gw/<project>/<mock><basePath>/...` from the collection's examples (cached in `.postman-mock/collections/`, works offline) plus the mock data in `.postman-mock/code-mocks/<mock>.json`. **Every change applies immediately.**
- **Flow** = scenario. `default` is what clients get without choosing; others via header `x-mock-scenario: <flow>` or the hub's "active flow".
- Per API and flow: **cases** (conditions -> response, first match wins), an optional **flow response** (no condition), and **enabled**.
  Resolution: flow cases -> flow response -> default cases -> default response -> collection example (lowest 2xx).
  A **disabled** API in a flow answers with the default flow's data (disabled in `default` -> the collection example).
- **Conditions** (`when`, all must match, `"*"` = present with any value): `params` (path params by name), `query`, `headers` (case-insensitive), `body` (dotted JSON paths).
- Request headers: `x-mock-scenario`, `x-mock-response-code: 404` (that example of the collection, bypassing mock data), `x-mock-response-name: <example name>`, `x-mock-response-delay: <ms>`. Response header `x-mock-source` says what answered.
- Dynamic values in bodies: `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomFullName}}`, `{{$body 'a.b' 'default'}}`, `{{$queryParams 'k'}}`, `{{$headers 'k'}}`, `{{$pathParams 'id'}}`.
- **Mode** per API: `mock` or `real`. The gateway forwards a real-mode request to `realBaseUrl` (method, headers including `Authorization`, body) and returns the real response with `x-gateway-mode: real`, so a client can use the gateway as its only base URL. Clients may also call the real API directly with `GET /gw/<project>/<mock>/__routes` or the ES module `/__client.js` (`urlFor(method, path)`).
- **realBaseUrl is saved per project** in `state.json` and reused by every mock (also new ones); a mock may override it (`realScope: "mock"`). Do not ask again if `list_projects` already shows one.

## Run it
- **Local** (one project = current folder, 127.0.0.1, no login): `node <scripts>/dashboard.mjs --port 4800 [--project <name>]` from the project root, in a terminal the user can see and stop (Ctrl+C). Open `http://localhost:4800/`. Needs `POSTMAN_API_KEY` only to download/refresh the collection.
- **Shared team hub** (several projects, tokens, network): copy `<plugin>/examples/hub.example.json` to the server as `hub.json`, set projects / publicUrl, then
  - `node <scripts>/dashboard.mjs --hub hub.json --new-token <person> [--projects a,b]` (prints the token once, stores its SHA-256);
  - `node <scripts>/dashboard.mjs --hub hub.json` (Node 18+, `POSTMAN_API_KEY`). Put it behind HTTPS or a VPN.
- Teammates connect their agent to the hub MCP themselves (never paste tokens into the chat):
  - Claude Code: `claude mcp add --transport http mock-hub https://<hub>/mcp --header "Authorization: Bearer <token>"`
  - Codex `~/.codex/config.toml`: `[mcp_servers.mock-hub]` `url = "https://<hub>/mcp"` `bearer_token_env_var = "MOCK_HUB_TOKEN"`

## Creating mock data for the user
Prefer the hub MCP tools when connected: `list_projects`, `list_mocks`, `create_mock`, `list_apis`, `get_api`, `set_api_response`, `clear_api_response`, `upsert_case`, `remove_case`, `set_api_enabled`, `set_api_mode`, `set_mock_settings`, `set_project_settings`, `add_flow`, `remove_flow`, `try_request`, `get_routes`, `sync_from_spec`, `resolve_orphan`, `create_project`.
Otherwise the local REST API (writes need header `x-dashboard: 1`), under `/api/projects/<p>/mocks/<m>`:
`PUT case` `{ api, flow, case: { name, when, response } }`, `PUT response` `{ api, flow, response }`, `PUT flow-entry` `{ api, flow, entry }`, `PUT enabled` `{ api, flow, enabled }`, `PUT mode` `{ api | "*", mode }`, `PUT settings` `{ realBaseUrl, realScope, defaultMode, activeFlow }`, `POST|DELETE flows` `{ flow }`, `POST try` `{ method, path, headers, body, flow }`.
Steps: `get_api` (look at the examples) -> turn the request into cases ("id 99999999 -> 404" = `when.params`, "when searchWord=none" = `when.query`, "expired token" = `when.headers`, "email x" = `when.body`) -> keep bodies valid for the OpenAPI schema -> `try_request` to confirm -> give the user curl commands for the hub URL.

## When the OpenAPI file changed
`list_mocks` / the dashboard show `spec.changed`. Then:
1. `sync_from_spec` with `dryRun: true`; show the report (added, removed, renamed APIs; scenario examples that would be dropped).
2. Ask, then the real `sync_from_spec`: updates the Postman collection **in place** (same UID, ids kept, `… :: …` scenario examples carried over - also across path-param renames), re-normalizes, updates the Postman spec (best effort), `specHash` and the local cache. The mock serves the new APIs right away.
3. Orphans (mock data whose API disappeared): suggest `suggestion`; `resolve_orphan` moves it (path params in conditions renamed) or deletes it - ask the user.
4. `schemaWarnings`: top-level fields missing/extra vs the new example; offer to fix the bodies.
CLI: `node <scripts>/spec-sync.mjs <projectRoot> [--spec file] [--dry-run] [--force]`.

## Notes
- Engine unit tests: `node --test test/` in the plugin folder.
- `verify-mock.mjs <collection.json> http://localhost:4800/gw/<p>/<m>` checks every API returns its default example.
- The hub only listens on 127.0.0.1 in local mode; shared mode requires a token for the dashboard API and MCP (the `/gw/` mock URLs stay open).
