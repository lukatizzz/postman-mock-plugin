# Kết quả PoC – Postman Free (2026-10-30)

## Tài nguyên đã tạo trên Postman (My Workspace)
| Loại | ID |
|---|---|
| Spec "Petstore PoC" | `d0ca7985-2f01-4c5b-afb9-39557e2b575b` |
| Collection "Petstore PoC" (UID) | `27616091-7ff81e0f-867c-4b21-8eb8-61f285adb8d3` |
| Mock "Petstore PoC mock" (private) | `https://30121a51-34c8-467a-9591-c0cd4275c033.mock.pstmn.io/v1` |

## Chi phí
- Toàn bộ PoC (kể cả các lần thử sai): **~21 Postman API call** / 10.000 mỗi tháng.
- Import 1 spec (create spec + generate + poll + export + create mock) ≈ **5 call**; mỗi scenario = 1 call (+1 export để đồng bộ local).
- `mock_usage` của tài khoản: limit **99.999.999** → gói Free của tài khoản này **không bị giới hạn 1.000 mock call** như các nguồn bên thứ 3 nói.

## Kết quả kiểm thử (13 case, Postman thật vs mock local)
| Case | Postman | Local |
|---|---|---|
| Không có `x-api-key` (mock private) | 401 ✅ | 200 (local không cần key – chủ ý) |
| Mặc định `GET /pets/1` | 200 Milo ✅ | ✅ |
| **A** – path cụ thể `/pets/999` → 404 | ✅ | ✅ |
| **B** – header `x-mock-response-name` → pet-sold | ✅ | ✅ |
| `x-mock-response-code: 404` | 404 (chọn scenario 999) | 404 (chọn example chung) ⚠️ khác nhẹ |
| `GET /pets` / `?status=sold` → `[]` | ✅ | ✅ |
| POST /pets 201 | ✅ | ✅ |
| **C** – login password `wrong` → 401, các password khác → 200 | ✅ | ✅ |
| C + `x-mock-match-request-body: true` với body lạ → 404 | ✅ | ✅ |
| **D** – sửa example mặc định (PUT) | ✅ | ✅ |
| `x-mock-response-delay: 1500` | ✅ ~2s | ✅ 1.5s |
| Dynamic: `{{$body 'email'}}`, `{{$isoTimestamp}}`, `{{$pathSegments}}` | ✅ | ✅ |

## Phát hiện quan trọng (đã đưa vào skill)
1. **API tạo/sửa example dùng định dạng v1** (`responseCode`, `text`, `requestObject`). Gửi định dạng v2.1 → API vẫn trả 200 nhưng **âm thầm bỏ body/code** → example rỗng. ⇒ thêm lệnh `postman-rest.mjs upsert-example` nhận định dạng đơn giản và tự chuyển.
2. **Base path**: `{{baseUrl}}` = `https://api.example.com/v1` → mock phục vụ ở `<mockUrl>/v1/...`.
3. **Giá trị path variable được tính như literal**: `:petId = "1"` sẽ thắng cho `/pets/1`; giá trị rỗng biến path thành `/pets/` và cướp `/pets`. ⇒ scenario B dùng `__any__`, example mặc định dùng `{{petId}}`.
4. **Example do Postman sinh có query/path ngẫu nhiên** (`?limit=67&status=available`, `petId=6752`) → làm lệch matching khi thêm scenario. ⇒ `mock-import` bắt buộc bước chuẩn hoá.
5. Mock config có thêm `matchQueryParams`, `matchWildcards` (mặc định true).

## Spec thật: JumpApp-api.yml (85 path, 96 request, 432 example)

| | ID / URL |
|---|---|
| Spec | `42bd5e84-3a35-42f7-a49a-3e7f53adaa7a` |
| Collection (UID) | `27616091-309a979f-d046-479d-a4b7-2d14acfe9ba1` |
| Mock (private) | `https://af34eb81-f50b-4ca6-8b96-d78ab8cc543a.mock.pstmn.io/api/v1` |

| Bước | Kết quả |
|---|---|
| Import (create-spec + generate, 3 lần poll) | OK, ~10 giây |
| Gọi 96 API **trước** chuẩn hoá | Postman **48/96** đúng |
| `normalize-collection` (1 PUT, giữ nguyên ID) | Postman **96/96**, local **96/96** |
| 3 scenario (A path 404, A query list rỗng, B long-address) | đúng trên cả hai |
| Chi phí | ~17 Postman API call cho cả spec |

