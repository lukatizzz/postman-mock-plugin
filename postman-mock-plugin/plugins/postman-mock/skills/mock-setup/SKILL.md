---
name: mock-setup
description: Check and prepare the mock workflow in the current project - Postman API key, Postman MCP connection, Node.js, monthly Postman API usage, workspace, and .postman-mock/state.json. Use before the first import or when Postman calls fail.
---

# Setup

Reply in the user's language. Never print, echo or write the API key anywhere.
Helper scripts: `<this skill dir>/../../scripts/` (call as `node <scripts>/postman-rest.mjs ...`).

Postman is only used for the **spec and the collection** (create, keep in sync). Mocks are served by the Mock Hub
(**mock-dashboard**) on the developer's machine or a shared server - no Postman mock servers, no Postman CLI.

## Steps
1. **Node.js** 18+: `node --version`. If missing: install the LTS from https://nodejs.org and stop.
2. **API key**: check only that `POSTMAN_API_KEY` is set (e.g. `[ -n "$POSTMAN_API_KEY" ] && echo set`). If not:
   - create a free key at https://postman.co/settings/me/api-keys;
   - set it as a user environment variable `POSTMAN_API_KEY` (Windows: Environment Variables dialog; macOS: Keychain + `~/.zshrc` + `launchctl setenv` - see the repo README), then restart the agent app.
   Do not ask the user to paste the key into the chat.
3. **Postman MCP** (optional but useful): tools like `getWorkspaces`, `createSpec`, `generateCollection`, `getAsyncSpecTaskStatus` should be available (full toolset at `https://mcp.postman.com/mcp`). The scripts do the same work through the REST API if MCP is not loaded.
4. **Usage**: `node <scripts>/postman-rest.mjs me` - show the `api_usage` row (Postman API calls this month).
5. **Workspace**: `getWorkspaces` (or `postman-rest.mjs request GET /workspaces`); let the user pick one (default: their personal workspace).
6. **State file**: create `.postman-mock/state.json` if missing with `workspaceId`; add `.postman-mock/` to the project's `.gitignore` (per-user data and caches).
7. Report a short checklist of what is ready and what is not, then suggest **mock-import**.
