# postman-mock plugin

Plugin **postman-mock** cho Claude Code và Codex: từ file OpenAPI YAML → Postman spec, collection, example cho từng API và mock server (gói Postman Free), rồi set response cho từng trường hợp cụ thể bằng ngôn ngữ tự nhiên. Kèm mock chạy trên máy (không giới hạn lượt gọi) và mock JavaScript của app Postman.

- Plugin: [postman-mock-plugin/](postman-mock-plugin/) – chi tiết script ở [README plugin](postman-mock-plugin/README.md)
- Kế hoạch: [PLAN.md](PLAN.md)
- Kết quả PoC (Petstore + spec thật 96 API): [POC-RESULTS.md](POC-RESULTS.md)

---

## 1. Chuẩn bị (làm một lần)

| Việc | Cách làm |
|---|---|
| Node.js 18+ | https://nodejs.org |
| Postman API key | Tạo tại https://postman.co/settings/me/api-keys (tài khoản Free là đủ) |
| Biến môi trường | Đặt `POSTMAN_API_KEY` ở **User variables** (Windows: `Win + R` → `rundll32 sysdm.cpl,EditEnvironmentVariables` → New). Không dán key vào chat |
| Postman CLI (chỉ cho mock của app Postman) | `npm install -g postman-cli` |

Sau khi cài plugin hoặc đổi biến môi trường: **thoát hẳn app Claude** (chuột phải icon ở khay hệ thống → Quit) rồi mở session mới.

## 2. Cài plugin

Repo đang private: cần được mời vào repo (GitHub → Settings → Collaborators) và đăng nhập GitHub trên máy.

**Claude Code**
```
/plugin marketplace add lukatizzz/postman-mock-plugin
/plugin install postman-mock@postman-mock-tools
```

**Codex CLI**
```
codex plugin marketplace add lukatizzz/postman-mock-plugin
```
rồi `/plugins` để cài. Đăng nhập Postman MCP bằng `codex mcp login postman`, hoặc thêm vào `~/.codex/config.toml`:
```toml
[mcp_servers.postman]
url = "https://mcp.postman.com/mcp"
bearer_token_env_var = "POSTMAN_API_KEY"
```

Gói Postman Free chỉ có 1 user → mỗi người dùng tài khoản và API key riêng, tự chạy `mock-import`.

## 3. Cách 1 – Mock trên cloud Postman (gọi được từ mọi máy)

Mở session Claude Code trong thư mục dự án, nói tự nhiên hoặc gõ lệnh:

1. **Kiểm tra môi trường**: `/postman-mock:mock-setup`
2. **Tạo mock từ spec**: *"Tạo mock từ file `docs/openapi.yaml`"* (hoặc `/postman-mock:mock-import docs/openapi.yaml`)
   → collection, example cho mọi status code, mock **private**, mock URL `https://<id>.mock.pstmn.io/<base path>`
3. **Set response cho trường hợp cụ thể** (`/postman-mock:mock-set`), ví dụ:
   - *"GET /constructions/99999999 trả 404 với message 物件が見つかりません"*
   - *"Login với password `wrong` trả 401"*
   - *"Tạo scenario `long-address` cho GET /constructions/{no}, địa chỉ thật dài"*
   - *"Toàn bộ server trả 503 để test màn hình bảo trì"*
4. **Xem**: `/postman-mock:mock-list`
5. **Hoàn tác**: `/postman-mock:mock-reset` (Claude hỏi lại trước khi xoá)

**Gọi mock** (frontend / curl):
```bash
curl -H "x-api-key: <POSTMAN_API_KEY>" https://<id>.mock.pstmn.io/api/v1/tasks
```

| Muốn | Header |
|---|---|
| Lấy lỗi có sẵn (401/403/500…) | `x-mock-response-code: 401` |
| Chọn scenario theo tên (tên ASCII) | `x-mock-response-name: GET /constructions/{constructionNo} :: long-address` |
| Làm chậm | `x-mock-response-delay: 2000` |
| Mock private | `x-api-key: <key>` (bắt buộc) |

## 4. Cách 2 – Mock chạy trên máy (không tốn quota)

### 4a. Mock local của plugin (nhẹ nhất)
*"Chạy mock local"* (`/postman-mock:mock-local`) → `http://localhost:4010/api/v1/...`. Không cần `x-api-key`; các header ở bảng trên vẫn dùng được.

### 4b. Mock JavaScript của app Postman (scenario + có thể giữ dữ liệu giữa các request)
1. *"Tạo mock app Postman từ collection/spec, có stateful"* (`/postman-mock:mock-app`) → `postman/mocks/<tên>/config.yaml` + `default.js`
2. Thêm scenario: *"Thêm scenario `qa-edge-cases`: /constructions/99999999 trả 404"*
3. Chạy:
   - CLI: `postman mock run postman/mocks/<tên>`
   - App Postman desktop *(chưa kiểm chứng; nhãn trong app có thể khác)*: kết nối thư mục Git của dự án (Native Git) → **Local View** → **Mocks** → chọn mock → **Start**. Port lấy từ `config.yaml`. Không thấy mock → đặt `postman/mocks` ở **gốc repo**.
4. Gọi: `http://localhost:<port>/...`; chọn scenario bằng header `x-mock-scenario: <tên>`.

Ví dụ có sẵn trong repo (Petstore):
```bash
postman mock run local-mock-poc/postman/mocks/petstore-static
curl -H "x-mock-scenario: pet-sold" http://localhost:4501/v1/pets/1
```

## 5. Xử lý sự cố

| Triệu chứng | Xử lý |
|---|---|
| Không thấy `/postman-mock:*` | Thoát hẳn app Claude, mở session mới |
| `401 invalidCredentialsError` | Thiếu header `x-api-key` (mock private) |
| `404 mockRequestNotFoundError` | Thiếu base path (vd. `/api/v1`) hoặc chưa chạy bước chuẩn hoá của `mock-import` |
| `x-mock-response-name` tiếng Nhật không ăn | Postman chỉ khớp tên ASCII → dùng `x-mock-response-code` |
| Mock bỗng gọi được không cần key | `updateMock` thiếu `private` → nhờ Claude *"đặt lại mock về private"* |
| Dừng mock local | Ctrl+C ở cửa sổ đang chạy. **Đừng** kill mọi tiến trình `postman` (sẽ tắt luôn app desktop) |
| Spec lớn sinh mock app có body `<Error: Too many levels of nesting…>` | Sinh từ collection thay vì spec (skill `mock-app` tự xử lý) |
