<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### Open Source Cowork for Everyone


无需接触终端，即可体验 AI Agent 的全部能力。Halo 为所有人带来可视化、跨平台的桌面体验 — 开源且免费。

> **我们的理念：** 将复杂技术封装成符合直觉的人类交互。

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#安装)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[下载](#安装) · [文档](#文档) · [参与贡献](#参与贡献)

**[English](../README.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Deutsch](./README.de.md)** | **[Français](./README.fr.md)** | **[日本語](./README.ja.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## 为什么选择 Halo？

**Claude Code 是目前最强大的 AI 编程助手。** 但有一个问题：

> **它被困在终端里。**

对于熟悉命令行的开发者来说，这没什么。但对于设计师、产品经理、学生，以及所有希望 AI *帮忙做事* 的人来说，终端是一道门槛。

**Halo 是首个打破这道门槛的。**

我们把 Claude Code 100% 的 Agent 能力，包装进一个人人都能用的可视化界面。同样的能力，零摩擦。

| | Claude Code CLI | Halo |
|---|:---:|:---:|
| 完整 Agent 能力 | ✅ | ✅ |
| 可视化界面 | ❌ | ✅ |
| 一键安装 | ❌ | ✅ |
| 任意设备远程访问 | ❌ | ✅ |
| 文件预览与管理 | ❌ | ✅ |
| 内置 AI 浏览器 | ❌ | ✅ |

> 可以这样理解：
> **Windows** 把 DOS 变成了可视化桌面。
> **Halo** 把 Claude Code CLI 变成了可视化 AI 伙伴。

---

## 功能特性

<table>
<tr>
<td width="50%">

### 真正的 Agent 循环
不只是聊天。Halo 能**真正做事** — 写代码、创建文件、执行命令，持续迭代直到任务完成。

### 空间系统
隔离的工作空间让你的项目井井有条。每个空间都有独立的文件、对话和上下文。

### 优雅的产物栏
实时查看 AI 创建的每个文件。预览代码、HTML、图片 — 无需离开应用。

</td>
<td width="50%">

### 远程访问
从手机或任何浏览器控制你的桌面 Halo。随时随地工作 — 甚至在医院病床上（真实故事）。

### AI 浏览器
让 AI 控制真实的内嵌浏览器。网页抓取、表单填写、测试 — 全部自动化。

### MCP 支持
通过 Model Context Protocol 扩展能力。兼容 Claude Desktop MCP 服务器。

</td>
</tr>
</table>

### 更多特性...

- **多供应商支持** — Anthropic、OpenAI、DeepSeek，以及任何 OpenAI 兼容 API
- **实时思考过程** — 观看 AI 的思考过程
- **工具权限控制** — 批准或自动允许文件/命令操作
- **深色/浅色主题** — 跟随系统主题
- **多语言支持** — 英文、中文、西班牙语等
- **自动更新** — 一键保持最新

---

## 截图

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*远程访问：从任何地方控制 Halo*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="移动端远程访问">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="移动端聊天">
</p>

---

## 安装

### 下载（推荐）

| 平台 | 下载 | 要求 |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [下载 .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [下载 .dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **Windows** | [下载 .exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [下载 .AppImage](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/移动端) | 在桌面应用中启用远程访问 | 任何现代浏览器 |

**就这么简单。** 下载、安装、运行。不需要 Node.js，不需要 npm，不需要终端命令。

### 从源码构建

想要贡献或自定义的开发者：

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare        # 下载当前平台的二进制依赖
npm run dev
```

> 打包所有平台的安装包前，请先运行 `npm run prepare:all` 下载全部平台的二进制依赖。

---

## 快速开始

1. **启动 Halo** 并输入你的 API 密钥（推荐 Anthropic）
2. **开始聊天** — 试试 "用 React 创建一个简单的待办事项应用"
3. **见证魔法** — 看着文件在产物栏中出现
4. **预览和迭代** — 点击任何文件预览，要求修改

> **小技巧:** 为获得最佳效果，使用 Claude Sonnet 4.5 或 Opus 4.5 模型。

---

## 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│                          Halo 桌面端                             │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│    主进程    │◄──►│  Claude Code SDK  │   │
│  │  (渲染进程)  │IPC │   (Main)    │    │   (Agent 循环)    │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │   本地文件     │                           │
│                    │   ~/.halo/    │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% 本地** — 你的数据永远不会离开你的电脑（除了 API 调用）
- **无需后端** — 纯桌面客户端，使用你自己的 API 密钥
- **真正的 Agent 循环** — 工具执行，而不只是文本生成

> **由 [Claude Code](https://github.com/anthropics/claude-code) 驱动** — 感谢 Anthropic 构建了最强大的 AI Agent。

---

## 用户在用 Halo 做什么

Halo 不只是给开发者用的。我们看到：

- **金融团队** 从零开始构建全栈应用 — 完全没有编程经验
- **设计师** 制作交互原型
- **学生** 以 AI 作为编程伙伴学习编程
- **开发者** 以前所未有的速度交付功能

障碍不再是 AI 的能力，**而是可及性**。Halo 消除了这个障碍。

---

## 路线图

- [x] 基于 Claude Code SDK 的核心 Agent 循环
- [x] 空间与对话管理
- [x] 产物预览（代码、HTML、图片、Markdown）
- [x] 远程访问（浏览器控制）
- [x] AI 浏览器（基于 CDP）
- [x] MCP 服务器支持
- [ ] 插件系统
- [ ] Git 可视化与 AI 辅助代码审查
- [ ] AI 智能文件搜索

---

## 参与贡献

Halo 开源是因为 AI 应该人人可及。

我们欢迎各种贡献：

- **翻译** — 帮助我们触达更多用户（见 `src/renderer/i18n/`）
- **Bug 报告** — 发现问题？告诉我们
- **功能建议** — 什么能让 Halo 更好用？
- **代码贡献** — 欢迎 PR！

```bash
# 开发环境设置
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare        # 下载当前平台的二进制依赖
npm run dev
```

查看 [CONTRIBUTING.md](../CONTRIBUTING.md) 了解详细指南。

---

## 社区

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions) — 问题与想法
- [Issues](https://github.com/openkursar/hello-halo/issues) — Bug 报告与功能请求

<p align="center">
  <img src="https://github.com/user-attachments/assets/915427da-1b61-4b91-a7a0-30e47f897eee" width="200" alt="微信群二维码">
</p>

<p align="center">
  <em>如二维码过期，可加微信：helloddbb<strong>_</strong>（注意末尾有下划线，昵称"混沌数字"），备注"Halo"，将邀请入群</em>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/500aa749-50d9-4587-986d-338b1ed899f1" width="200" alt="个人微信二维码">
</p>

---

## 许可证

MIT 许可证 — 详见 [LICENSE](../LICENSE)。

---

## 受到 Halo 的启发？

如果本项目给了你灵感，或帮你构建了很酷的东西：

- **给我们一个 Star** — 帮助更多人发现 Halo
- **分享你的故事** — 我们很想知道你做了什么
- **提及我们** — 例如 `Inspired by [Halo](https://github.com/openkursar/hello-halo)`

---

## Halo 背后的故事

几个月前，一切始于一个简单的困扰：**我想用 Claude Code，但整天都在开会。**

在无聊的会议中（我们都经历过），我想：*如果我能从手机控制家里电脑上的 Claude Code 呢？*

然后又遇到另一个问题 — 我的非技术同事看到 Claude Code 能做什么后也想试试。但他们卡在了安装环节。*"什么是 npm？怎么安装 Node.js？"* 有些人花了好几天也没搞定。

所以我为自己和朋友做了 Halo：
- **可视化界面** — 不用再盯着终端输出
- **一键安装** — 不需要 Node.js，不需要 npm，下载即用
- **远程访问** — 从手机、平板或任何浏览器控制

第一版只用了几个小时。之后的所有功能？**100% 由 Halo 自己构建。** 我们已经日常使用好几个月了。

AI 构建 AI。现在人人可用。

---

## 贡献者

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

由我们的贡献者用 ❤️ 打造。

<div align="center">

### 由 AI 构建，为人类服务。

如果 Halo 帮你创造了精彩的东西，我们很想听听。

**Star 这个仓库** 帮助更多人发现 Halo。

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-halo&type=Date)](https://star-history.com/#openkursar/hello-halo&Date)

[⬆ 返回顶部](#halo)

</div>
