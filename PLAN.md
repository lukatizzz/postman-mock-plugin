# Kế hoạch: Plugin "postman-mock" cho Claude Code & Codex

> Mục tiêu: từ một file OpenAPI YAML, tự động tạo **Spec → Collection → Example cho từng API → Mock server** trên Postman thông qua **Postman MCP Server**, và cho phép người dùng nói bằng ngôn ngữ tự nhiên để **set giá trị trả về cho một trường hợp cụ thể** (scenario) trong quá trình phát triển.
>
> Ngày nghiên cứu: 2026-10-30. Các điểm đánh dấu ⚠️ là chưa xác minh được, cần kiểm chứng ở giai đoạn PoC.

---

## 1. Kết quả nghiên cứu chính

### 1.1 Postman MCP Server (chính thức – `postmanlabs/postman-mcp-server`)

| Hạng mục | Chi tiết |
|---|---|
| Endpoint remote | `https://mcp.postman.com/{minimal\|code\|mcp}` (EU: `mcp.eu.postman.com/...`) |
| Local | `npx @postman/postman-mcp-server --full` + env `POSTMAN_API_KEY` |
| Auth | OAuth (chỉ global remote) hoặc header `Authorization: Bearer <POSTMAN_API_KEY>` |
| Toolset | minimal (~42 tool, mặc định), **full (~234 tool)**, code (~23) |

**Kết luận quan trọng: plugin phải dùng toolset `full` (`/mcp`)**, vì minimal **không có**:
- `updateCollectionResponse`, `deleteCollectionResponse`, `getCollectionResponse` → không sửa/xoá được example (lõi của tính năng “set giá trị”).
- `getAsyncSpecTaskStatus` → không poll được tác vụ generate collection.
- `createMockServerResponse` / `deleteMock` / `unpublishMock`.

Luồng tool chính:

```
createSpec (OpenAPI 3.x/2.0, cần workspaceId)
  → generateCollection (ASYNC, trả taskId)
  → getAsyncSpecTaskStatus (poll) → collectionId
  → getCollection (lấy danh sách request + example đã sinh)
  → createCollectionResponse (bổ sung example cho từng status code)
  → createMock (cần collection UID dạng ownerId-collectionId) → mockUrl
```

Hạn chế MCP cần bù bằng REST (`https://api.getpostman.com`, header `X-Api-Key`):
- `updateMock` qua MCP chỉ set được `config.serverResponseId`; **không set được `matchBody`, `matchHeader`, `delay`** → dùng `PUT /mocks/{id}`.
- Không có tool import OpenAPI đồng bộ → tuỳ chọn `POST /import/openapi?workspace=` (tạo collection ngay, không cần poll).

### 1.2 Cơ chế chọn response của Postman Mock (nền tảng cho "set giá trị")

1. Lọc theo **method**.
2. Header ghi đè (ưu tiên cao nhất): `x-mock-response-name`, `x-mock-response-id`, `x-mock-response-code`.
3. Chấm điểm **path** (khớp chính xác 100 điểm > wildcard `{{id}}` −20 …) → example có path cụ thể `/users/123` **thắng** example `/users/{{userId}}`.
4. Chấm điểm **query params**.
5. Header/body chỉ được so khớp khi bật `x-mock-match-request-body: true` / `x-mock-match-request-headers: k1,k2` hoặc config mock `matchBody/matchHeader`.
6. Hoà điểm → example 200 có ID nhỏ nhất.

Khác: `x-mock-response-delay` (ms), dynamic vars `{{$randomUUID}}`, `{{$timestamp}}`, template `{{$body 'a.b'}}`, `{{$pathSegments '1'}}`, `{{$queryParams 'k'}}`. Mock private cần header `x-api-key`. Giới hạn ~120 req/phút; quota call/tháng theo plan (⚠️ free ~1.000 – chưa xác minh trên trang pricing).

### 1.3 Định dạng plugin