Phát hiện thêm từ spec thật:
1. `:var` lưu giá trị `"string"` **không phải wildcard** → 404 cho mọi id thật.
2. Postman chỉ ưu tiên **200** khi hoà điểm → API trả 201/204 bị example 401/500 cướp. ⇒ example phụ được giấu sau `?__example=<code>`, gọi bằng `x-mock-response-code`.
3. Scenario theo query (`searchWord=該当なし`) cũng trả về cho `searchWord=abc`.
4. Khớp mờ ID (−21 điểm): `x-mock-response-code: 404` ở `/constructions/1` trả về scenario của `99999999`.
5. **Tên example tiếng Nhật không dùng được với `x-mock-response-name`** trên Postman → tên scenario phải ASCII; lỗi chung (`認証例外`…) gọi bằng `x-mock-response-code`.
6. Mock local đã được chỉnh để mô phỏng 2–4; khác Postman duy nhất ở điểm 5 (local chấp nhận tên UTF-8).

## Postman MCP server (gọi trực tiếp bằng `scripts/mcp-call.mjs`)

- `https://mcp.postman.com/mcp` + Bearer API key: kết nối OK, **233 tool**, có đủ `createSpec`, `generateCollection`, `getAsyncSpecTaskStatus`, `createCollectionResponse`, `updateCollectionResponse`, `createMock`, `updateMock`, `*MockServerResponse`.
- `createCollectionResponse` (MCP) có schema **định dạng v1** (`responseCode`, `text`, `requestObject`, `additionalProperties: false`) → tạo scenario 410 qua MCP: mock trả đúng. Mô tả tool lại trỏ tới tài liệu v2.1 → skill ghi rõ dùng field v1.
- **Cách E qua MCP**: `createMockServerResponse` 503 + `updateMock(config.serverResponseId)` → mọi API trả 503 kèm `Retry-After`; set `null` → trở lại bình thường. ✅
- ⚠️ **`updateMock` không gửi `private: true` → mock bị chuyển sang PUBLIC** (đã khôi phục). Skill & script `mock-config` đã sửa để luôn gửi lại `private`.

## Mock local của app Postman (JavaScript, `postman/mocks/`) – Postman CLI 1.82.0

- Cài `npm install -g postman-cli` (package do Postman phát hành). `postman mock generate` / `postman mock run` **không cần đăng nhập**.
- `postman mock generate <spec|collection> --output postman/mocks/<name>` sinh `config.yaml` (port, danh sách scenario, `default: true`) + `default.js` (`http.createServer`, `// @endpoint`, `x-mock-response-code`). `--stateful` sinh CRUD dùng `pm.state`.
- Petstore: static ✅, stateful (POST → GET thấy → DELETE → 404) ✅, scenario qua header `x-mock-scenario` ✅, delay trong scenario ✅.
- JumpApp:
  - Sinh **từ spec**: 95 endpoint, đúng route/status nhưng **363 chỗ body là `<Error: Too many levels of nesting...>`** (schema lồng sâu).
  - Sinh **từ collection** (đã chuẩn hoá trên Postman): 96 endpoint, 0 lỗi body, nhưng **mất base path `/api/v1`** → `app-mock.mjs set-base-path` → **96/96** endpoint trả đúng example (cả có và không có `/api/v1`).
  - Scenario `qa-edge-cases` (404 cho `/constructions/99999999`, list rỗng cho `searchWord=none`) ✅; không có header → default.
- Stateful lưu id theo tên path variable (`petId`) → `app-mock.mjs rename-id-field petId id`.
- `x-mock-scenario` không tồn tại → âm thầm trả default.
- ⚠️ Khi dừng mock: chỉ dừng tiến trình `postman ... mock run` của mình; **không** kill mọi `postman.exe` (sẽ tắt app desktop).
- Chưa kiểm chứng: bấm Start mock trong **app desktop** (Local View + Native Git) – cần bạn mở app thử.

## Code mock chỉ lưu trên cloud (Mocks của Postman) – cách plugin dùng hiện nay

- `app-mock.mjs cloud-push <definition.json>`: `postman mock generate` vào thư mục tạm → thêm scenario / base path → `postman mock push -w <ws>` → xoá thư mục tạm. Dự án chỉ giữ file định nghĩa (git-ignore).
- Gói Free: tạo, cập nhật, chạy code mock trên cloud đều OK (`deploy` mới cần gói trả phí).
- Petstore: tạo mới (`created: true`), cập nhật cùng mock (`created: false`), scenario `pet-sold` qua `x-mock-scenario`, base path `/v1` ✅ – chạy bằng `postman mock run <mockId>` sau khi đã xoá mọi bản local.
- JumpApp: code mock `c35968af…` từ collection + `basePath /api/v1` + scenario `qa-edge-cases` → **96/96** endpoint đúng, scenario ✅, `x-mock-response-code` ✅.
- Phát hiện:
  - `postman mock generate --collection <uid> -w <ws>` tạo mock liên kết collection nhưng **không push đè được** (`A scenario with this name already exists`) → plugin luôn tạo mock bằng push.
  - `postman mock push` ghi ánh xạ path → mockId vào `<cwd>/.postman/resources.yaml`; chạy trong repo sẽ làm bẩn file liên kết Git của app → plugin chạy push trong thư mục tạm và tự ghi ánh xạ ở đó.
  - Push **không xoá** scenario đã bỏ → `retiredScenarios` đưa scenario về hành vi default; xoá hẳn trong app.
  - Nguồn spec giữ server path trong route (`/v1/pets`), nguồn collection thì mất → `basePath` chỉ áp cho nguồn collection.

