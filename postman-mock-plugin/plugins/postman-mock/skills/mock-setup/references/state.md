# `.postman-mock/` in a project

Per-user data and caches (git-ignored). Read `state.json` first instead of listing things again (saves Postman API calls).

```
.postman-mock/
├── state.json                     project settings + Postman ids
├── collections/<collectionUid>.json   local copy of the collection the Mock Hub serves (offline-capable)
└── code-mocks/<mock>.json         mock definitions (flows, cases, modes) - format: scripts/mock-store.mjs
```

`state.json`:
```json
{
  "workspaceId": "Postman workspace id",
  "sourceSpec": "path of the OpenAPI file (relative to the project when possible)",
  "specHash": "sha256 of that file at the last import/sync - the hub shows 'spec changed' when it differs",
  "specId": "Postman spec id (null when imported via import-openapi)",
  "collectionUid": "ownerId-collectionId of the collection",
  "lastSpecSyncAt": "ISO date of the last spec sync",
  "realBaseUrl": "real environment base URL, reused by every mock of the project"
}
```
Older files may contain more keys (`mock`, `endpoints`, ...) from earlier versions; keep them, they are ignored.