| | Claude Code | Codex |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` (hoặc `plugin.json` gốc theo schema agent-plugins.org) |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` (tự phát hiện) |
| MCP | `.mcp.json` (`type: "http"`, `headers`) | `mcp.json` (`type: "streamable-http"`) – **khác tên & shape** |
| Secret | `userConfig` + `sensitive: true` → `${user_config.postman_api_key}` (lưu keychain) | biến môi trường / `bearer_token_env_var` / OAuth |
| Marketplace | `.claude-plugin/marketplace.json` → `/plugin marketplace add org/repo` | đọc được `.agents/plugins/marketplace.json` **và** `.claude-plugin/marketplace.json` → `codex plugin marketplace add org/repo`, cài qua `/plugins` |
| Gọi skill | `/postman-mock:<skill>` | `$<skill>` |
| Kiểm thử | `claude plugin validate`, `claude plugin eval` | — |

→ **Một repo, dùng chung `skills/`**, hai manifest + hai file MCP. SKILL.md chỉ dùng frontmatter `name` + `description` và đường dẫn tương đối để chạy được ở cả hai (không dùng `${CLAUDE_*}`, `context: fork`, `allowed-tools`...).

---

## 1.4 Phạm vi giai đoạn demo: chỉ dùng gói **Postman Free** (0 đồng)

Giới hạn gói Free (kiểm tra 2026-10-30):

| Hạng mục | Free | Nguồn |
|---|---|---|
| Postman API calls (mỗi tool MCP gọi = ≥1 call) | **10.000/tháng** | postman.com/pricing (chính thức) |
| Mock server | Có | chính thức |
| Mock server calls | ~~1.000/tháng~~ → PoC: `GET /me` trả `mock_usage` limit **99.999.999** (thực tế không giới hạn) | đo trực tiếp trên tài khoản Free (xem POC-RESULTS.md) |
| Số user | **1 user** (từ đầu 2026) | chính thức |
| Collection/workspace | 3 ⚠️ | nguồn thứ 3 |
| Postman MCP Server (remote, API key/OAuth) | Dùng được | chính thức (MCP client có ở Free) |
| Rate limit mock | 120 req/phút | Postman help center |

Hệ quả & điều chỉnh thiết kế:
1. **Không chia sẻ mock trong team** ở giai đoạn này (Free chỉ 1 user) → mỗi người tự `mock-import` vào tài khoản Free của mình; `state.json` để trong `.gitignore`, không commit.
2. **1.000 mock call/tháng là nút thắt** (frontend gọi API liên tục sẽ hết trong vài ngày) → thêm **chế độ `local`**:
   - Postman vẫn là nơi lưu trữ & xem collection/example (đúng ý tưởng ban đầu).
   - Plugin xuất collection (`getCollection`) ra `.postman-mock/collection.json`, rồi chạy `node scripts/local-mock.mjs` — một server Node nhỏ (không dependency) **mô phỏng thuật toán matching của Postman** (method → `x-mock-response-name/code` → path cụ thể > wildcard → query) → gọi không giới hạn, không tốn quota.
   - Biến `MOCK_MODE=postman|local`; client chỉ đổi `baseUrl`.
3. **Tiết kiệm Postman API call** (10.000/tháng là đủ cho demo): import 1 spec ~30 API ≈ 100–200 call. Skill phải: dùng `state.json` thay vì gọi `getCollections` lặp lại; tạo example theo lô; poll task với backoff (5s, 10s, 20s…).
4. Mock nên để **private** (`private: true`, gọi kèm `x-api-key`) để người lạ có URL không đốt quota của bạn; script local tự thêm header này nếu cần proxy.
5. Spec dùng 1 workspace cá nhân, 1 collection/spec (phù hợp giới hạn 3 collection/workspace nếu đúng).
6. Toàn bộ phần còn lại đều miễn phí: plugin là file tĩnh trên GitHub (repo public hoặc private đều cài được), `scripts/*.mjs` chạy bằng Node có sẵn. Chi phí duy nhất là gói Claude/Codex bạn đang dùng.

