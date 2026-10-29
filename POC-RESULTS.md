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

## Chưa kiểm chứng trong PoC
- Gọi qua **Postman MCP server** (session này chưa nạp MCP; PoC dùng REST endpoint tương đương). Cần cài plugin vào Claude Code và chạy lại luồng bằng skill.
- Tool MCP `createCollectionResponse` có nhận định dạng v1 không (nếu không → skill luôn dùng script).
- Cách E (server response 5xx) và `syncCollectionWithSpec`.
- Codex.
