---
name: mock-reset
description: Remove custom mock scenarios created with mock-set (one, all for an endpoint, or all), turn off a global 5xx server response, or reset mock delay/body matching, so the Postman mock returns its default examples again. Use when the user wants to undo or clear mock overrides.
---

# Reset mock scenarios

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/`. Read `.postman-mock/state.json` first.

1. Work out the scope: one scenario, all scenarios of an endpoint, all scenarios, the global server response, or mock config (delay / matchBody).
2. List exactly what will be removed and **ask for confirmation** - deleting examples cannot be undone.
3. Apply:
   - Scenario examples: `deleteCollectionResponse` or `node <scripts>/postman-rest.mjs delete-example <exampleId> --collection <collectionUid>` for each; remove them from state.
   - Default examples changed with strategy D cannot be restored automatically unless the old body was saved in the scenario's `note`; offer to regenerate it from the OpenAPI example.
   - Global server response: `updateMock` with `mock: { collection: <uid>, private: <from state>, config: { serverResponseId: null } }` (omitting `private` makes the mock public), then optionally `deleteMockServerResponse`; set `mock.serverResponseId` to null in state.
   - Config: `node <scripts>/postman-rest.mjs mock-config <mockId> --delay off --match-body false --match-header false`.
4. Refresh the local copy: `postman-rest.mjs export-collection <collectionId> --out .postman-mock/collection.json`.
5. Confirm what was reset.
