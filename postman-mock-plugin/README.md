# postman-mock plugin (PoC)

Plugin cho **Claude Code** và **Codex**: từ file OpenAPI YAML → tạo collection, example cho từng API và mock server trên **Postman (gói Free)**, rồi dùng ngôn ngữ tự nhiên để set response cho từng trường hợp cụ thể. Có thêm mock local miễn phí, gọi không giới hạn.

## Yêu cầu
- Tài khoản Postman Free + API key (https://postman.co/settings/me/api-keys), đặt vào **biến môi trường người dùng** `POSTMAN_API_KEY`. Không dán key vào chat.
- Node.js 18+ (https://nodejs.org).

## Cài đặt

Claude Code:
```
/plugin marketplace add <org>/postman-mock-plugin      # hoặc đường dẫn local tới thư mục này
/plugin install postman-mock@postman-mock-tools
```

Codex CLI:
```
codex plugin marketplace add <org>/postman-mock-plugin
```
rồi mở `/plugins` để cài. Đăng nhập MCP bằng `codex mcp login postman` (OAuth), hoặc thêm vào `~/.codex/config.toml`:
```toml
[mcp_servers.postman]
url = "https://mcp.postman.com/mcp"
bearer_token_env_var = "POSTMAN_API_KEY"
```

## Skills

| Skill | Claude | Codex | Việc làm |
|---|---|---|---|
| mock-setup | `/postman-mock:mock-setup` | `$mock-setup` | Kiểm tra key, MCP, Node, quota; chọn workspace |
| mock-import | `/postman-mock:mock-import api/openapi.yaml` | `$mock-import` | Spec → collection → example → mock |
| mock-set | `/postman-mock:mock-set GET /pets/999 trả 404` | `$mock-set` | Set response cho case cụ thể |
| mock-list | `/postman-mock:mock-list` | `$mock-list` | Xem mock URL, API, scenario |
| mock-reset | `/postman-mock:mock-reset` | `$mock-reset` | Xoá scenario / tắt lỗi toàn cục |
| mock-local | `/postman-mock:mock-local` | `$mock-local` | Chạy mock local (không tốn quota) |

Cũng có thể nói tự nhiên: *"tạo mock từ api/openapi.yaml"*, *"cho API login trả 401 khi password là wrong"*.

## Script dùng trực tiếp
```
node plugins/postman-mock/scripts/postman-rest.mjs me
node plugins/postman-mock/scripts/postman-rest.mjs import-openapi examples/petstore.yaml --workspace <id>
node plugins/postman-mock/scripts/postman-rest.mjs create-spec api.yml --workspace <id>
node plugins/postman-mock/scripts/postman-rest.mjs generate-collection <specId>
node plugins/postman-mock/scripts/postman-rest.mjs normalize-collection <collectionUid>
node plugins/postman-mock/scripts/postman-rest.mjs create-mock <collectionUid> --workspace <id>
node plugins/postman-mock/scripts/postman-rest.mjs export-collection <collectionUid>
node plugins/postman-mock/scripts/verify-mock.mjs .postman-mock/collection.json <mockUrl>
node plugins/postman-mock/scripts/local-mock.mjs --collection .postman-mock/collection.json --port 4010
```

## Test
```
cd plugins/postman-mock && node --test test/
```
