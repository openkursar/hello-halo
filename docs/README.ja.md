<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo

### Open Source Cowork for Everyone


ターミナルに触れることなく、AI Agent の全機能を体験できます。Halo は、ビジュアルでクロスプラットフォームなデスクトップ体験をすべての人に提供します—オープンソースで無料。

> **私たちの哲学：** 複雑な技術を直感的な人間のインタラクションにラップする。

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#インストール)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[ダウンロード](#インストール) · [ドキュメント](#ドキュメント) · [コントリビュート](#コントリビュート)

**[English](../README.md)** | **[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Deutsch](./README.de.md)** | **[Français](./README.fr.md)**

</div>

---

<div align="center">

![Space Home](./assets/space_home.jpg)

</div>

---

## なぜ Halo？

**Claude Code は現在利用可能な最も強力な AI コーディングエージェントです。** しかし問題があります：

> **ターミナルに閉じ込められています。**

CLI に慣れた開発者にとっては問題ありません。しかし、デザイナー、PM、学生、そして AI に *何かをしてほしい* だけの人にとって、ターミナルは壁です。

**Halo は初めてその壁を壊します。**

私たちは Claude Code の Agent 機能を 100% そのまま、誰でも使えるビジュアルインターフェースに包みました。同じパワー、ゼロの摩擦。

| | Claude Code CLI | Halo |
|---|:---:|:---:|
| フル Agent 機能 | ✅ | ✅ |
| ビジュアルインターフェース | ❌ | ✅ |
| ワンクリックインストール | ❌ | ✅ |
| 任意のデバイスからリモートアクセス | ❌ | ✅ |
| ファイルプレビュー＆管理 | ❌ | ✅ |
| 内蔵 AI ブラウザ | ❌ | ✅ |

> こう考えてください：
> **Windows** は DOS をビジュアルデスクトップに変えました。
> **Halo** は Claude Code CLI をビジュアル AI コンパニオンに変えます。

---

## 機能

<table>
<tr>
<td width="50%">

### 本物の Agent ループ
チャットだけではありません。Halo は **実際に行動できます** — コードを書き、ファイルを作成し、コマンドを実行し、タスクが完了するまで反復します。

### スペースシステム
分離されたワークスペースでプロジェクトを整理。各スペースには独自のファイル、会話、コンテキストがあります。

### 美しいアーティファクトレール
AI が作成するすべてのファイルをリアルタイムで確認。コード、HTML、画像をプレビュー — アプリを離れることなく。

</td>
<td width="50%">

### リモートアクセス
スマートフォンや任意のブラウザからデスクトップの Halo を制御。どこからでも作業 — 病院のベッドからでも（実話）。

### AI ブラウザ
AI に実際の組み込みブラウザを制御させます。Web スクレイピング、フォーム入力、テスト — すべて自動化。

### MCP サポート
Model Context Protocol で機能を拡張。Claude Desktop MCP サーバーと互換性あり。

</td>
</tr>
</table>

### その他の機能...

- **マルチプロバイダーサポート** — Anthropic、OpenAI、DeepSeek、および OpenAI 互換 API
- **リアルタイム思考** — AI が作業中の思考プロセスを観察
- **ツール権限** — ファイル/コマンド操作を承認または自動許可
- **ダーク/ライトテーマ** — システム対応テーマ
- **i18n 対応** — 英語、中国語、スペイン語（他も追加予定）
- **自動アップデート** — ワンクリックで最新版に

---

## スクリーンショット

![Chat Intro](./assets/chat_intro.jpg)

![Chat Todo](./assets/chat_todo.jpg)


*リモートアクセス：どこからでも Halo を制御*

![Remote Settings](./assets/remote_setting.jpg)
<p align="center">
  <img src="./assets/mobile_remote_access.jpg" width="45%" alt="モバイルリモートアクセス">
  &nbsp;&nbsp;
  <img src="./assets/mobile_chat.jpg" width="45%" alt="モバイルチャット">
</p>

---

## インストール

### ダウンロード（推奨）

