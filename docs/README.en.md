<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### 7×24 Desktop AI Agent for Everyone


Command your computer around the clock, drive an AI browser to complete tasks autonomously, with a friendly visual interface and full file management.

Write code, create presentations, research, draft reports, deploy servers, organize your desktop, automate browsers — if an Agent can do it, Halo supports it. Open source and free.

> **Our Philosophy:** Wrap complex technology into intuitive human interaction.

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[Download](#installation) · [Documentation](#documentation) · [Contributing](#contributing)

**[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Deutsch](./README.de.md)** | **[Français](./README.fr.md)** | **[日本語](./README.ja.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## Why Halo?

Halo is powered by Claude Code and carries the same Agent capability.

The difference: Halo brings that capability out of the terminal — giving it a visual home, an always-ready interface, and a Digital Human system that can run autonomously in the background 7×24.

No command line knowledge required. No environment setup. No staring at a screen waiting. Download, install, run — then tell it what you want done.

---

## Features

<table>
<tr>
<td width="50%">

### Real Agent Loop
Not just chat. Halo can **actually do things** — write code, create files, run commands, and iterate until the task is done.

### Space System
Isolated workspaces keep your projects organized. Each Space has its own files, conversations, and context.

### Beautiful Artifact Rail
See every file AI creates in real-time. Preview code, HTML, images — all without leaving the app.

</td>
<td width="50%">

### Remote Access
Control your desktop Halo from your phone or any browser. Work from anywhere — even from a hospital bed (true story).

### AI Browser
Let AI control a real embedded browser. Web scraping, form filling, testing — all automated.

### AI Digital Human System
Create and manage autonomous AI agents (Digital Humans) that run on a schedule or in response to events — monitoring, reporting, notifying, all in the background.

</td>
</tr>
</table>

### And More...

- **Skills** — Install skill packs for your Agent to extend what it can do
- **Multi-provider Support** — Anthropic, OpenAI, DeepSeek, and any OpenAI-compatible API
- **Real-time Thinking** — Watch AI's thought process as it works
- **Dark/Light Themes** — System-aware theming
- **i18n Ready** — English, Chinese, Spanish (more coming)

---

## Digital Humans

Digital Humans are autonomous AI agents that work for you in the background — monitoring, summarizing, notifying, and acting — so you don't have to.

Browse and install them directly from the **Halo Digital Human Store**, no setup required.

> Think of them like apps on your phone, except they work *for* you automatically.

### For Users — Install in seconds

Open the Store in Halo, pick a Digital Human, configure a few fields, and it starts running. No code, no prompts, no manual effort.

Examples of what Digital Humans can do for you:

- Monitor prices and alert you when a deal drops
- Deliver a daily news or market digest every morning
- Watch your inbox and summarize what matters
- Track social mentions of your brand or product
- Run reports on a schedule and send them to your team

### For Developers — Build and publish

Want to contribute a Digital Human to the ecosystem? Write a `spec.yaml` and submit a PR to the [Digital Human Protocol (DHP)](https://github.com/openkursar/digital-human-protocol) registry — the open-source store and protocol behind Halo's Digital Humans.

Your agent becomes available to all Halo users instantly after merge.

*AI Store: Browse and install Digital Humans in seconds*

![AI Store](./assets/shop.png)

*AI Digital Human: Autonomous agents running in the background*

![AI Digital Human](./assets/ai-digital-human.png)

---

## Screenshots

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*Remote Access: Control Halo from anywhere*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="Mobile Remote Access">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="Mobile Chat">
</p>

AI Browser Video Demo

https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003

---

## Advanced Features Demo

[![中文](https://img.shields.io/badge/点击播放-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)
[![English](https://img.shields.io/badge/Watch_Video-FB7299?style=for-the-badge&logo=bilibili&logoColor=white)](https://www.bilibili.com/video/BV1jEZYBaEcy/)

---

## Installation

### Download (Recommended)

| Platform | Download | Requirements |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [Download .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| **macOS** (Intel) | [Download .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| **Windows** | [Download .exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [Download .AppImage](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 22.04+ |
| **Web** (PC/Mobile) | Enable Remote Access in desktop app | Any modern browser |

**That's it.** Download, install, run. No Node.js. No npm. No terminal commands.

### Build from Source

For developers who want to contribute or customize:

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare        # Download binary dependencies for your platform
npm run dev
```

> To build for all platforms, run `npm run prepare:all` first to download binaries for every target platform.

---

## Quick Start

1. **Launch Halo** and enter your API key (Anthropic recommended)
2. **Start chatting** — try "Create a simple todo app with React"
3. **Watch the magic** — see files appear in the Artifact Rail
4. **Preview & iterate** — click any file to preview, ask for changes

> **Pro tip:** For best results, use Claude Sonnet 4.5 or Opus 4.5 models.

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                          Halo Desktop                           │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    Main     │◄──►│  Claude Code SDK  │   │
│  │  (Renderer) │IPC │   Process   │    │   (Agent Loop)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │  Local Files  │                           │
│                    │  ~/.halo/     │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% Local** — Your data never leaves your machine (except API calls)
- **No Backend Required** — Pure desktop client, use your own API keys
- **Real Agent Loop** — Tool execution, not just text generation

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — Thanks to Anthropic for building the most capable AI agent.

---

## What People Are Building

Halo isn't just for developers. We've seen:

- **Finance teams** building full-stack apps from scratch — with zero coding experience
- **Content creators** researching, writing, and organizing with AI in one flow
- **Operations teams** using Digital Humans to generate daily reports, monitor competitors, and summarize trends
- **Designers** prototyping interactive mockups
- **Students** learning to code with AI as their pair programmer
- **Developers** using the AI Browser for automated testing, scraping, and server deployment

The barrier isn't AI capability anymore. **It's accessibility.** Halo removes that barrier.

---

## Roadmap

- [x] Core Agent Loop with Claude Code SDK
- [x] Space & Conversation management
- [x] Artifact preview (Code, HTML, Images, Markdown)
- [x] Remote Access (browser control)
- [x] AI Browser (CDP-based)
- [x] MCP Server support
- [x] Skills system
- [x] Digital Humans & Digital Human Store
- [x] AI Plugin App Store
- [ ] Third-party ecosystem plugin compatibility
- [ ] Enhanced code editing experience (reduce reliance on external editors like VS Code)
- [ ] Visual Git with AI-assisted review
- [ ] AI-powered file search

---

## Contributing

Halo is open source because AI should be accessible to everyone.

We welcome contributions of all kinds:

- **Translations** — Help us reach more users (see `src/renderer/i18n/`)
- **Bug reports** — Found something broken? Let us know
- **Feature ideas** — What would make Halo better for you?
- **Code contributions** — PRs welcome!

```bash
# Development setup
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare        # Download binary dependencies for your platform
npm run dev
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

---

## Community

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions) — Questions & ideas
- [Issues](https://github.com/openkursar/hello-halo/issues) — Bug reports & feature requests

---

## License

MIT License — see [LICENSE](../LICENSE) for details.

---

## Inspired by Halo?

If this project sparked an idea or helped you build something cool:

- **Give us a star** — it helps others find Halo
- **Share your story** — we love hearing what you built
- **Link back to us** — e.g. `Inspired by [Halo](https://github.com/openkursar/hello-halo)`

---

## The Story Behind Halo

In October 2025, it started with a simple frustration: **I wanted to use Claude Code, but I was stuck in meetings all day.**

During boring meetings (we've all been there), I thought: *What if I could control Claude Code on my home computer from my phone?*

Then came another problem — my non-technical colleagues wanted to try Claude Code after seeing what it could do. But they got stuck at installation. *"What's npm? How do I install Node.js?"* Some spent days trying to figure it out.

So I built Halo for myself and my friends:
- **Visual interface** — no more staring at terminal output
- **One-click install** — no Node.js, no npm, just download and run
- **Remote access** — control from phone, tablet, or any browser

The first version took a few hours. Everything after that? **100% built by Halo itself.** Since then, we've been using it 7×24.

AI building AI. Now in everyone's hands.

---

## Contributors

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### Built by AI, for humans.

If Halo helps you build something amazing, we'd love to hear about it.

**Star this repo** to help others discover Halo.

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-halo&type=Date)](https://star-history.com/#openkursar/hello-halo&Date)

[⬆ Back to Top](#halo)

</div>
