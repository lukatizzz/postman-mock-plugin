---
name: mock-set
description: Set what a mocked API returns for a specific case - e.g. "GET /pets/999 returns 404", "login with password wrong returns 401", "make /orders slow", "when status=sold return an empty list". Creates or updates a Postman example (scenario) on the mock created by mock-import and prints how to call it. Use whenever the user wants to change or add a mock response.
---

# Set a mock response for a specific case

Reply in the user's language. Helper scripts: `<this skill dir>/../../scripts/`.
Read `.postman-mock/state.json` first (format: `../mock-setup/references/state.md`). If there is no mock yet, run **mock-import** first.
How Postman picks an example: `references/postman-matching.md` - read it before choosing a strategy.

## 1. Understand the request
Extract: endpoint (method + path template), the distinguishing condition (path value, query, request body, header, or "always"), status code, response body / fields to change, optional delay.
If the endpoint is ambiguous, show the matching endpoints from state and ask.

## 2. Choose a strategy (first that fits)

| | When | How |
|---|---|---|
| **A. Specific path/query** | Case is identified by a URL value (`/pets/999`, `?status=sold`) | New example whose `originalRequest.url` has the literal value. It beats the `{{petId}}` wildcard example; clients change nothing. |
| **B. Named scenario** | Case is not visible in the URL, or tests want to pick it explicitly | New example; clients send `x-mock-response-name: <example name>`. |
| **C. Request body / header** | POST/PUT distinguished by payload (wrong password, duplicate email) | New example whose `originalRequest.body` is the exact payload. A matching body already wins on score; for strict matching enable `node <scripts>/postman-rest.mjs mock-config <mockId> --match-body true` or tell clients to send `x-mock-match-request-body: true`. |
| **D. Change the default** | User wants every call to return new data | `updateCollectionResponse` on the existing default example. **Ask for confirmation first.** |
| **E. Global 5xx outage** | "the whole server is down" | `createMockServerResponse` (`serverResponse: { name, statusCode 500-599, headers, language: "json", body }`) then `updateMock` with `mock: { collection: <uid>, private: true, config: { serverResponseId } }`. Every request then returns it until **mock-reset**. **Ask for confirmation first.** |

**`updateMock` resets the mock to PUBLIC unless you send `private: true` again** (verified). Always include `private` (from state) in every `updateMock` call, and afterwards confirm a call without `x-api-key` gets 401.

Delay only: tell clients to send `x-mock-response-delay: <ms>`, or set a mock-wide delay with `mock-config <mockId> --delay <ms>`.

## 3. Build the example
- **Name**: `<METHOD> <path template> :: <short-kebab-scenario>` (e.g. `GET /pets/{petId} :: pet-sold`). Must be unique. If a scenario with this name exists in state, update it instead of creating a duplicate.
- **Body**: start from the endpoint's default example for that status code and apply the user's changes. Validate against the OpenAPI response schema for that code (required fields, types, enums). If it violates the schema, say so and ask whether to keep it (deliberately broken responses are allowed when the user confirms).
- Dynamic values are allowed: `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$body 'field'}}`, `{{$queryParams 'k'}}`, `{{$pathSegments 'i'}}` (index counts the base path too: `/v1/pets/1` -> `'2'` is `1`).
- **Name must be ASCII** (Postman does not match non-ASCII `x-mock-response-name` values). Generated examples often have Japanese names; reach those with `x-mock-response-code` instead.
- **Request URL per strategy** (always prefix `{{baseUrl}}`, path variables as `{{var}}`):
  - A (path): literal values, e.g. `{{baseUrl}}/constructions/99999999`. Note: Postman fuzzily matches ID-like segments, so `x-mock-response-code: 404` on another numeric id may also return this scenario.
  - A (query): e.g. `{{baseUrl}}/tasks?searchWord=none`. **Warning to tell the user:** on Postman this scenario also answers every other value of that key (`searchWord=abc`), because a key with a different value outranks a missing key. If that is unwanted, use B.
  - B (by name only): add a marker query so it never wins by default: `{{baseUrl}}/constructions/{{constructionNo}}?__scenario=<scenario>`. Clients send `x-mock-response-name: <name>`.
  - C: the endpoint URL plus `"body": { ...exact payload... }`.
  - Want an error that is already generated (401/403/500...)? No new example needed: clients send `x-mock-response-code: 401`.
- Write the example either with the MCP tool `createCollectionResponse` / `updateCollectionResponse` using its legacy fields (verified working):
  `{ collectionId, request, name, responseCode: { code, name }, status, headers: [{key,value}], language: "json", rawDataType: "text", text: "<body string>", requestObject: "<JSON string: {method,url,headers,pathVariables,queryParams[,dataMode:'raw',rawModeData]}>" }`
  (ignore the tool description's link to the v2.1 format - `code`/`body`/`originalRequest` are not accepted), or with the script, which builds those fields for you:
  ```json
  { "name": "...", "code": 404, "body": { ... }, "request": { "method": "GET", "url": "{{baseUrl}}/pets/999", "pathVariables": {}, "body": null } }
  ```
  `node <scripts>/postman-rest.mjs upsert-example <file> --collection <collectionUid> --request <requestId>` (new) or `--response <exampleId>` (update).
- Verify with one call to the mock before reporting success.

## 4. Record and refresh
- Append/update the scenario in `state.endpoints[...].scenarios` (name, exampleId, strategy, match, code, note, createdAt).
- Refresh the local copy: `node <scripts>/postman-rest.mjs export-collection <collectionId> --out .postman-mock/collection.json` (the local mock reloads automatically).

## 5. Show how to call it
Always print ready-to-run commands for both the Postman mock (private mocks need `-H "x-api-key: $POSTMAN_API_KEY"`) and the local mock (`http://localhost:<port>`), e.g.

```
curl <mockUrl>/pets/999 -H "x-api-key: $POSTMAN_API_KEY"
curl http://localhost:4010/pets/1 -H "x-mock-response-name: GET /pets/{petId} :: pet-sold"
```
