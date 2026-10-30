# postman-mock plugin

Plugin **postman-mock** cho Claude Code và Codex: từ file OpenAPI YAML → **Postman Spec + collection** (example cho từng status, tự đồng bộ khi file yml đổi; gói Postman Free) → **Mock Hub** chạy trên collection đó: dữ liệu mock theo flow, case có điều kiện, bật/tắt theo flow, Mock / API thật từng API, dashboard + MCP cho cả team. Sửa là có hiệu lực ngay.

- Plugin: [postman-mock-plugin/](postman-mock-plugin/) – chi tiết script ở [README plugin](postman-mock-plugin/README.md)
- Kế hoạch: [PLAN.md](PLAN.md)
- Kết quả PoC (Petstore + spec thật 96 API): [POC-RESULTS.md](POC-RESULTS.md)

---

## 1. Chuẩn bị (làm một lần)

Chung cho mọi hệ điều hành:
- Postman API key: tạo tại https://postman.co/settings/me/api-keys (tài khoản Free là đủ). **Không dán key vào chat.**

### Windows

| Việc | Cách làm |
|---|---|
| Node.js 18+ | Cài bản LTS từ https://nodejs.org |
| `POSTMAN_API_KEY` | `Win + R` → `rundll32 sysdm.cpl,EditEnvironmentVariables` → **User variables** → New → tên `POSTMAN_API_KEY`, giá trị là key |
| Hoặc bằng PowerShell (key không lưu vào lịch sử lệnh) | `$k = Read-Host "Postman API key" -AsSecureString; [Environment]::SetEnvironmentVariable("POSTMAN_API_KEY", [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($k)), "User")` |
| Áp dụng | **Thoát hẳn app Claude** (chuột phải icon ở khay hệ thống → Quit) rồi mở lại |

### macOS

1. **Node.js 18+**: `brew install node` (Homebrew) hoặc bộ cài `.pkg` từ https://nodejs.org. Kiểm tra: `node --version`.
2. **Lưu key vào Keychain** (không để key dạng chữ trong file cấu hình):
   ```bash
   security add-generic-password -a "$USER" -s postman-api-key -w
   ```
   (lệnh hỏi key và không hiện ký tự khi dán)
3. **Cho Terminal** (Claude Code CLI, Codex, Mock Hub) – thêm vào `~/.zshrc`:
   ```bash
   export POSTMAN_API_KEY="$(security find-generic-password -a "$USER" -s postman-api-key -w 2>/dev/null)"
   ```
   rồi `source ~/.zshrc`.
4. **Cho app Claude desktop** – app mở từ Dock/Launchpad **không đọc `~/.zshrc`**, phải nạp biến vào launchd:
   ```bash
   launchctl setenv POSTMAN_API_KEY "$(security find-generic-password -a "$USER" -s postman-api-key -w)"
   ```
   Biến này mất sau khi khởi động lại máy. Để tự nạp khi đăng nhập, tạo `~/Library/LaunchAgents/local.postman-api-key.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>local.postman-api-key</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/sh</string><string>-c</string>
       <string>launchctl setenv POSTMAN_API_KEY "$(security find-generic-password -s postman-api-key -w)"</string>
     </array>
     <key>RunAtLoad</key><true/>
   </dict>
   </plist>
   ```
   rồi `launchctl load ~/Library/LaunchAgents/local.postman-api-key.plist`.
5. **Kiểm tra** (chỉ in độ dài, không in key): `echo ${#POSTMAN_API_KEY}` và `launchctl getenv POSTMAN_API_KEY | wc -c` – phải lớn hơn 1.
6. **Áp dụng**: thoát hẳn app Claude bằng **⌘Q** (đóng cửa sổ là chưa đủ) rồi mở lại.
7. `npm install -g` báo lỗi quyền (`EACCES`)? Dùng Node từ Homebrew/nvm thay vì bản cài vào `/usr/local` bằng sudo – **không** chạy `sudo npm install -g`.

Sau khi cài plugin hoặc đổi biến môi trường, luôn mở **session mới** để plugin và Postman MCP được nạp lại.

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

Gói Postman Free chỉ có 1 user → mỗi người dùng tài khoản và API key riêng, hoặc cả team dùng chung một Mock Hub (mục 4).

Các lệnh trong hướng dẫn này giống nhau trên Windows và Mac (curl, `node`, slash command trong Claude).

## 3. Tạo collection từ OpenAPI (Postman)

Mở session Claude Code trong thư mục dự án, nói tự nhiên hoặc gõ lệnh:

1. **Kiểm tra môi trường**: `/postman-mock:mock-setup`
2. **Import**: *"Tạo collection và mock từ file `docs/openapi.yaml`"* (hoặc `/postman-mock:mock-import docs/openapi.yaml`)
   → Spec trong Postman (mục Specs) → collection có example cho mọi status code, đã chuẩn hoá → bản sao local `.postman-mock/collections/<uid>.json` → mock trên Mock Hub.