Khi demo thành công, các lựa chọn mở rộng (tính phí) để cân nhắc sau: Postman Team (chia sẻ mock, quota cao hơn), hoặc tự host mock local/Prism trên server nội bộ (vẫn miễn phí).

---

## 2. Kiến trúc plugin

```
postman-mock-plugin/
├── .claude-plugin/
│   ├── plugin.json          # name, version, userConfig(postman_api_key, region, workspace_id)
│   └── marketplace.json     # cho cả Claude & Codex
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json                # Claude: postman full toolset
├── mcp.json                 # Codex: postman full toolset
├── skills/
│   ├── mock-setup/          # kiểm tra kết nối, chọn workspace, tạo file state
│   ├── mock-import/         # OpenAPI YAML → spec → collection → examples → mock
│   ├── mock-examples/       # sinh/bổ sung example cho từng API & status code
│   ├── mock-set/            # ★ set giá trị trả về cho 1 case cụ thể
│   ├── mock-list/           # liệt kê API, example, scenario đang active, mock URL
│   ├── mock-reset/          # xoá scenario/override, trả về mặc định
│   ├── mock-sync/           # spec thay đổi → đồng bộ, áp lại override
│   └── _shared/references/  # postman-matching.md, naming-convention.md, state-schema.md
├── scripts/
│   ├── postman-rest.mjs     # Node, không dependency: import/openapi, PUT /mocks config, poll task
│   └── local-mock.mjs       # mock server local đọc collection.json, matching giống Postman (gói Free)
├── evals/                   # claude plugin eval
└── README.md
```

> Không dùng thư mục `bin/` (plugin có `bin/` không cài được trên Claude chat/Cowork). Script gọi bằng `node scripts/postman-rest.mjs ...`.

### 2.1 Cấu hình MCP

`.mcp.json` (Claude):
```json
{
  "mcpServers": {
    "postman": {
      "type": "http",
      "url": "https://mcp.postman.com/mcp",
      "headers": { "Authorization": "Bearer ${user_config.postman_api_key}" }
    }
  }
}
```
`mcp.json` (Codex):
```json
{ "mcpServers": { "postman": { "type": "streamable-http", "url": "https://mcp.postman.com/mcp" } } }
```
Codex: dùng OAuth (`codex mcp login postman`) hoặc người dùng thêm `bearer_token_env_var = "POSTMAN_API_KEY"` trong `~/.codex/config.toml` (README hướng dẫn).
⚠️ Kiểm tra region EU (chỉ API key) → cung cấp biến thể `postman-eu`.

### 2.2 File trạng thái trong project: `.postman-mock/state.json`

Lưu để các lần gọi sau không phải hỏi lại ID, và để áp lại override sau khi sync:
```json
{
  "workspaceId": "...", "specId": "...", "collectionId": "...", "collectionUid": "owner-id",
  "mock": { "id": "...", "url": "https://<id>.mock.pstmn.io", "private": false },
  "sourceSpec": "api/openapi.yaml", "specHash": "sha256...",
  "endpoints": {
    "GET /users/{id}": {
      "requestId": "...",
      "examples": { "200 OK": "respId", "404 Not Found": "respId" },
      "scenarios": [
        { "name": "user-locked", "exampleId": "...", "match": {"path": "/users/999"},
          "createdBy": "loi", "createdAt": "2026-10-30", "note": "Ticket ABC-12" }
      ]
    }
  }
}
```
Khuyến nghị commit file này (team dùng chung mock) – trừ API key.

---

## 3. Thiết kế tính năng "set giá trị trả về cho một trường hợp cụ thể"

Người dùng nói: *"API GET /users/{id} với id = 999 trả về 403, body `{code: 'ACCOUNT_LOCKED'}`"*. Skill `mock-set` chọn 1 trong 4 chiến lược (theo thứ tự ưu tiên):

