# Claudex MCP-style tool server

Thư mục này chứa registry động cho các tool ngoài `server.js`: mỗi tool là một module riêng, được `tools/index.js` tự động import và validate theo JSON schema.

## Cấu trúc

```
src/
  errors.js            # bộ mã lỗi chuẩn (E_VALIDATION, E_TIMEOUT, E_PROTECTED_PATH, E_NOT_FOUND, E_IO)
  validate.js          # validator dựa trên JSON schema (type, enum, min/max, required, additionalProperties, format: path)
  log.js               # logger 1 dòng JSON (level, tool, result, code)
  fs/paths.js          # PROTECTED_PATHS + kiểm tra path được bảo vệ
  fs/guard.js          # resolve an toàn, chặn traversal, ghi file atomic (temp + rename)
  exec/git.js          # execFile (không shell), allowlist subcommand/option, timeout giết tiến trình con
tools/
  _support/            # helper dùng chung (runner, sandbox, agent store) - không phải tool
  index.js             # registry tự động, phát hiện trùng tên, xuất schema OpenAI/function-calling
  <name>.js            # mỗi tool export { name, schema, handler, run }
tests/
  tools.test.js        # node:test, không thêm dependency
```

## Quy ước viết tool mới

Thêm đúng một file `tools/<ten-tool>.js` với `name` trùng tên file:

```js
import { createToolRunner } from './_support/createToolRunner.js';

export const name = 'vd_tool';
export const schema = { type: 'object', required: ['x'], additionalProperties: false, properties: { x: { type: 'string' } } };
export async function handler(input, context) {
  const base = context.root; // workspace của hội thoại
  return { ok: true, echo: input.x };
}
export const run = createToolRunner({ name, schema, handler });
export default { name, schema, handler, run };
```

Handler không bao giờ throw ra ngoài: mọi lỗi được `run` chuyển thành `{ ok: false, error: { code, message, details? } }`, timeout mặc định 10 giây, và mỗi lần gọi ghi đúng 1 dòng log.

## Gắn vào server

`server.js` đã import registry này:

```js
import { getOpenAiTools, getRegistry } from './tools/index.js';
```

Lúc khởi động server nạp `externalToolRegistry`/`externalToolSpecs`, gửi model với `tools: TOOLS.concat(externalToolSpecs)`, và khi model gọi tool không có trong `TOOL_EXECUTORS` thì chuyển cho `externalToolRegistry.get(toolName).run(args, { root, timeoutMs: 10000 })`. Log khởi động in `External tools loaded: ...`.

## start.js (Docker entrypoint)

`start.js` là entrypoint cho Pterodactyl/Docker: mỗi lần restart nó tự `git fetch` (hoặc `git clone` nếu chưa có repo, clone tạm ngay trong thư mục app để chạy được cả khi thư mục cha chỉ đọc), cập nhật code, cài dependency khi thiếu, rồi chạy `server.js` và giám sát tiến trình (tự khởi động lại nếu crash, dừng theo SIGTERM). Mặc định `CLEAN_INSTALL=1`: code cũ bị xoá sạch và thay bằng đúng bản trong repo, chỉ giữ `.env`, `.agent/`, `node_modules/`, `skills/` (hoặc đổi bằng `PRESERVE_PATHS`).

| biến môi trường | mặc định | ý nghĩa |
|---|---|---|
| `GIT_REPO_URL` | `https://github.com/Exotic08/testt.git` | repo nguồn |
| `GIT_BRANCH` | `main` | nhánh theo dõi |
| `GIT_REMOTE` | `origin` | tên remote |
| `AUTO_UPDATE` | `1` | `0` để tắt cập nhật |
| `NPM_INSTALL` | `auto` | `always` / `never` |
| `START_ENTRY` | `server.js` | file khởi chạy |
| `START_NODE_MODULES` | (trống) | thư mục `node_modules` có sẵn để symlink khi không cài được |
| `START_LOG_FILE` | (trống) | ghi log start.js ra file |
| `GITHUB_TOKEN` | (trống) | token GitHub (scope `repo`) nếu repo private |
| `GIT_AUTH_URL` | (trống) | URL có sẵn credential, ưu tiên hơn token |
| `CLEAN_INSTALL` | `1` | xoá code cũ rồi cài đúng bản repo (giữ các đường dẫn `PRESERVE_PATHS`) |
| `PRESERVE_PATHS` | `.env,.agent,node_modules,skills` | danh sách giữ lại khi clean install |