3. Collection dùng bình thường trong app Postman (gửi request tới server thật, chia sẻ cho team…).

## 4. Mock Hub: mock server + dashboard + MCP

Hub tự trả dữ liệu mock từ example của collection + dữ liệu bạn tạo. **Sửa là có hiệu lực ngay** – không cần push, không cần Postman lúc chạy (collection được lưu sẵn trên máy).

**Chạy**
```bash
node postman-mock-plugin/plugins/postman-mock/scripts/dashboard.mjs --port 4800 --project demo
```
Mở http://localhost:4800/ (hoặc nói với Claude *"mở mock hub"* – `/postman-mock:mock-dashboard`). Mock URL: `http://localhost:4800/gw/<project>/<mock>/api/v1/...`

**Khái niệm**
- **Flow** (luồng / scenario): `default` là dữ liệu client nhận khi không chọn gì; flow khác chọn bằng header `x-mock-scenario: <flow>` hoặc "Flow client nhận" trên hub.
- Mỗi **API × flow** có: danh sách **case có điều kiện** (khớp case nào trước thì trả case đó), **dữ liệu chung** (khi không case nào khớp), và công tắc **Bật**.
  Thứ tự: case của flow → dữ liệu chung của flow → case default → dữ liệu default → example gốc (2xx thấp nhất). **Tắt** API trong một flow → API trả dữ liệu default.
- **Điều kiện** (`when`, tất cả phải khớp, `*` = có giá trị bất kỳ): path param (`constructionNo = 99999999`), query (`searchWord = none`), header (`authorization = Bearer expired`), field trong body (`user.email = a@b.c`).
- **Chế độ** từng API: **Mock** hoặc **Real** – API Real được hub **chuyển tiếp sang server thật** (`Real API base URL`, giữ nguyên method, header kể cả `Authorization`, body), nên app chỉ cần một base URL là hub. App cũng có thể gọi thẳng server thật theo bảng route.

| Phần | Làm gì |
|---|---|
| **Mock base URL** | `http://localhost:4800/gw/<project>/<mock>/api/v1` – base URL cho các API ở chế độ Mock |
| **Real API base URL** | URL môi trường thật. **Lưu cho cả project** (mặc định, trong `.postman-mock/state.json`): mọi mock, kể cả mock tạo sau, dùng lại. Chọn "chỉ mock này" nếu một mock cần URL khác |
| **Cấu hình route cho app client** | `…/__routes` (JSON) hoặc `…/__client.js` (`urlFor('GET', '/tasks')` tự chọn mock hay server thật) |
| **+ Tạo dữ liệu mock** (hoặc nút **+** ở từng API) | Chọn API → điều kiện (path param / query / header / body field, hoặc "mọi request") → status → body (tự lấy từ example theo status) → **Tạo** |
| Tab **Flow** + **+ Flow** | Thêm / bỏ luồng mock |
| Cột **Chế độ** | Mock / Real từng API (+ Tất cả Mock / Tất cả Real) |
| Cột **Bật** | Bật / tắt dữ liệu mock của API trong flow đang xem |
| Nút **Sửa** | Danh sách **case** (điều kiện → response, sắp xếp ↑↓), **dữ liệu chung**, gửi thử (hiện dữ liệu trả từ case / data / example nào) |
| **⟳** | Tải lại collection từ Postman |

Header khi gọi mock:

| Muốn | Header |
|---|---|
| Chọn flow | `x-mock-scenario: qa-edge-cases` |
| Lấy example có sẵn theo status (401/403/500…) | `x-mock-response-code: 401` |
| Lấy example theo tên | `x-mock-response-name: <tên example>` |
| Làm chậm | `x-mock-response-delay: 2000` |

Giá trị động trong body: `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomFullName}}`, `{{$body 'email'}}`, `{{$queryParams 'k'}}`, `{{$headers 'k'}}`, `{{$pathParams 'id'}}`.

Gọi API Real qua hub: hub gửi request sang server thật rồi trả nguyên response (header `x-gateway-mode: real`). Không dùng redirect, vì client (trình duyệt, Dart `HttpClient`) bỏ header `Authorization` khi redirect sang origin khác, và `HttpClient` không đi theo 307 với POST / PUT.

Muốn app gọi thẳng server thật cho API Real (không qua hub), dùng bảng route (dev):
```js
const { urlFor } = await import('http://localhost:4800/gw/demo/jumpapp/__client.js');
const res = await fetch(urlFor('GET', '/tasks?page=1'));   // API Real → server thật, API Mock → hub
```

