**No hardcoded text.** Use `t('English text')`.

```tsx
✓ <Button>{t('Save')}</Button>
✗ <Button>Save</Button>
```
No need to write translation files because the translation is automated.
Run `npm run i18n` before commit by user.
Before making any changes, you must read the halo-dev skill.

**Long-term principle**

Always design with high maintainability and modularity, aligned with long-term architectural planning and the evolution of code quality. Where to place code files/modules is a crucial issue — they cannot be placed randomly based on proximity to other files, nor can dependencies be introduced arbitrarily just because they happen to be needed. It is necessary to truly consider the responsibility category and abstract boundary of each file, whether to re-abstract, whether to refactor, whether to adjust the folder and module code relationships, etc. These are the points that should always be considered at the architectural level for any new feature or module.

**rules.**
- Any code changes（edit/delete/move） require human confirmation and consent.
- You must read the halo-dev specifications before writing code.
- Follow Long-term principle
- Code must stand alone — no planning labels (`E1`, `F2`, `Phase X`, etc.), no chat-session IDs, no ceremonial prefixes (`Full-chain X:`, `Helper:`, `Section:`) in code or comments. If a comment only makes sense to someone who saw the design conversation, it's wrong.
- **IMPORTANT — Comments transfer context the reader cannot get from the code itself.** Default to none; add only when the code alone cannot convey: why a decision was made, what invariant must hold, what trap is not visible locally, links to issues/RFCs. Keep each comment as short as the context allows. Rule of thumb: if removing the comment loses no context, it shouldn't exist. Forbidden: paraphrasing adjacent code, narrating removed/changed code, restating conditions, cross-function line references, explaining other functions' behavior, defensive notes aimed at reviewers.
- Variable naming follows existing-code observation. Underscore prefix (`_name`) is reserved for intentionally-unused identifiers (e.g. `_event` in IPC handlers). Scan 2–3 sibling files for established style before naming a new local.
- do not use ask tool
**tips.**
This project is 100% AI-generated, so humans may not necessarily know more than you do. You need to proactively review documentation, manage documents, and examine code to confirm details and direction (for matters involving architecture and direction, actively discuss with users).

**打包**

- 开源 `Halo` 版本：`npm run build:win-x64` / `build:mac` / `build:linux`（用当前根目录 `product.json`）。
- **WeBank 内网版本**（`Halo-WeBank Setup ...exe` / `Halo WeBank-*.dmg` 等）**必须**走 `halo-local/halo-webank/build/scripts/build-webank.sh`，两步：
  1. `cd halo-local/halo-webank/build && npm install && npm run build`（先在 halo-webank 子仓 esbuild 打出 `build/dist/providers/*/index.js`）
  2. `SKIP_UNIT_TESTS=1 SKIP_E2E_TESTS=1 ./halo-local/halo-webank/build/scripts/build-webank.sh [--mac] [--win] [--linux]`（脚本会临时切换 `product.json` 到 `product.webank.json`、附带 `halo-local/dist/**` 到 electron-builder 的 files、跑构建、恢复原 product.json）。
  平台标不传则打全部；`SKIP_*_TESTS` 用于跳过测试环节。产物落在 `hello-halo/dist/`。
- 不要用 `build:win` 之类的原生脚本去打 WeBank 版——名字、appId、更新源、内置 apps、provider bundle 都会错。
- 如果 provider 侧改动（`halo-local/halo-webank/build/providers/*`）想生效，必须先跑步骤 1 重新 esbuild，然后再跑 build-webank.sh。