| # | Chiến lược | Cách làm (MCP) | Client cần làm gì | Khi nào dùng |
|---|---|---|---|---|
| A | **Path/query cụ thể** | `createCollectionResponse` với `originalRequest.url = /users/999` | Không gì cả | Case phân biệt được bằng path/query (mặc định) |
| B | **Named scenario** | Tạo example tên `GET /users/{id} :: account-locked` | Gửi header `x-mock-response-name` | Case không phân biệt bằng URL; test tự động |
| C | **Body/header match** | Example có body request cụ thể + bật `matchBody/matchHeader` qua REST script | Gửi đúng body/header (hoặc header `x-mock-match-request-body: true`) | POST/PUT phân biệt theo payload (vd login sai mật khẩu) |
| D | **Sửa example mặc định** | `updateCollectionResponse` | Không | Đổi dữ liệu mặc định cho mọi người – **phải xác nhận** vì ảnh hưởng cả team |
| E | Lỗi toàn cục 5xx | `createMockServerResponse` + `updateMock(config.serverResponseId)` | Không | Giả lập server sập; nhớ tắt bằng `mock-reset` |

Quy tắc trong skill:
1. Đọc `state.json` + `getCollection` để tìm request & schema response trong OpenAPI.
2. **Validate body theo schema** OpenAPI của status code đó; cảnh báo nếu lệch (cho phép ghi đè khi người dùng cố ý).
3. Đặt tên example theo convention `<METHOD> <path> :: <scenario>` (duy nhất – Postman yêu cầu tên unique để `x-mock-response-name` hoạt động).
4. Nếu scenario đã tồn tại → `updateCollectionResponse` thay vì tạo mới.
5. Ghi vào `state.json` và **in ra lệnh `curl` để thử ngay**, ví dụ:
   ```
   curl https://<id>.mock.pstmn.io/users/999
   curl -H "x-mock-response-name: GET /users/{id} :: account-locked" https://<id>.mock.pstmn.io/users/1
   ```
6. Hỗ trợ thêm: delay (`x-mock-response-delay` hoặc config `delay`), dynamic values (`{{$randomUUID}}`, `{{$body 'email'}}`).

---

## 4. Luồng `mock-import` chi tiết

1. Đọc & validate file YAML (OpenAPI 2.0/3.0/3.1; giới hạn 12 MB/file; multi-file `$ref` → upload nhiều spec file, 1 ROOT).
2. Chọn workspace (`getWorkspaces`, hoặc từ userConfig).
3. `createSpec` → `generateCollection` (folder theo tag) → poll `getAsyncSpecTaskStatus` tới khi xong (timeout + retry).
   - Phương án dự phòng: `node scripts/postman-rest.mjs import-openapi <file>` (đồng bộ).
4. `getCollection` → với **mỗi request**, kiểm tra mỗi response code khai báo trong spec đã có example chưa; thiếu thì `createCollectionResponse` với body sinh từ `example`/`examples` trong spec, hoặc tự sinh dữ liệu thực tế từ schema (enum, format email/date/uuid, min/max).
5. `createMock` (collection UID, `private` theo lựa chọn) → nếu muốn public: `publishMock`.
6. Ghi `state.json`, in bảng tổng kết: số API, số example, mock URL, cách gọi.
7. Idempotent: chạy lại khi đã có `state.json` → hỏi "sync hay tạo mới".

`mock-sync`: so `specHash`; dùng `syncCollectionWithSpec` (async) rồi **áp lại scenarios** từ `state.json` (⚠️ cần kiểm tra sync có xoá example tuỳ chỉnh không).

---

## 5. Lộ trình triển khai