| プラットフォーム | ダウンロード | 要件 |
|----------|----------|--------------|
| **macOS** (Apple Silicon) | [.dmg をダウンロード](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **macOS** (Intel) | [.dmg をダウンロード](https://github.com/openkursar/hello-halo/releases/latest) | macOS 11+ |
| **Windows** | [.exe をダウンロード](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+ |
| **Linux** | [.AppImage をダウンロード](https://github.com/openkursar/hello-halo/releases/latest) | Ubuntu 20.04+ |
| **Web** (PC/モバイル) | デスクトップアプリでリモートアクセスを有効化 | 最新のブラウザ |

**以上です。** ダウンロード、インストール、実行。Node.js 不要。npm 不要。ターミナルコマンド不要。

### ソースからビルド

貢献やカスタマイズしたい開発者向け：

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

---

## クイックスタート

1. **Halo を起動** して API キーを入力（Anthropic 推奨）
2. **チャットを開始** — 「React でシンプルな Todo アプリを作って」と試してみてください
3. **魔法を見る** — アーティファクトレールにファイルが表示されます
4. **プレビュー＆反復** — ファイルをクリックしてプレビュー、変更を依頼

> **プロのコツ:** 最良の結果を得るには、Claude Sonnet 4.5 または Opus 4.5 モデルを使用してください。

---

## 仕組み

```
┌─────────────────────────────────────────────────────────────────┐
│                       Halo デスクトップ                           │
│  ┌─────────────┐    ┌─────────────┐    ┌───────────────────┐   │
│  │   React UI  │◄──►│   メイン    │◄──►│  Claude Code SDK  │   │
│  │ (レンダラー) │IPC │  プロセス   │    │  (Agent ループ)   │   │
│  └─────────────┘    └─────────────┘    └───────────────────┘   │
│                            │                                    │
│                            ▼                                    │
│                    ┌───────────────┐                           │
│                    │ローカルファイル │                           │
│                    │   ~/.halo/    │                           │
│                    └───────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

- **100% ローカル** — データはマシンから離れません（API 呼び出しを除く）
- **バックエンド不要** — 純粋なデスクトップクライアント、自分の API キーを使用
- **本物の Agent ループ** — テキスト生成だけでなく、ツール実行

> **Powered by [Claude Code](https://github.com/anthropics/claude-code)** — 最も強力な AI エージェントを構築した Anthropic に感謝します。

---

## みんなが何を作っているか

Halo は開発者だけのものではありません。私たちが見てきたもの：

- **金融チーム** がゼロからフルスタックアプリを構築 — プログラミング経験なし
- **デザイナー** がインタラクティブなモックアップをプロトタイピング
- **学生** が AI をペアプログラミングパートナーとしてコーディングを学習
- **開発者** がこれまで以上に速く機能を提供

障壁はもはや AI の能力ではありません。**アクセシビリティです。** Halo はその障壁を取り除きます。

---

## ロードマップ

- [x] Claude Code SDK によるコア Agent ループ
- [x] スペース＆会話管理
- [x] アーティファクトプレビュー（コード、HTML、画像、Markdown）
- [x] リモートアクセス（ブラウザ制御）
- [x] AI ブラウザ（CDP ベース）
- [x] MCP サーバーサポート
- [ ] プラグインシステム
- [ ] AI アシストコードレビュー付きビジュアル Git
- [ ] AI 駆動ファイル検索

---

## コントリビュート

Halo はオープンソースです。AI は誰もがアクセスできるべきだからです。

あらゆる種類の貢献を歓迎します：

- **翻訳** — より多くのユーザーに届ける手助けを（`src/renderer/i18n/` を参照）
- **バグレポート** — 何か壊れているものを見つけましたか？教えてください
- **機能アイデア** — Halo をより良くするものは何ですか？
- **コード貢献** — PR 歓迎！

```bash
# 開発環境セットアップ
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run dev
```

ガイドラインは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

---

## コミュニティ

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions) — 質問＆アイデア
- [Issues](https://github.com/openkursar/hello-halo/issues) — バグレポート＆機能リクエスト

---

## ライセンス

MIT ライセンス — 詳細は [LICENSE](../LICENSE) を参照。

---

## Halo に触発されましたか？

このプロジェクトがアイデアを生んだり、何かクールなものを作るのに役立った場合：

- **スターをつけてください** — 他の人が Halo を見つけやすくなります
- **ストーリーを共有してください** — 何を作ったか聞きたいです
- **リンクしてください** — 例：`Inspired by [Halo](https://github.com/openkursar/hello-halo)`

---

## Halo の背景にあるストーリー

数ヶ月前、シンプルな不満から始まりました：**Claude Code を使いたいのに、一日中会議に縛られていました。**

退屈な会議中（誰もが経験あるでしょう）、思いました：*家のコンピューターの Claude Code をスマートフォンから操作できたら？*

そして別の問題が発生しました — 非技術系の同僚が Claude Code ができることを見て試したがっていました。しかしインストールで詰まりました。*「npm って何？Node.js はどうやってインストールするの？」* 数日かけても分からない人もいました。

だから自分と友達のために Halo を作りました：
- **ビジュアルインターフェース** — ターミナル出力を見つめる必要なし
- **ワンクリックインストール** — Node.js 不要、npm 不要、ダウンロードして実行するだけ
- **リモートアクセス** — スマートフォン、タブレット、任意のブラウザから制御

最初のバージョンは数時間で完成。その後のすべて？**100% Halo 自身が構築しました。** 何ヶ月も毎日使っています。

AI が AI を構築する。今やみんなの手に。

---

## 貢献者

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

Made with ❤️ by our contributors.

<div align="center">

### AI によって構築され、人間のために。

Halo が素晴らしいものを作る手助けになったら、ぜひ聞かせてください。

**このリポジトリに Star を** して、他の人が Halo を発見する手助けをしてください。

[![Star History Chart](https://api.star-history.com/svg?repos=openkursar/hello-halo&type=Date)](https://star-history.com/#openkursar/hello-halo&Date)

[⬆ トップに戻る](#halo)

</div>
