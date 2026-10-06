# Security Policy

[English](#english) | [中文](#中文)

## English

### Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/openkursar/hello-halo/security) of this repository.
2. Click **Report a vulnerability**, or go straight to
   [the private report form](https://github.com/openkursar/hello-halo/security/advisories/new).

Only the maintainers can see the report. We discuss it with you in the report thread and keep
the details private until a fix is available.

### What to include

- The Halo version and your operating system
- Which part is affected (for example the desktop app, remote access and its HTTP API, a digital
  human, or an IM channel)
- Steps to reproduce, and what an attacker could achieve
- A proof of concept, if you have one
- Any fix or mitigation you would suggest (optional)

### Scope

This policy covers Halo itself: the desktop app, its remote-access web interface and HTTP API,
and the code in this repository. Problems in a third-party model provider's or messaging
platform's own service should be reported to that provider.

### Supported versions

Security fixes are made on the latest release line. Please check whether the problem still
occurs on the latest version before reporting.

## 中文

### 报告安全漏洞

**请不要在公开的 Issue、讨论区或 Pull Request 中报告安全漏洞。**

请通过 GitHub 的私密漏洞报告提交：

1. 打开本仓库的 [Security 页面](https://github.com/openkursar/hello-halo/security)。
2. 点击 **Report a vulnerability**，或直接打开
   [私密报告表单](https://github.com/openkursar/hello-halo/security/advisories/new)。

报告只有维护者能看到。我们会在报告页面里与你沟通，在修复发布之前不公开细节。

### 报告里请包含

- Halo 版本和操作系统
- 受影响的部分（例如桌面应用、远程访问及其 HTTP 接口、数字人、IM 渠道）
- 复现步骤，以及攻击者可以借此做到什么
- 概念验证（如果有）
- 建议的修复或缓解办法（可选）

### 范围

本政策适用于 Halo 本身：桌面应用、远程访问网页与 HTTP 接口，以及本仓库中的代码。第三方模型服务商或消息平台自身服务的问题，请向对应服务商报告。

### 支持的版本

安全修复在最新的发布版本线上进行。报告前请先确认问题在最新版本上仍然存在。
