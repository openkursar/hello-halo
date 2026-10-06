# Knowledge Base — Documents the AI Answers From

Last updated: 2026-10-06

Read this when the user asks what a knowledge base (知识库) is, which files it accepts, why a file
is not "learned", how to make the AI or a digital human use one, or how watched folders behave.
This topic has no companion documents.

## 1. What it is (and is not)

- **Local text extraction, no model work.** "Learning" extracts each source file to plain text on
  the user's machine (`src/main/services/tlon/ingest.ts`). Nothing is sent to a model at ingest
  time, so dozens of files finish in seconds.
- **Answering is agentic search over that text.** A conversation that has a knowledge base loaded
  gets the base's document map in its prompt, and the agent searches and reads the extracted text
  when it needs to (`getKBChatContext`, `getKBReferenceById` in `src/main/services/tlon/service.ts`).
  It is **not** an embedding or vector index — do not describe it as one.
- **Storage.** `<Halo data dir>/knowledge-bases/<id>/` plus `knowledge-bases-index.json`; the data
  dir is `~/.halo` on a default install (`src/main/services/tlon/paths.ts`). Files added on the
  Files tab are **copied** into the base; watched folders are read in place.

## 2. Accepted files

| Kind | Extensions |
|---|---|
| Text | `.md` `.markdown` `.txt` `.text` `.rst` `.org` `.csv` `.tsv` `.html` `.htm` |
| Documents (parsed) | `.pdf` `.docx` `.pptx` `.xlsx` |
| Images (on-device OCR) | `.png` `.jpg` `.jpeg` `.webp` `.bmp` `.tif` `.tiff` `.gif` |

Everything else is rejected by design — source code, configuration and logs are not treated as
knowledge (`TEXT_EXTENSIONS`, `isAcceptedSourceFile` in `service.ts`; `extract.ts`). Folder import
skips `.git`, `node_modules`, build output and similar directories. A file that yields no text — a
scanned PDF without a text layer, an image without text — is shown as **Skipped — no readable
text** (已跳过 — 无可读文本) and can be cleaned up from the Files tab.

## 3. Where the user does things

UI path: **Knowledge Base** (知识库) in the left navigation → a knowledge base → tabs **Chat**
(聊天), **Files** (文件), **Settings** (设置).

- **Add files:** Files tab → drop files/folders, or **Browse files** (浏览文件) / **Browse folder**
  (浏览文件夹), then **Learn N new file(s)** (学习 N 个新文件). Adding files needs the desktop app.
- **Watched folders:** Settings tab → **Add folder** (添加文件夹). While **Keep learning**
  (继续学习) is on, new and changed files in the folder are learned automatically.
- **Re-index documents** (重建文档索引) re-extracts every source; use it after sources changed.
- **Delete knowledge base** (删除知识库) removes Halo's copies and extracted text only; the user's
  original files, including watched folders, are untouched.

## 4. Which conversations use which knowledge base

- **New conversations** are seeded at creation with the knowledge bases connected to their space
  plus the global **Default knowledge base** (默认知识库) (`getSeedKBIds`). The seed is a snapshot:
  connecting a base to a space later affects new conversations, not existing ones.
- **The current conversation:** the **Knowledge** (知识) button in the composer toolbar loads or
  unloads bases for this conversation; its menu also offers "Always enable in this workspace
  (applies to new conversations)" (在此工作区中始终启用（适用于新对话）).
- **Digital humans** use the bases checked in their own settings (Knowledge section); at install
  they are seeded with their space's bases plus the default one (`seedAppKnowledgeBases`).
- **Direct Q&A:** the Chat tab's **Ask this knowledge base** (向这个知识库提问) answers from that
  one base only.
- **Paused bases are not used.** Turning **Keep learning** off sets the base to Paused (已暂停),
  and a paused base is skipped by conversations and digital humans (`getKBReferenceById` and
  `getKBReferencesForApp` require an active base), even though the toggle's description only
  mentions learning. Direct Q&A on the Chat tab still works.
- **Citations:** the **Sources** (来源) chips under a reply list the knowledge-base files the agent
  read; clicking one opens it in the canvas.

## 5. Watched-folder limits

- At most **500** accepted files per watched folder (`MAX_LINKED_DIR_FILES`). A folder over the
  cap cannot be added, and a watched folder that grows past it is ignored until it drops back.
- A single scan visits at most 20,000 directory entries; dependency and build directories are
  pruned.
- A whole drive (`/`, `C:\`) cannot be watched.
- A folder that cannot be watched is labelled **Unavailable** (不可用) in Settings.

## 6. The AI managing knowledge bases (Halo 3.0)

From 3.0, with the **Operate Halo** (操作 Halo) toolset on, the AI can create and list knowledge
bases, connect them to spaces or digital humans, add files, set the default and start learning
through Halo's own API (`src/main/http/routes/tlon.routes.meta.ts`). In 2.1.x there is no such
tool — guide the user through the UI instead.

## 7. Do not ask / do not assume

- **Do not promise semantic or vector search**, and do not suggest tuning embeddings or chunk
  sizes — no such settings exist.
- **Do not suggest adding a code repository** to a knowledge base; source files are rejected on
  purpose. For code, the agent should work in the space's working directory instead.
- **Do not claim scanned PDFs or charts are understood.** OCR recovers text only.
- **Do not assume a base is in use** just because it exists: check it is loaded in this
  conversation (Knowledge button) and not paused.
- **Do not assume a binding change reaches an open conversation** — use the Knowledge button there,
  or start a new conversation.
