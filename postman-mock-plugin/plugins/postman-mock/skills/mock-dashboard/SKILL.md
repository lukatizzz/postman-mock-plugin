---
name: mock-dashboard
description: Run the Mock Hub for Postman code mocks - dashboard to edit what every API returns per flow (scenario) with conditional cases and a default fallback, per-API enable/disable per flow, per-API Mock/Real switch (real APIs are called directly by the client via a routing table), push the regenerated JS to the cloud mock, and an MCP endpoint so teammates can create mock data from Claude/Codex. Use when the user wants the dashboard, the shared hub / MCP, conditional mock data, or to mix mocked and real APIs.
---

# Mock Hub (dashboard + MCP + gateway)

Reply in the user's language. Script: `<this skill dir>/../../scripts/dashboard.mjs` (UI `dashboard.html`, data model `mock-store.mjs`, code generation `app-mock.mjs`).

## Concepts
- **Flow** = scenario. `default` is what clients get without choosing; others are selected with header `x-mock-scenario: <flow>` or the hub's "active flow".
- Per API and flow: **cases** (conditions -> response, first match wins), an optional **flow response** (no condition), and **enabled**.
  Resolution: flow cases -> flow response -> default cases -> default response -> collection example. A **disabled** API in a flow answers with the default flow's data (disabled in `default` -> the collection example).
- **Conditions** (`when`, all parts must match, `"*"` = present with any value): `params` (path params by name), `query`, `headers` (case-insensitive), `body` (dotted JSON paths).
- **Mode** per API: `mock` (served by the gateway from the cloud mock) or `real`. Real APIs are called **directly** by the client at `realBaseUrl` using the routing table `GET /gw/<project>/<mock>/__routes` or the ES module `/__client.js` (`urlFor(method, path)`). A real-mode request that still hits the gateway gets `307` to the real URL (browsers drop `Authorization` on that cross-origin redirect - use the routing table).
- **realBaseUrl is saved per project** in `<project>/.postman-mock/state.json` (key `realBaseUrl`) and reused by every mock of the project, including new ones; a mock may override it (`realScope: "mock"`). Set it once with `set_project_settings` or `set_mock_settings` (default scope project) - do not ask the user again if `list_projects` already shows one.
- The Postman mock sandbox **blocks outbound network**, so "real" can never be done inside mock code.
- Data changes need **Push** (regenerates the JS files in the cloud mock). Modes, realBaseUrl, active flow apply immediately.

## Run it
- **Local** (one project = current folder, 127.0.0.1, no login): `node <scripts>/dashboard.mjs --port 4800 [--project <name>]` from the project root. Start it in a terminal the user can see and stop. Open `http://localhost:4800/`.
- **Shared team hub** (several projects, tokens, network): copy `<plugin>/examples/hub.example.json` to the hub machine as `hub.json`, set projects / publicUrl / defaultWorkspace, then
  - `node <scripts>/dashboard.mjs --hub hub.json --new-token <person> [--projects a,b]` - prints a token once, stores only its SHA-256;
  - `node <scripts>/dashboard.mjs --hub hub.json` (the machine needs Node 18+, the Postman CLI logged in, `POSTMAN_API_KEY`).
  Put it behind HTTPS (reverse proxy) or a VPN when it leaves the office network; tokens travel in the Authorization header.
- Connect a teammate's agent to the hub MCP (they run it, with their own token):
  - Claude Code: `claude mcp add --transport http mock-hub https://<hub>/mcp --header "Authorization: Bearer <token>"`
  - Codex `~/.codex/config.toml`: `[mcp_servers.mock-hub]` `url = "https://<hub>/mcp"` `bearer_token_env_var = "MOCK_HUB_TOKEN"`
  Never paste tokens into the chat.

## Creating mock data for the user
Prefer the hub MCP tools when connected (`list_projects`, `list_mocks`, `list_apis`, `get_api`, `set_api_response`, `upsert_case`, `remove_case`, `set_api_enabled`, `set_api_mode`, `set_mock_settings`, `add_flow`, `remove_flow`, `push_mock`, `get_routes`, `create_mock`, `create_project`). Otherwise call the local REST API (writes need header `x-dashboard: 1`):
- `PUT /api/projects/<p>/mocks/<m>/flow-entry` `{ "api": "GET /tasks", "flow": "default", "entry": { "enabled": true, "response": {...}, "cases": [ { "name", "when", "response" } ] } }`
- `PUT .../enabled` `{ api, flow, enabled }`, `PUT .../mode` `{ api | "*", mode }`, `PUT .../settings` `{ realBaseUrl, defaultMode, activeFlow }`, `POST|DELETE .../flows` `{ flow }`, `POST .../push` then poll `GET .../<m>` until `push.running` is false.
Steps: read the API (`get_api`) and its examples -> turn the request into cases ("id 99999999 -> 404" = `when.params`, "when searchWord=none" = `when.query`, "expired token" = `when.headers`, "email x" = `when.body`) -> keep bodies valid for the OpenAPI schema -> push -> verify through the gateway with curl (send `x-mock-scenario` for non-default flows) -> report the URLs.

## When the OpenAPI file changed
`list_mocks` / the dashboard show `spec.changed` (hash of `state.json` `sourceSpec` vs `specHash`). Then:
1. `sync_from_spec` with `dryRun: true` and show the report (added, removed, renamed APIs; scenario examples that will be dropped).
2. Ask before the real `sync_from_spec`: it updates the Postman collection **in place** (same UID, matching request/example ids kept, `… :: …` scenario examples carried over - also across path-param renames), re-normalizes examples, updates the Postman spec file (best effort) and `specHash`. A temporary collection is imported and deleted again.
3. For each orphan (mock data whose API key disappeared) suggest the `suggestion` target; `resolve_orphan` moves it (path params in conditions renamed by position) or deletes it - ask the user.
4. Mention `schemaWarnings` (top-level fields missing/extra vs the new example of the same status) and offer to fix the bodies.
5. `push_mock`, then verify the changed APIs through the gateway.
CLI: `node <scripts>/spec-sync.mjs <projectRoot> [--spec file] [--dry-run] [--force]`.

## Notes (verified 2026-10-30, 96-endpoint spec)
- Local hub 18/18 checks (v1->v2 migration, 307 + routes + client module, conditions on params/headers/query, disabled flow -> default chain, validation, push) and shared hub MCP 20/20 (401/403 tokens, all tools, push_mock waits, data live on the gateway).
- Stop with Ctrl+C: the hub stops only the mock runners it started. Never kill all `postman`/`Postman.exe` processes (closes the Postman desktop app).
- Body conditions with `stateful: true` mocks share the request body through a cache; static mocks are the tested path.
