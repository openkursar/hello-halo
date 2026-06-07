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
- **IMPORTANT** — Comments convey context that readers cannot obtain from the code itself. Default is not needed; only add when the code itself cannot convey information. Each comment should be as brief as possible, avoid being too long, and must not carry sensitive information such as internal documents, corporate information, personal information, etc.
- Variable naming follows existing-code observation. Underscore prefix (`_name`) is reserved for intentionally-unused identifiers (e.g. `_event` in IPC handlers). Scan 2–3 sibling files for established style before naming a new local.

**tips.**
This project is 100% AI-generated, so humans may not necessarily know more than you do. You need to proactively review documentation, manage documents, and examine code to confirm details and direction (for matters involving architecture and direction, actively discuss with users).