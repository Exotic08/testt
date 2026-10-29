# testt

## MCP-style tool server (tools/)

Các tool dưới đây sống trong `tools/`, được `tools/index.js` tự động nạp và không cần sửa `server.js` để định nghĩa. Mỗi tool có JSON schema, validate trước khi chạy, trả lỗi có cấu trúc `{ ok: false, error: { code, message, details? } }` và mặc định timeout 10 giây.

- `todo_write` — `{ todos: [{ id, content, status, priority? }] }` → `{ ok, count, todos }`, lưu ở `.agent/todos.json`.
- `todo_read` — `{}` → `{ ok, todos }` (mảng rỗng nếu chưa có file).
- `notebook_edit` — `{ path, cell_index, new_source, cell_type? }` → cập nhật đúng một cell trong `.ipynb`, giữ metadata/outputs của các cell khác.
- `memory_save` — `{ key, value, tags? }` → `{ ok, key, path }`, lưu ở `.agent/memory/<key>.json`.
- `memory_search` — `{ query, limit? }` → danh sách kết quả có điểm (key x3, tag x2, nội dung x1), sắp giảm dần.
- `git_commit` — `{ message, files?, all? }` → chỉ stage đúng file được chỉ định và từ chối khi chạm protected path.

Các tool này đã được `server.js` nạp tự động qua `tools/index.js` (log khởi động in `External tools loaded: ...`).

## Khởi chạy trên Docker / Pterodactyl

`start.js` là entrypoint: mỗi lần restart nó tự tải/cập nhật code từ `GIT_REPO_URL` (mặc định repo này), cài dependency khi thiếu rồi chạy `server.js` và tự khởi động lại nếu crash. Giữ nguyên `.env`, `.agent/`, `node_modules/` qua mỗi lần cập nhật. Đặt **Main file** = `/home/container/start.js`.

```bash
node start.js
```

Chạy test: `node --test`.
