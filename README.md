<div align="center">

<img src="./resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo AI Workstation

**Open-source desktop AI workstation · Digital Human teams · Hand off work from anywhere**

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#installation)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[**Download**](#installation) · [**Website & Docs**](https://hello-halo.cc/) · [**Contributing**](#contributing)

**[简体中文](./docs/README.zh-CN.md)** | **[繁體中文](./docs/README.zh-TW.md)** | **[Español](./docs/README.es.md)** | **[Deutsch](./docs/README.de.md)** | **[Français](./docs/README.fr.md)** | **[日本語](./docs/README.ja.md)**

</div>

---

Halo is an open-source desktop AI workstation. Day to day it works like the desktop AI workbenches you already know: chat, write code, make documents, research. Beyond that, you get **Digital Humans** — AI members that stay on duty — and you can put them in teams that split the work. When you are away from your computer, hand off and follow up from your phone, Feishu, WeChat or WeCom.

<p align="center">
  <img src="./docs/assets/cards/team-poster.jpg" width="440" alt="Digital Human team: your Lead coordinates the team while colleagues' Digital Humans work on their own computers and exchange messages, tasks and results through the team">
</p>

## Why Halo

Everyone uses AI now, and each person's own output has gone up. But the hand-offs between pieces of work still run through people: copy one AI's conclusion into another AI, send the files and findings to a colleague, and the colleague explains it all again to their own AI. People have become the bottleneck — individuals got faster, but the team did not.

Halo lets AIs divide the work, hand it over, build up memory and stay on duty by themselves; people set the direction and make the calls. Personal productivity adds up; collaboration multiplies.

