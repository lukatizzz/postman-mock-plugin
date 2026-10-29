# postman-mock plugin

Plugin **postman-mock** cho Claude Code và Codex: từ file OpenAPI YAML → Postman spec, collection, example cho từng API và mock server (gói Postman Free), rồi set response cho từng trường hợp cụ thể bằng ngôn ngữ tự nhiên. Kèm mock chạy trên máy (không giới hạn lượt gọi) và mock JavaScript của app Postman.

- Plugin: [postman-mock-plugin/](postman-mock-plugin/) – chi tiết script ở [README plugin](postman-mock-plugin/README.md)
- Kế hoạch: [PLAN.md](PLAN.md)
- Kết quả PoC (Petstore + spec thật 96 API): [POC-RESULTS.md](POC-RESULTS.md)

---

## 1. Chuẩn bị (làm một lần)

Chung cho mọi hệ điều hành:
- Postman API key: tạo tại https://postman.co/settings/me/api-keys (tài khoản Free là đủ). **Không dán key vào chat.**
- Postman CLI (chỉ cần cho mock của app Postman): `npm install -g postman-cli`

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
3. **Cho Terminal** (Claude Code CLI, Codex, Postman CLI) – thêm vào `~/.zshrc`:
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

Gói Postman Free chỉ có 1 user → mỗi người dùng tài khoản và API key riêng, tự chạy `mock-import`.

Các lệnh trong hướng dẫn này giống nhau trên Windows và Mac (curl, `node`, `postman mock run`, slash command trong Claude). Trên Mac, thay `<POSTMAN_API_KEY>` trong curl bằng `$POSTMAN_API_KEY`; trên Windows PowerShell dùng `$env:POSTMAN_API_KEY`.

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

## 4. Cách 2 – Code mock trong Mocks của Postman (cloud)

Code mock (JavaScript, có scenario, tuỳ chọn stateful) được tạo **thẳng trong workspace cloud** – hiện ở mục **Mocks** của app Postman. Dự án không chứa file code nào, chỉ có một file định nghĩa nhỏ `.postman-mock/code-mocks/<tên>.json` (đã git-ignore). Dùng được với gói Free.

Lần đầu: đăng nhập Postman CLI (tự gõ trong terminal, không dán key vào chat):
```bash
postman login --with-api-key <POSTMAN_API_KEY>
```

1. *"Tạo code mock trên Postman cho JumpApp, có scenario `qa-edge-cases`: /constructions/99999999 trả 404, /tasks?searchWord=none trả list rỗng"* (`/postman-mock:mock-app`)
   → Claude ghi định nghĩa rồi chạy `app-mock.mjs cloud-push`: dựng code ở thư mục tạm, đẩy lên cloud, xoá thư mục tạm. Kết quả: `mockId` và link mở mock trong Postman.
2. Sửa / thêm scenario: nói tiếp với Claude → `cloud-push` lại → cập nhật **đúng mock đó**.
3. Chạy mock (code tải từ cloud):
   - CLI: `postman mock run <mockId> --port 4520`
   - Hoặc mở mock trong app Postman (Mocks) và Start.
4. Gọi:
   ```bash
   curl http://localhost:4520/api/v1/tasks
   curl -H "x-mock-scenario: qa-edge-cases" http://localhost:4520/api/v1/constructions/99999999
   curl -H "x-mock-response-code: 401" http://localhost:4520/api/v1/tasks
   ```

Lưu ý:
- Không gửi `x-mock-scenario` → scenario default; tên scenario sai → cũng rơi về default.
- Push không xoá được scenario trên cloud: bỏ scenario khỏi định nghĩa + thêm vào `retiredScenarios` (về hành vi default), muốn xoá hẳn thì xoá trong app.
- Đưa code mock thành URL công khai (`postman mock deploy`) cần gói Solo/Team/Enterprise.
- Mẫu định nghĩa: [postman-mock-plugin/examples/petstore-code-mock.json](postman-mock-plugin/examples/petstore-code-mock.json)

### Mock local của plugin (không cần Postman, gọi không giới hạn)
*"Chạy mock local"* (`/postman-mock:mock-local`) → `http://localhost:4010/api/v1/...`. Không cần `x-api-key`; các header ở mục 3 vẫn dùng được.

## 5. Xử lý sự cố

| Triệu chứng | Xử lý |
|---|---|
| Không thấy `/postman-mock:*` | Thoát hẳn app Claude (Windows: Quit ở khay hệ thống; Mac: ⌘Q), mở session mới |
| Mac: Terminal thấy key nhưng app Claude báo thiếu `POSTMAN_API_KEY` | App mở từ Dock không đọc `~/.zshrc` → chạy bước `launchctl setenv` ở mục 1 rồi ⌘Q và mở lại app |
| Mac: `security: SecKeychainSearchCopyNext: The specified item could not be found` | Chưa lưu key vào Keychain, hoặc tên service khác `postman-api-key` |
| `401 invalidCredentialsError` | Thiếu header `x-api-key` (mock private) |
| `404 mockRequestNotFoundError` | Thiếu base path (vd. `/api/v1`) hoặc chưa chạy bước chuẩn hoá của `mock-import` |
| `x-mock-response-name` tiếng Nhật không ăn | Postman chỉ khớp tên ASCII → dùng `x-mock-response-code` |
| Mock bỗng gọi được không cần key | `updateMock` thiếu `private` → nhờ Claude *"đặt lại mock về private"* |
| Dừng mock local | Ctrl+C ở cửa sổ đang chạy. **Đừng** kill mọi tiến trình `postman` (Windows: `Stop-Process -Name postman`; Mac: `pkill -i postman` / `killall Postman`) – sẽ tắt luôn app desktop. Mac: tìm đúng tiến trình bằng `lsof -i :4501` rồi `kill <PID>` |
| Code mock có body `<Error: Too many levels of nesting…>` | Dùng `source.collection` thay vì `source.spec` trong định nghĩa |
| `cloud-push` báo chưa đăng nhập | Chạy `postman login --with-api-key <key>` trong terminal |
| `A scenario with this name already exists` | Mock được tạo bằng `postman mock generate -w` không push đè được → để `mock-app` tạo mock mới bằng `cloud-push` |
