# CREATE-SERVER-MOCK-POSTMAN

Plugin **postman-mock** cho Claude Code và Codex: từ file OpenAPI YAML → Postman spec, collection, example cho từng API và mock server (gói Postman Free), rồi set response cho từng trường hợp cụ thể bằng ngôn ngữ tự nhiên. Có kèm mock local chạy không giới hạn.

- Plugin: [postman-mock-plugin/](postman-mock-plugin/) – xem [README](postman-mock-plugin/README.md)
- Kế hoạch: [PLAN.md](PLAN.md)
- Kết quả PoC (Petstore + spec thật 96 API): [POC-RESULTS.md](POC-RESULTS.md)

## Cài nhanh

Yêu cầu: Node.js 18+, biến môi trường `POSTMAN_API_KEY` (https://postman.co/settings/me/api-keys).

Claude Code (repo private cần quyền truy cập GitHub):
```
/plugin marketplace add <owner>/<repo>
/plugin install postman-mock@postman-mock-tools
```

Codex CLI:
```
codex plugin marketplace add <owner>/<repo>
```
rồi `/plugins` để cài.