| Giai đoạn | Thời gian | Nội dung | Kết quả nghiệm thu |
|---|---|---|---|
| **0. PoC (Free)** | 2–3 ngày | Tạo tài khoản Postman Free + API key; thủ công trong Claude Code với Postman MCP full: import 1 spec mẫu (Petstore), tạo mock private, thử chiến lược A–D bằng curl; đếm số Postman API call đã dùng (Settings → Usage); dựng `local-mock.mjs` tối giản. Xác minh các điểm ⚠️ | Tài liệu "what works" + số call tiêu tốn/1 lần import |
| **1. MVP Claude** | 1 tuần | Skills `mock-setup`, `mock-import`, `mock-set`, `mock-list`; `.mcp.json` + userConfig; `state.json` | `claude plugin validate --strict` pass; import spec 20+ API end-to-end |
| **2. Hoàn thiện** | 1 tuần | `mock-examples`, `mock-reset`, `mock-sync`, `scripts/postman-rest.mjs` (matchBody, delay, import sync), xử lý lỗi/rate limit | Evals cho 6–8 case điển hình (`claude plugin eval`) |
| **3. Codex** | 2–3 ngày | `.codex-plugin/plugin.json`, `mcp.json`, test `$mock-import`, `$mock-set`; hướng dẫn OAuth/API key | Chạy cùng spec trên Codex CLI cho kết quả tương đương |
| **4. Phát hành** | 1–2 ngày | Repo GitHub nội bộ + `marketplace.json`; README (tiếng Việt/Anh), ví dụ, troubleshooting | Đồng nghiệp cài bằng 2 lệnh |

Cài đặt cho người dùng cuối:
```
# Claude Code
/plugin marketplace add <org>/postman-mock-plugin
/plugin install postman-mock@<org>-tools
# Codex
codex plugin marketplace add <org>/postman-mock-plugin   # rồi /plugins để cài
```

---

## 6. Rủi ro & cách xử lý

| Rủi ro | Xử lý |
|---|---|
| Full toolset 234 tool → tốn context, model chọn nhầm tool | Skills chỉ định rõ tên tool; Codex dùng `enabled_tools` để giới hạn; cân nhắc chỉ bật tool cần thiết |
| Quota mock call / 120 req/phút | Ghi rõ trong README; khuyên dùng mock private cho team, cache ở client |
| Nhiều người cùng sửa 1 mock → giẫm chân nhau | Scenario gắn `createdBy`/ticket; chiến lược D luôn hỏi xác nhận; tuỳ chọn mỗi dev 1 mock riêng (cùng collection, khác environment) |
| Sync spec xoá override | Lưu scenario trong `state.json`, re-apply sau sync |
| Lộ API key | `sensitive: true` (keychain), không ghi key vào `state.json`; ưu tiên OAuth |
| Spec lớn / `$ref` nhiều file | Hỗ trợ multi-file spec; fallback `/import/openapi` |
| API Postman MCP thay đổi (đang ở v2.x) | Pin hành vi qua evals, CI chạy `plugin validate` + eval định kỳ |

---

## 7. Mở rộng sau (tuỳ chọn)

- Sinh **Postman environment** chứa `baseUrl = mockUrl` và đổi qua lại mock ↔ dev server.
- Hook: khi file `openapi.yaml` thay đổi → nhắc chạy `mock-sync`.
- Xuất danh sách scenario thành tài liệu cho QA.
- Chế độ offline: sinh mock local (Prism) từ cùng spec khi không có mạng.

---

## Nguồn tham khảo
- https://github.com/postmanlabs/postman-mcp-server (README, `src/enabledResources.ts`)
- https://learning.postman.com/docs/design-apis/mock-apis/matching-algorithm/
- https://learning.postman.com/docs/design-apis/mock-apis/create-dynamic-responses
- https://learning.postman.com/docs/design-apis/mock-apis/mock-server-calls
- https://code.claude.com/docs/en/plugins/plugins-reference.md · marketplace-reference.md · cli-reference.md
- https://developers.openai.com/plugins/build/plugins · https://learn.chatgpt.com/docs/plugins
- https://agentskills.io/specification