- **Who it's for**: heavy AI users, developers, researchers and operators, and small teams bringing AI into their daily workflow.
- **Three things**: [Your everyday AI workbench](#1-your-everyday-ai-workbench) · [Digital Humans and Digital Human teams](#2-digital-humans-and-digital-human-teams) · [Hand off work from anywhere](#3-hand-off-work-from-anywhere)
- **Written by Halo**: a large AI workstation that keeps improving itself with AI — over 500,000 lines of code, running stably in enterprise financial environments.

---

## 1. Your everyday AI workbench

- **Chat + canvas**: reports, code, web pages, terminals, Word / Excel / PDF open right beside the conversation; select a passage and add a note, and the AI knows exactly what you mean.
- **Capabilities on demand**: the "+" in the input box turns on web control, team collaboration, the AI terminal, OCR and operating Halo; attach local files and folders directly, nothing is uploaded.
- **Coding**: choose Claude Code, Codex, Halo SDK and other engines; see exactly what the AI changed in the changes view, then start a quick review or a multi-role team review with one click.
- **AI browser and terminal**: the AI drives a real browser and terminal while you watch, and you can take over or stop it at any time.
- **Office documents**: built-in document skills and runtime create and edit Word, Excel, PowerPoint and PDF files without installing a pile of dependencies first.
- **Knowledge base and memory**: files, folders, PDFs and Office documents in a knowledge base are cited with sources while you chat; chats in the same space share memory, organized into current state, history and topics, so a new chat does not start from scratch.
- **Connected conversations, AI that operates Halo**: open a new chat and ask "how are the other conversations going?" — it checks each one and sums them up; the AI can also manage spaces, Digital Humans and settings for you.
- **Bring your tools**: connect MCP servers and Skills in one click, compatible with the Claude Code MCP and Skills ecosystem.
- **Multiple models, multiple accounts**: any Anthropic / OpenAI-compatible API, or sign in to several ChatGPT, Claude and GitHub Copilot accounts at once; switch model and thinking effort per conversation.

<p align="center">
  <img src="./docs/assets/composer-capabilities.png" alt="The + menu in a chat turns on web control, team collaboration, the AI terminal and more"><br>
  <sub>Fig. 1　The "+" menu turns on web control, team collaboration, the AI terminal and more, only when needed</sub>
</p>

<p align="center">
  <img src="./docs/assets/task-plan.png" alt="The AI breaks a task into a plan, searches the web and works through it step by step"><br>
  <sub>Fig. 2　The AI breaks a task into a plan, searches the web and works through it step by step</sub>
</p>

<p align="center">
  <img src="./docs/assets/mcp-connections.png" alt="Connect MCP services such as WeCom to-dos and docs in one click"><br>
  <sub>Fig. 3　Connect the tools you use: WeCom to-dos, documents and other MCP services in one click</sub>
</p>

---

## 2. Digital Humans and Digital Human teams

One AI doing everything has limited attention; an AI that only knows you cannot help the whole team. Division of labor works for AI too.

| | One AI does it all | A Digital Human team |
|---|---|---|
| Division of work | Instructions and tools crammed together | Each Digital Human owns one step |
| When something fails | Hard to tell which step went wrong | The failing step is obvious |
| Hand-offs | People forward things and re-explain the background | Digital Humans ask and deliver to each other directly |
| Who it can reach | Only you | Your colleagues' Digital Humans too |

- **Digital Humans**: AI members that stay on duty. They run on a schedule or on events (optionally on mainland China working days only, holidays and make-up workdays included), take a reminder you mention in chat, install from the store in one click, or are created from one sentence.
- **Build a team in one sentence**: in any space, tell the AI "put together a team to research these three products", and research, fact-checking and writing are split up; to keep using it, say "keep this team", and you can even give the whole team a schedule.
- **Teams across computers**: colleagues join your team with their own Digital Humans, each running on its owner's computer. Data stays on each computer; only the results published to the team move through it, and each Digital Human's permissions are set by its owner. On the same LAN, turn on Remote Access to invite; across networks, configure a relay gateway in Settings.
- **See the work happen**: the team workspace shows tasks, progress, hand-offs between teammates and results. Digital Humans sort things out among themselves and only bring you what the team cannot decide.

> Try saying: "Research these products — gather sources separately, cross-check the conclusions, and put it all into one report."

<p align="center">
  <img src="./docs/assets/team-workspace.png" alt="Digital Human team: the lead assigns tasks, members deliver results and review each other"><br>
  <sub>Fig. 4　A Digital Human team: the lead assigns tasks, members deliver results and review each other</sub>
</p>

<p align="center">
  <img src="./docs/assets/daily-digest.png" alt="A daily news digest Digital Human runs at 08:00 every day and pushes results to WeCom"><br>
  <sub>Fig. 5　A daily news digest Digital Human: runs at 08:00 every day and pushes the result to WeCom</sub>
</p>

### Store, Browser Actions and ecosystem

- **Digital Human Store**: pick one, fill in a few settings, and it starts running — no prompts to write. Organizations can host a private store and add it in Settings.
- **Browser Action — AI decides, scripts execute**: write one concrete operation on one platform as a reusable `.js` script; the AI only decides what to do and when, and the script carries it out precisely. Ready-made Actions exist for Xiaohongshu, Bilibili, Zhihu, X and more, and you can write private Actions for internal systems. [Build one →](https://hello-halo.cc/docs/en/developers/digital-humans/build.html)
- **Publish your Digital Human**: write a `spec.yaml` and open a PR against the [Digital Human Protocol (DHP)](https://github.com/openkursar/digital-human-protocol); once merged, every Halo user can install it.

<p align="center">
  <img src="./docs/assets/shop_dh.png" alt="Digital Human Store: ready-made Digital Humans for social media, news digests, monitoring and more"><br>
  <sub>Fig. 6　Digital Human Store: social media, news digests, monitoring and more — install and go</sub>
</p>

---

## 3. Hand off work from anywhere

Work keeps moving when you are away from your computer.

- **Phone and remote web**: reach the Halo running on your home or office computer remotely — hand off tasks, upload material, download results.
- **IM**: Feishu, WeChat and WeCom. Hand work to a Digital Human from the chat window you already use; behind it can be a whole team.
- **Decide in IM**: results arrive in the chat; when something needs your call, reply once and the work moves on.

<p align="center">
  <img src="./docs/assets/mobile-remote.png" width="640" alt="Halo on a phone: left, the home screen; right, a result the computer finished"><br>
  <sub>Fig. 7　Halo on your phone: the full feature set in your pocket, one sentence to get your computer working</sub>
</p>

---

## Use cases

| Scenario | What you do | What you get |
|---|---|---|
| Competitor / market research | Build a team in one sentence: research, fact-check, write | Follow progress in the team workspace, receive a finished report |
| Daily briefing | A Digital Human compiles industry or engineering news on working days | Pushed to Feishu / WeCom before you start work |
| On the road | Say "revise this proposal" in WeChat on your phone | Open the result back at your computer, or download it on your phone |
| Coding | Review the AI's edits in the changes view, then start a team review | Know exactly what changed, commit with confidence |
| Office documents | Ask for a weekly report, a spreadsheet, a deck | Get real Word / Excel / PowerPoint files |
| Internal system patrol | A Digital Human logs in to OA, approval and ticket systems on a schedule | Overdue items and anomalies pushed to IM for you to handle |
| Social media operations | Install a ready-made Browser Action Digital Human from the store | Scheduled comment replies, posts and mention tracking |

**Watch**: [Product demo](https://www.bilibili.com/video/BV1jEZYBaEcy/) · [Digital Humans running 7x24](https://www.bilibili.com/video/BV1yfNuzaEtv/) · [AI browser](https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003)

---

## Quick start

1. [Download and install](#installation), then open Halo.
2. Sign in with a Claude or ChatGPT account, or enter an API key from any Anthropic / OpenAI-compatible provider.
3. Create a space: one project per space, so files and memory stay separate.
4. Hand off work in chat, or install Digital Humans from the store and build a team in one sentence.
5. When you need it, turn on Remote Access or connect Feishu / WeChat / WeCom and carry on from anywhere.

## Installation

| Platform | Download | Requirements |
|---|---|---|
| macOS (Apple silicon) | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| macOS (Intel) | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| Windows | [.exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ (x64) |
| Linux | [.AppImage](https://github.com/openkursar/hello-halo/releases/latest) | glibc 2.34+ (Ubuntu 22.04+, Debian 12+) |
| Android (remote client) | [.apk](https://github.com/openkursar/hello-halo/releases/latest) | Android 7.0+ |
| iOS (remote client) | Build from source | iOS 15+ |

Download, install, run — no Node.js, npm or command line, and no server to deploy, so IT can hand it straight out. Updates install themselves: on Windows, from 3.0 on, a new version is prepared in the background and a restart finishes it. The Linux build does not include the AI terminal yet.

### Build from source

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare
npm run dev
```

---

## Under the hood

- **Open source, runs on your own computer**: you control your files and working environment; Halo has no backend service of its own.
- **Pluggable agent engines**: Claude Code, Codex, our own Halo SDK (lighter, faster to start, tuned for open-weight models) and DeepSeek dsh — pick what fits.
- **Decentralized, distributed Digital Human teams**: members collaborate from different computers with no central server. Team state follows the Raft consensus approach — a majority elects the leading node, the log is replicated by term, and when the leader's computer goes offline a new one is elected automatically, never two at once, so the team keeps running. [How it works](https://hello-halo.cc/docs/en/advanced/team-consensus.html)
- **Details**: isolated spaces, light and dark themes, 50%–150% interface zoom, and an interface in 7 languages.

---

## Contributing

- **Translations**: `src/renderer/i18n/`
- **Bug reports**: [Issues](https://github.com/openkursar/hello-halo/issues)
- **Feature ideas**: [Discussions](https://github.com/openkursar/hello-halo/discussions)
- **Code**: PRs welcome — see [Build from source](#build-from-source)

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

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

## The story of Halo

October 2025, a simple frustration: **I wanted to use Claude Code, but I was stuck in meetings all day.**

During a boring meeting, I thought: *what if I could control Claude Code on my home computer from my phone?*

Then came the second problem — non-technical colleagues wanted to use it too, but got stuck at installation. *"What's npm?"*

So I built Halo: a visual interface, one-click install, remote access. The first version took a few hours. Everything after that? **Almost all of it built by Halo itself.** In early 2026, Halo went open source.

We believe the next step is the **AI workstation**: AI that no longer needs someone watching to get work done. You set the goals, Digital Humans push forward 7x24, and you only make the calls at key checkpoints. 3.0 puts Digital Humans into teams that work across computers — one step closer.

— [@openkursar-flynn](https://github.com/openkursar-flynn), creator of Halo

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

[Back to Top](#halo-ai-workstation)

</div>
