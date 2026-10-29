---
name: mock-setup
description: Check and prepare the Postman mock workflow in the current project - verifies the Postman API key, the Postman MCP connection, Node.js, monthly usage on the free plan, picks a workspace and creates .postman-mock/state.json. Use before the first mock import or when Postman mock calls fail.
---

# Postman mock setup

Reply in the user's language. Never print, echo or write the API key anywhere.

Helper scripts live in the plugin's `scripts/` folder, two levels above this file
(`<this skill dir>/../../scripts/`). Call them as `node <that path>/postman-rest.mjs ...`.

## Steps

1. **Node.js**: run `node --version`. Need 18+. If missing, tell the user to install the Node LTS from https://nodejs.org and stop.
2. **API key**: check that the environment variable `POSTMAN_API_KEY` is set (test for presence only, e.g. `[ -n "$POSTMAN_API_KEY" ] && echo set`). If not set, explain:
   - Create a free key at https://postman.co/settings/me/api-keys
   - Set it as a user environment variable named `POSTMAN_API_KEY`, then restart the agent app so both the MCP server and scripts see it.
   Do not ask the user to paste the key into the chat.
3. **Postman MCP**: confirm the `postman` MCP server tools are available (e.g. `getWorkspaces`, `createMock`, `updateCollectionResponse`, `getAsyncSpecTaskStatus`). If the last two are missing, the server runs the *minimal* toolset; the plugin needs the *full* toolset (233 tools) at `https://mcp.postman.com/mcp`.
   If the MCP tools are not loaded in this session (e.g. the key was set after the app started), the same server is reachable through `node <scripts>/mcp-call.mjs list|schema|call ...`; restarting the app loads the tools natively.
4. **Usage** (free plan budget): run `node <scripts>/postman-rest.mjs me` and show the `usage` rows (API calls and mock calls used / limit this month).
5. **Workspace**: call `getWorkspaces`; let the user pick one (default: their personal workspace). Do not create a workspace unless asked.
6. **State file**: create `.postman-mock/state.json` if missing (schema in `references/state.md`) with `workspaceId` filled in. Add `.postman-mock/` to the project's `.gitignore` (free plan = 1 user, so state is personal).
7. Report a short checklist of what is ready and what is not.
