---
name: mock-list
description: Show the current Postman mock - mock URL, every mocked API with its examples and the custom scenarios set with mock-set, plus free-plan usage. Use when the user asks what is mocked, which scenarios exist, or what the mock URL is.
---

# List mocks and scenarios

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/`.

1. Read `.postman-mock/state.json`. If missing, say no mock exists and suggest **mock-import**.
2. Prefer the local copy `.postman-mock/collection.json` for the example list (no API call). Only call `getCollection` if the user asks for a fresh view, then re-export with `postman-rest.mjs export-collection`.
3. Print:
   - Mock URL (private/public) and the local mock command.
   - Table: endpoint | default examples (codes) | scenarios (name -> code, how to trigger: literal path / header / body).
   - Active global server response (`mock.serverResponseId`), if any - warn that it overrides everything.
4. If the user asks about quota: `node <scripts>/postman-rest.mjs me`.
