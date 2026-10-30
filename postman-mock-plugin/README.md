# postman-mock plugin

Plugin cho **Claude Code** và **Codex**:
- **Postman**: OpenAPI YAML → Spec + collection (example cho từng status, đã chuẩn hoá) → giữ đồng bộ khi file yml đổi.
- **Mock Hub**: mock server chạy trên collection đó – dữ liệu mock theo flow, case có điều kiện, bật/tắt theo flow, Mock/Real từng API, dashboard + MCP cho team. Sửa là có hiệu lực ngay.

## Yêu cầu
- Postman API key (https://postman.co/settings/me/api-keys) trong biến môi trường `POSTMAN_API_KEY`. Không dán key vào chat.
- Node.js 18+.

## Cài đặt
Claude Code:
```
/plugin marketplace add <org>/postman-mock-plugin
/plugin install postman-mock@postman-mock-tools
```
Codex CLI: `codex plugin marketplace add <org>/postman-mock-plugin`, rồi `/plugins`. Postman MCP: `codex mcp login postman`, hoặc trong `~/.codex/config.toml`:
```toml
[mcp_servers.postman]
url = "https://mcp.postman.com/mcp"
bearer_token_env_var = "POSTMAN_API_KEY"
```

## Skills
| Skill | Claude | Codex | Việc làm |
|---|---|---|---|
| mock-setup | `/postman-mock:mock-setup` | `$mock-setup` | Kiểm tra key, Postman MCP, Node, quota API; chọn workspace |
| mock-import | `/postman-mock:mock-import api/openapi.yaml` | `$mock-import` | Spec → collection → chuẩn hoá example → tạo mock trên Hub (spec đã import thì đồng bộ) |
| mock-dashboard | `/postman-mock:mock-dashboard` | `$mock-dashboard` | Mock Hub: chạy server, tạo dữ liệu mock, flow, Mock/Real, đồng bộ spec, MCP cho team |

Nói tự nhiên cũng được: *"tạo collection và mock từ api/openapi.yaml"*, *"API login trả 401 khi password là wrong"*, *"file yml vừa đổi, đồng bộ lại"*.

## Scripts
```
node plugins/postman-mock/scripts/postman-rest.mjs me
node plugins/postman-mock/scripts/postman-rest.mjs create-spec api.yml --workspace <id>
node plugins/postman-mock/scripts/postman-rest.mjs generate-collection <specId>
node plugins/postman-mock/scripts/postman-rest.mjs normalize-collection <collectionUid>
node plugins/postman-mock/scripts/spec-sync.mjs <projectRoot> [--dry-run]
node plugins/postman-mock/scripts/dashboard.mjs --port 4800 --project <name>
node plugins/postman-mock/scripts/verify-mock.mjs .postman-mock/collections/<uid>.json http://localhost:4800/gw/<project>/<mock>
```

## Test
```
cd plugins/postman-mock && node --test test/
```
