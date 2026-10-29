# `.postman-mock/state.json`

Single source of IDs for every mock skill. Read it first; update it after every change.
Reading IDs from here instead of listing them again saves Postman API calls (free plan: 10,000/month).

```json
{
  "workspaceId": "string",
  "sourceSpec": "api/openapi.yaml",
  "specHash": "sha256 of the spec file at import time",
  "specId": "string or null (null when imported via import-openapi)",
  "collectionId": "string",
  "collectionUid": "ownerId-collectionId (needed by createMock)",
  "mock": { "id": "string", "url": "https://<id>.mock.pstmn.io", "private": true, "serverResponseId": null },
  "local": { "collectionFile": ".postman-mock/collection.json", "port": 4010 },
  "endpoints": {
    "GET /pets/{petId}": {
      "requestId": "string",
      "examples": { "200 OK": "responseId", "404 Not Found": "responseId" },
      "scenarios": [
        {
          "name": "GET /pets/{petId} :: pet-sold",
          "exampleId": "string",
          "strategy": "path | name | body | default-edit",
          "match": { "path": "/pets/999", "query": {}, "body": null },
          "code": 200,
          "note": "free text, e.g. ticket id",
          "createdAt": "ISO date"
        }
      ]
    }
  }
}
```

Endpoint keys use the OpenAPI path template (`{param}`), upper-case method, one space.
