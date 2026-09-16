<div align="center">

<img src="./resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### Your AI Workstation — For Teams and Individuals

Deploy locally. Automate everything, around the clock. AI Digital Humans work while you make the calls.

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[**Download**](#installation) · [**Documentation**](#documentation) · [**Contributing**](#contributing)

**[简体中文](./docs/README.zh-CN.md)** | **[繁體中文](./docs/README.zh-TW.md)** | **[Español](./docs/README.es.md)** | **[Deutsch](./docs/README.de.md)** | **[Français](./docs/README.fr.md)** | **[日本語](./docs/README.ja.md)**

</div>
<!-- TODO: Replace with a 30-second GIF showing: user types a sentence -> Agent automatically writes code -> files appear in Artifact Rail -> preview the result -->
<div align="center">

![AI Digital Human Store](./docs/assets/shop_dh.png)

</div>

---

## Why Halo?

Halo is an AI workstation powered by frontier Agent with a pluggable engine architecture — supporting [Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), and more. With a complete product layer totaling over 300,000 lines of code, validated by tens of thousands of users, and running stably in enterprise environments, Halo delivers:

| What Halo delivers |
|:---:|
| **Your Daily AI Partner** — coding, product design, operations, writing, research — your everyday work companion |
| **100% Local, Zero Cloud Dependency** — data never leaves your machine, meets enterprise compliance requirements |
| **AI Digital Humans** — AI workers running autonomously 7x24, handling monitoring, reports, and routine operations |
| **AI Browser** — embedded browser directly controlled by AI, automate any web-based system |
| **Knowledge Base** — drop in your files, AI references them automatically when answering or working |
| **AI Terminal** — built-in terminal the AI can operate directly, SSH, bastion hosts, any CLI tool |
| **AI Operates Halo Itself** — hundreds of features, driven by natural language, loaded on demand with zero idle context cost |
| **WeCom / WeChat Native Control** — manage AI agents from enterprise IM, zero training cost |
| **Remote Access** — control from phone / H5 / WeChat / Android, managers review progress on the go |
| **Download and Go** — zero configuration, no backend required, IT deploys in minutes |

> 100% compatible with Claude Code's Agent capabilities, MCP, and Skills.

---

## AI Digital Humans — Your Autonomous AI Workforce

Give it a goal and a schedule, and an AI Digital Human runs like an employee — not a bot executing a fixed script, but a digital coworker with memory, judgment, and hands.

**Fully equipped:** Digital Humans share the exact same Agent capabilities as conversation mode — AI Browser for the web, AI Terminal for the OS and CLI tools, WeCom/WeChat for messaging, even operating Halo itself to change settings. Not a one-trick browser bot.

**Long-term memory:** Every run doesn't start from zero — a Digital Human remembers where it left off, what it's seen, what it concluded — compounding over time instead of repeating the same work.

### Autonomous Agents Running 7x24

Create an AI Digital Human, give it a task and an execution frequency, and it runs autonomously on schedule. No screen to watch, no scripts to babysit.

**Social & Content Platform Automation:**

- Auto-reply to comments and DMs on Xiaohongshu, Bilibili, Zhihu
- Publish scheduled content across Twitter / X, WeChat Official Accounts
- Monitor brand mentions and competitor activity, generate daily digests
- Track trending topics and automatically draft content suggestions

**Enterprise Internal Automation:**

- Patrol internal OA / CRM / ERP systems, flag overdue tickets and anomalies
- Generate daily standup reports from Jira / GitLab / GitHub activity
- Monitor CI/CD pipelines, notify on build failures, auto-create incident tickets
- Run scheduled compliance checks on internal dashboards
- Collect cross-department data and assemble weekly executive summaries

Install with one click from the **AI Digital Human Store**, deploy a **private store** for your organization, or create your own using natural language.

> Think of it as cron + RPA + AI Agent in one — except you just describe what you want in plain language.

**WeChat / WeCom is your control panel.** AI Digital Humans support two-way conversational control via personal WeChat / WeCom (Enterprise WeChat) — not just receiving notifications, you can give instructions, check progress, and request reports directly in your enterprise IM.

![AI Digital Human](./docs/assets/ai-digital-human.png)

*See it in action — Digital Humans operating Zhihu, Bilibili, Xiaohongshu & X 7x24 (ready-made Browser Actions available in the store):*

[![中文 点击播放](https://img.shields.io/badge/▶_点击播放-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1yfNuzaEtv/) &nbsp; [![Watch the Video](https://img.shields.io/badge/▶_Watch_the_Video-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1yfNuzaEtv/)

### Halo Browser Action — AI Decides, Scripts Execute

Traditional RPA follows a fixed script and breaks the moment something changes; Halo flips that: **AI makes the decision, Browser Action executes it precisely.**

A Browser Action is a special kind of Skill: a reusable `.js` script for one concrete operation on one platform. The AI only decides *what* to do and *when* — the script already knows *how*. This is what separates Halo from "AI browser agents" that fumble around clicking randomly.

Scripts run directly in a real browser, with full access to the page DOM, cookies, and internal APIs. Works for public platforms and private enterprise systems alike.

Ready-made Browser Actions are available for Xiaohongshu, Bilibili, Zhihu, Twitter / X, WeChat, and more. Enterprise teams can write private Actions for internal systems, and the community can contribute and share their own. **AI decides. Actions execute. Stable, repeatable, auditable.**

Want to build one yourself? A full walkthrough — building an **OA Approval Assistant** that patrols a login-required internal system on a schedule — is in the docs: [**Build a Browser Action Digital Human →**](https://hello-halo.cc/docs/digital-humans/guide-02-build.html)

### Remote Access — Manage Your AI Fleet From Anywhere

Once Remote Access is enabled, your phone / H5 / WeChat / Android client can control Halo on your desktop. During meetings, commuting, or on the road — check Digital Human outputs, approve decisions, and issue new instructions without being at your desk.

---

## Knowledge Base

Drop in your everyday files, and AI references them automatically when answering questions or getting work done.

Supports PDF, PPT, Markdown and other common office files, plus image OCR. Create a knowledge base, bind it to a space, then just ask AI "what's in my knowledge base" to use it.

---

## AI Terminal

Halo has a built-in terminal the AI can operate directly — SSH, bastion hosts, ping+token logins, or driving native CLI tools like Claude Code / Codex.

The terminal is persistent and visible: close it yourself when done, or open it anytime to take over manually — human and AI can hand off control without conflict.

---

## AI Operates Halo Itself

Hundreds of operations — settings, session management, WeCom bot configuration — done directly through natural language, no digging through menus.

These operations cost zero context by default: only the one you ask about gets loaded on demand, so hundreds of capabilities never slow down the conversation.

---

## Quick Start

**Get started in 30 seconds:**

1. [Download and install](#installation), launch Halo
2. Enter your API Key (Anthropic recommended)
3. Start chatting — try `Build a todo app with React` or `Help me analyze the code structure of this project`
4. Watch files appear in the Artifact Rail, click to preview, request changes

> Recommended models: Claude Sonnet / Opus series

---

## Installation

### Download (Recommended)

| Platform | Download | Requirements |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **Windows** | [.exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [.AppImage](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 20.04+ |
| **Android** | [.apk](https://github.com/openkursar/hello-halo/releases/latest) | Android 8+ |
| **iOS** | Build from source | iOS 15+ |

**Download, install, run.** No Node.js, no npm, no terminal needed. IT can distribute across the organization with zero server-side dependencies.

### Build from Source

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare
npm run dev
```

---

## AI Digital Human Store

<table>
<tr>
<td width="50%" valign="top">

### For Users — Install and Use Instantly

Open the AI Digital Human Store, pick one, fill in a few configuration fields, and it starts running automatically. No coding required, no prompts to write.

![Digital Human Install](./docs/assets/app_detail_install.png)

</td>
<td width="50%" valign="top">

### For Developers — Build and Publish

Write a `spec.yaml` and submit a PR to the [AI Digital Human Protocol (DHP)](https://github.com/openkursar/digital-human-protocol). Once merged, it becomes immediately available to all Halo users.

You can also write Halo Browser Actions (`.js` scripts) for AI Digital Humans to precisely execute operations on specific platforms.

</td>
</tr>
</table>

---

## Screenshots

![Chat Intro](./docs/assets/chat_intro.jpg)

![Chat Todo](./docs/assets/chat_todo.jpg)

*Skill Store: one-click install for content generation, dev tools, data analysis, and more*

![Skill Store](./docs/assets/shop_skill.png)

*Remote Access: Control Halo from anywhere*

![Remote Settings](./docs/assets/remote_setting.jpg)

<p align="center">
  <img src="./docs/assets/mobile_remote_access.jpg" width="45%" alt="Mobile Remote Access">
  &nbsp;&nbsp;
  <img src="./docs/assets/mobile_chat.jpg" width="45%" alt="Mobile Chat">
</p>

*AI Browser*

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

*Product Walkthrough*

[![中文 点击播放](https://img.shields.io/badge/▶_点击播放-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/) &nbsp; [![Watch the Demo](https://img.shields.io/badge/▶_Watch_the_Demo-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)

---

## Architecture

Pluggable engine: the same product experience, with Claude Code, Codex, and other Agent engines swappable underneath.

---

## More Features

- **100% Local** — Your data never leaves your machine, meets enterprise compliance requirements
- **No Backend Required** — Pure desktop client, deploy to every workstation with zero server infrastructure
- **Agent Loop** — Not just generating text, AI actually executes tools to get things done
- **Space System** — Isolated workspaces, projects don't interfere with each other
- **Skills** — Install skill packs to extend Agent capabilities
- **AI Browser** — Embedded CDP browser, AI directly controls web pages
- **Digital Human Capability Management** — Visually manage each Digital Human's MCP and Skill permissions
- **Window Zoom** — 50%-150% freely, adapts to any screen or presentation
- **Multi-Model Support** — Anthropic, OpenAI, DeepSeek, and any OpenAI-compatible API (connect to your enterprise LLM gateway)
- **Dark/Light Themes** — Follows system preference
- **Multi-Language** — Chinese, English, Spanish, and more

[**Explore all features →**](https://hello-halo.cc/docs/features/spaces.html)

---

## Roadmap

- [x] Agent Loop — tool execution, not just text generation
- [x] Space and Conversation Management
- [x] Artifact Preview (Code, HTML, Images, Markdown)
- [x] Remote Access
- [x] AI Browser (CDP)
- [x] MCP Server Support
- [x] Skills System
- [x] AI Digital Humans and AI Digital Human Store
- [ ] Third-party Ecosystem Plugin Compatibility
- [ ] Enhanced Code Editing Experience
- [ ] Visual Git + AI-Assisted Code Review
- [ ] AI-Powered File Search
- [ ] Low-Cost Digital Human Recording — auto-record and replay AI workflows as reusable Digital Humans

---

## Contributing

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare
npm run dev
```

- **Translations** — `src/renderer/i18n/`
- **Bug Reports** — [Issues](https://github.com/openkursar/hello-halo/issues)
- **Feature Suggestions** — [Discussions](https://github.com/openkursar/hello-halo/discussions)
- **Code Contributions** — PRs welcome

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## Community

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions)
- [GitHub Issues](https://github.com/openkursar/hello-halo/issues)

<p align="center">
  <img src="https://github.com/user-attachments/assets/500aa749-50d9-4587-986d-338b1ed899f1" width="200" alt="Personal WeChat QR Code">
</p>
<p align="center">
  <em>For any feedback or discussion, add WeChat: go2halo with the note "Halo"</em>
</p>

---

## The Story of Halo

In October 2025, a simple frustration: **I wanted to use Claude Code, but I was stuck in meetings all day.**

During a boring meeting, I thought: *What if I could control Claude Code on my home computer from my phone?*

Then came the second problem — non-technical colleagues wanted to use it too, but got stuck at installation. *"What's npm?"*

So I built Halo: a visual interface, one-click install, remote access. The first version took a few hours. Everything after that? **100% built by Halo itself.**

Now, we believe the next step is the **AI Workstation**: AI no longer needs someone watching to get work done. You set the goals, AI Digital Humans push forward autonomously 7x24. Writing code, running tests, monitoring deployments, generating reports — running continuously, with you only making decisions at key checkpoints.

That's what Halo is building.

---

## License

MIT — [LICENSE](LICENSE)

---

<div align="center">

## Contributors

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

**Star this repo** to help more people discover Halo.

</div>

---

## Partners & Sponsors

If Halo inspired your project or you built something on top of it, a mention would mean a lot.

### Enterprise Partners

<!-- Add your company logo here — submit a PR or contact us at the link below -->

| Your company uses Halo? | [Let us know](https://github.com/openkursar/hello-halo/issues/new?title=Add+our+company+as+partner) — we'd love to feature you here. |
|:---:|:---:|

### Sponsors

<a href="https://www.nnscholar.com/">
  <img src="https://www.nnscholar.com/favicon.ico" height="40" alt="NNScholar">
</a>

<p align="center">
  <a href="https://buy.polar.sh/polar_cl_x7bTGvMvt3rbUt6oE98z0zb2zFz1sT7dG37BA3foNsZ">Polar (International)</a> · <a href="https://ifdian.net/a/hello-halo">爱发电 (Alipay / WeChat)</a>
</p>

---

<div align="center">

[Back to Top](#halo)

</div>
