---
name: mock-local
description: Run the mock locally on the user's machine from the exported Postman collection - unlimited calls, no Postman mock quota used, same scenario rules (x-mock-response-name, literal paths, body match). Use when the user wants a local mock URL, works offline, or is worried about the free plan's mock call limit.
---

# Local mock server

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/`.

1. Make sure `.postman-mock/collection.json` exists and is current: `node <scripts>/postman-rest.mjs export-collection <collectionId from state> --out .postman-mock/collection.json`.
2. Start it as a long-running/background process:
   `node <scripts>/local-mock.mjs --collection .postman-mock/collection.json --port <port, default 4010>`
   Options: `--match-body` (require exact request body match), `--delay <ms>`.
3. It reloads the collection file automatically whenever it changes, so after **mock-set** only the export is needed.
4. Tell the user the base URL `http://localhost:<port>` and that client headers work the same as on Postman (`x-mock-response-name`, `x-mock-response-code`, `x-mock-response-delay`, `x-mock-match-request-body`). No `x-api-key` needed locally. CORS is open for browser apps.
5. Save the port in `state.local.port`.