## Dashboard + gateway Mock/Real (`scripts/dashboard.mjs`)

- **Sandbox mock của Postman chặn mạng ra ngoài**: trong code mock, `http.request`, `https.request`, `fetch` đều lỗi `[mock-sandbox] outbound network is blocked` → chế độ "API thật" phải đặt ở gateway trên máy, không thể nằm trong JS trên cloud.
- Kiểm thử với JumpApp (96 API) + API thật giả lập:
  - Mock: gateway tự chạy `postman mock run <mockId>` ở lần gọi đầu (~5 s), sau đó vài ms.
  - Real: chuyển đúng path, query, `Authorization`; bỏ `x-mock-*`; các API khác vẫn Mock.
  - Scenario chọn trên dashboard → client không cần header vẫn nhận 404 của `qa-edge-cases`.
  - Sửa dữ liệu default → Push → mock tự khởi động lại → dữ liệu mới có hiệu lực; scenario kế thừa dữ liệu default đã sửa.
  - Trong lúc push dashboard vẫn phản hồi (17 lần poll, tối đa 12 ms) sau khi đổi `postman` CLI sang chạy bất đồng bộ.
  - Ctrl+C dừng đúng runner của dashboard; app Postman desktop vẫn chạy. POST thiếu header `x-dashboard` → 403.
- Dữ liệu thử đã được gỡ và push lại; mock JumpApp trên cloud trở về như trước.

## Mock Hub v0.3: flow, case có điều kiện, Real gọi thẳng, MCP dùng chung

- Mô hình dữ liệu v2 (`mock-store.mjs`): API × flow → `cases` (điều kiện params / query / headers / body) → `response` → default → example; `enabled` theo flow; định nghĩa v1 tự chuyển đổi.
- Sinh code (`app-mock.mjs`): mỗi flow một file JS, chuỗi ưu tiên compile thành `if` theo thứ tự; Petstore **14/14** (params, header, query, body + delay, flow response, flow tắt → default, `x-mock-response-code`).
- Hub local (JumpApp 96 API) **18/18**: chuyển v1 → v2, API Real → 307 + `__routes` + `__client.js`, case params/header, flow tắt → chuỗi default, validation, push và kiểm tra trên gateway.
- Hub dùng chung + MCP (streamable HTTP, JSON) **20/20**: 401 khi thiếu token, token giới hạn project → 403, đủ các tool, `push_mock` chờ xong, dữ liệu tạo qua MCP có hiệu lực trên gateway.
- Phát hiện: redirect 307 sang server khác origin làm mất header `Authorization` → client nên gọi thẳng theo bảng route.
- Dữ liệu thử đã gỡ; mock JumpApp về như trước (flow `empty-state` thử nghiệm trên cloud đã về dữ liệu default, có thể xoá trong app).
- Chưa thử: kết nối hub MCP từ Claude Code / Codex thật (đã kiểm bằng client JSON-RPC theo chuẩn MCP); chạy hub trên máy chủ khác qua HTTPS.

## Đồng bộ khi file OpenAPI thay đổi (`spec-sync.mjs`)

Thử trên collection Petstore với spec v1.1 (đổi `{petId}` → `{id}`, thêm `GET /pets/{id}/photos`, bỏ `/auth/login`, thêm field `age`) – **24/24**:
- Xem trước (dry run) báo đúng API mới / bị xoá / đổi tên / scenario bị bỏ và **không** đổi collection.
- Đồng bộ: cùng collection UID; ID request giữ nguyên (cả API đổi tên param); scenario `missing-999`, `pet-sold`, `gone-777` theo sang `GET /pets/:id`; `/auth/login` bị bỏ; `specHash` cập nhật.
- Hub: dữ liệu mồ côi `GET /pets/:petId` gợi ý `GET /pets/:id`; chuyển → điều kiện `petId=999` thành `id=999`; cảnh báo schema `GET /pets` thiếu `age`.
- Push: case chuyển sang chạy đúng (404), example mới có `age`, API mới chạy, API bị xoá → 404; mock cổ điển Postman vẫn trả scenario đã giữ.
- Collection tạm dùng để import đã được xoá (workspace chỉ còn 2 collection).
- Ghi chú: collection "Petstore PoC" giờ ở spec v1.1 (dữ liệu thử nghiệm).

## Chưa kiểm chứng trong PoC
- Gọi qua **Postman MCP server** (session này chưa nạp MCP; PoC dùng REST endpoint tương đương). Cần cài plugin vào Claude Code và chạy lại luồng bằng skill.
- Tool MCP `createCollectionResponse` có nhận định dạng v1 không (nếu không → skill luôn dùng script).
- Cách E (server response 5xx) và `syncCollectionWithSpec`.
- Codex.