**Hub dùng chung cho team + MCP**
1. Trên máy chủ nội bộ (Node 18+, có `POSTMAN_API_KEY`): copy [examples/hub.example.json](postman-mock-plugin/examples/hub.example.json) thành `hub.json`, khai báo `projects`, `publicUrl`.
2. Tạo token cho từng người (token chỉ in ra một lần, file chỉ lưu SHA-256):
   ```bash
   node postman-mock-plugin/plugins/postman-mock/scripts/dashboard.mjs --hub hub.json --new-token loi --projects jumpapp
   ```
3. Chạy hub: `node postman-mock-plugin/plugins/postman-mock/scripts/dashboard.mjs --hub hub.json`. Nên đặt sau HTTPS (reverse proxy) hoặc VPN.
4. Mỗi người nối MCP vào agent của mình (tự gõ, không dán token vào chat):
   - Claude Code: `claude mcp add --transport http mock-hub https://<hub>/mcp --header "Authorization: Bearer <token>"`
   - Codex (`~/.codex/config.toml`):
     ```toml
     [mcp_servers.mock-hub]
     url = "https://<hub>/mcp"
     bearer_token_env_var = "MOCK_HUB_TOKEN"
     ```
5. Rồi nói tự nhiên, ví dụ: *"Trong project jumpapp, API GET /constructions/:constructionNo: khi constructionNo = 99999999 trả 404; ở flow qa-edge-cases tắt API này"*.

Tool MCP: `list_projects`, `create_project`, `set_project_settings`, `list_mocks`, `create_mock`, `list_apis`, `get_api`, `set_api_response`, `clear_api_response`, `upsert_case`, `remove_case`, `set_api_enabled`, `set_api_mode`, `set_mock_settings`, `add_flow`, `remove_flow`, `try_request`, `get_routes`, `sync_from_spec`, `resolve_orphan`.

- Dashboard của hub dùng chung hỏi token khi mở (lưu trong trình duyệt của bạn). URL mock `/gw/…` không cần token.
- Dừng: Ctrl+C.

### Khi cập nhật file OpenAPI (.yml)

1. Sửa file yml như bình thường (file ghi trong `.postman-mock/state.json` → `sourceSpec`).
2. Mở Mock Hub: card mock hiện **⚠ File OpenAPI đã thay đổi** (so hash với lần đồng bộ trước).
3. **Xem trước thay đổi** (không sửa gì trên Postman) → **Đồng bộ từ spec**:
   - collection trên Postman được cập nhật **tại chỗ** – giữ nguyên collection UID và ID request / example;
   - example scenario (`… :: …`) được giữ lại, kể cả khi API chỉ đổi tên path param (`{petId}` → `{id}`);
   - example được chuẩn hoá lại; spec trên Postman và bản sao local được cập nhật → mock dùng API mới ngay.
4. Đọc báo cáo: **API mới / bị xoá / có thể đổi tên**, scenario bị bỏ (API không còn).
5. **Dữ liệu mock mồ côi** (dữ liệu của API không còn): chọn API đích → **Chuyển** (tên path param trong điều kiện được đổi theo) hoặc **Xoá**.
6. **Có thể lệch schema**: dữ liệu đã sửa thiếu / thừa field so với example mới → bấm **Sửa**.

Không dùng dashboard: `node postman-mock-plugin/plugins/postman-mock/scripts/spec-sync.mjs <thư mục dự án> [--dry-run]`, hoặc MCP `sync_from_spec` → `resolve_orphan`.

## 5. Xử lý sự cố

| Triệu chứng | Xử lý |
|---|---|
| Không thấy `/postman-mock:*` | Thoát hẳn app Claude (Windows: Quit ở khay hệ thống; Mac: ⌘Q), mở session mới |
| Mac: Terminal thấy key nhưng app Claude báo thiếu `POSTMAN_API_KEY` | App mở từ Dock không đọc `~/.zshrc` → chạy bước `launchctl setenv` ở mục 1 rồi ⌘Q và mở lại app |
| Mac: `security: SecKeychainSearchCopyNext: The specified item could not be found` | Chưa lưu key vào Keychain, hoặc tên service khác `postman-api-key` |
| Mock trả `404 mockRequestNotFoundError` | Sai path / method so với collection; base path (vd. `/api/v1`) có thể bỏ hoặc giữ đều được. Xem `x-mock-source` / nút "Gửi thử" |
| Mock không có API mới vừa thêm vào yml | Chưa đồng bộ: **Đồng bộ từ spec** trên hub (hoặc ⟳ nếu đã sửa collection trực tiếp trong Postman) |
| Hub báo `POSTMAN_API_KEY is not set` | Chỉ cần khi tải / làm mới collection; đặt biến môi trường rồi chạy lại hub |
| Postman sinh body `<Error: Too many levels of nesting…>` / `<string>` | Sửa example trong collection (`mock-import` bước 3) hoặc tạo dữ liệu mock trên hub |
