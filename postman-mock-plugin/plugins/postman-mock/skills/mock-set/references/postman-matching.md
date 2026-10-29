# How a Postman mock chooses an example

Source: https://learning.postman.com/docs/design-apis/mock-apis/matching-algorithm/
`scripts/local-mock.mjs` approximates the same rules.

1. Load all saved examples of the collection; resolve collection/environment variables.
2. Drop examples whose HTTP method differs.
3. Override headers sent by the client:
   - `x-mock-response-code: 404` - keep only examples with that code.
   - `x-mock-response-id: <uid>` - return exactly that example (error if none).
   - `x-mock-response-name: <name>` - return the example with that name (error if none; duplicates -> first 200).
4. Path score starts at 100:
   - exact match 100; trailing slash -5; case mismatch -10; path variable / wildcard (`{{id}}`) -20; examples whose path doesn't fit are dropped.
   - So `/pets/999` (literal) beats `/pets/{{petId}}` (wildcard) for a call to `/pets/999`.
5. Query params change the score by the share of matching keys and values.
6. Headers and body are only *required* to match when enabled:
   - per request: `x-mock-match-request-body: true`, `x-mock-match-request-headers: key1,key2`
   - per mock: config `matchBody`, `matchHeader` (`postman-rest.mjs mock-config`).
   A matching body still raises the score when not required.
7. Highest score wins; ties -> 200 response first, then lowest id.

Other client headers: `x-mock-response-delay: <ms>` (1-180000). Private mocks need `x-api-key: <Postman API key>`.

Dynamic body values (rendered at call time): `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomFullName}}`,
templating helpers `{{$body 'a.b' 'default'}}`, `{{$queryParams 'k'}}`, `{{$headers 'k'}}`, `{{$pathSegments '0'}}`.

Only one mock "server response" (5xx) can be active; while active it answers **every** request.

## Verified on a real Postman mock (PoC, 2026-10-30)

- **Base path**: `{{baseUrl}}` is resolved before matching. With `baseUrl = https://api.example.com/v1` the mock answers `<mockUrl>/v1/pets`, and `<mockUrl>/pets` is a 404.
- **Example write format**: `POST/PUT /collections/{id}/responses` only store legacy v1 fields (`responseCode`, `headers`, `text`, `requestObject` as a JSON string). v2.1 fields (`code`, `body`, `originalRequest`) are accepted with 200 but silently dropped. Use `postman-rest.mjs upsert-example`.
- **Path variable values count**: `:petId` with saved value `1` behaves like the literal `/pets/1` for scoring. `{{petId}}` (undefined variable) is a pure wildcard. Empty value -> path becomes `/pets/` and can match `/pets`.
- **Generated examples** carry random query values (`?limit=67&status=available`) and random path values; normalize them after import (see mock-import step 3) or a `/pets` example can outrank `/pets/{{petId}}` for `/pets/1`.
- **`x-mock-response-code`** with several examples of that code: Postman picked the literal-path scenario over the generic one. Use `x-mock-response-name` when the exact example matters.
- Mock config also has `matchQueryParams` and `matchWildcards` (both true by default).

## Verified on a real 96-endpoint spec (JumpApp, 2026-10-30)

- Before normalization only 48/96 endpoints returned their own default example; after `normalize-collection` 96/96 (Postman and local).
- `:var` saved as `"string"` is not a wildcard: `/constructions/123` -> 404. Numeric-looking saved values (`6752`) only "work" through the ID-like fuzzy rule.
- Tie-break prefers **200** only. A 204/201 default loses ties to 401/500 examples -> hide alternates behind `?__example=<code>`.
- A query scenario (`?searchWord=x`) also answers `?searchWord=other` (partial key match beats missing key).
- ID-like fuzzy match (-21): `x-mock-response-code: 404` on `/constructions/1` returned the scenario saved for `/constructions/99999999`.
- Non-ASCII `x-mock-response-name` (e.g. `認証例外`) -> `mockRequestNotFoundError`. Keep scenario names ASCII.
- Many generated example names repeat across endpoints (`認証例外`, `システム例外`); use `x-mock-response-code` for those.
- A rare transient 500 from Postman under 4 parallel calls; retry.
- `x-mock-response-delay`, private-mock `x-api-key` (401 `invalidCredentialsError` without it), `{{$body 'email'}}`, `{{$isoTimestamp}}`, `{{$pathSegments}}` all confirmed.
