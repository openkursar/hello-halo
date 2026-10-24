<div align="center">

<img src="../resources/icon.png" alt="Halo Logo" width="120" height="120">

# Halo AI ワークステーション

**オープンソースのデスクトップ AI ワークステーション · デジタルヒューマンチーム · どこからでも仕事を任せる**

[![GitHub Stars](https://img.shields.io/github/stars/openkursar/hello-halo?style=social)](https://github.com/openkursar/hello-halo/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey.svg)](#ダウンロードとインストール)
[![Downloads](https://img.shields.io/github/downloads/openkursar/hello-halo/total.svg)](https://github.com/openkursar/hello-halo/releases)

[**ダウンロード**](#ダウンロードとインストール) · [**公式サイトとドキュメント**](https://hello-halo.cc/) · [**コントリビュート**](#コントリビュート)

**[English](../README.md)** | **[简体中文](./README.zh-CN.md)** | **[繁體中文](./README.zh-TW.md)** | **[Español](./README.es.md)** | **[Deutsch](./README.de.md)** | **[Français](./README.fr.md)**

</div>

---

Halo はオープンソースのデスクトップ AI ワークステーションです。普段の使い方は、おなじみのデスクトップ AI ワークベンチと同じです：チャット、コーディング、ドキュメント作成、調べもの。さらに、常駐して働く**デジタルヒューマン**を持ち、チームを組ませて分担させることができます。パソコンから離れているときも、スマートフォン、Feishu、WeChat、WeCom からいつでも仕事を任せ、進捗を追えます。

<p align="center">
  <img src="./assets/cards/team-poster.jpg" width="440" alt="デジタルヒューマンチーム：あなたの Lead がチーム全体を調整し、同僚のデジタルヒューマンはそれぞれ自分のパソコンで働きながら、チーム内でメッセージ、タスク、成果をやり取りする">
</p>

## なぜ Halo なのか

誰もが AI を使い、一人ひとりの効率は確かに上がりました。けれども仕事と仕事のつなぎ目は、いまも人頼みです：ある AI の結論を別の AI にコピーし、ファイルと結論を同僚に転送し、同僚はそれを自分の AI にもう一度説明し直す。人が最大のボトルネックになり、個人は速くなっても、チームの効率は追いついていません。

Halo では、AI 同士が直接分担し、引き継ぎ、記憶を積み重ね、常駐して見張ります。人は方向を決め、判断を下すだけです。個人の効率化は足し算、協働の効率化は掛け算です。

- **こんな人に**：AI のヘビーユーザー、開発者、リサーチャーや運用担当者、そして AI を日々の業務フローに取り入れたい小さなチーム。
- **3 つのこと**：[日常の AI ワークベンチ](#1-日常の-ai-ワークベンチ) · [デジタルヒューマンとデジタルヒューマンチーム](#2-デジタルヒューマンとデジタルヒューマンチーム) · [どこからでも仕事を任せる](#3-どこからでも仕事を任せる)
- **Halo が書いた**：AI が自らを改良し続ける大規模 AI ワークステーション。50 万行を超えるコードで、金融機関のエンタープライズ環境でも安定稼働しています。

---

## 1. 日常の AI ワークベンチ

- **チャット + キャンバス**：レポート、コード、Web ページ、ターミナル、Word / Excel / PDF を会話のすぐ横で開けます。一部分を選択してコメントを一言添えれば、AI はどこの話かを正確に理解します。
- **必要なときだけ機能をオン**：入力欄の「＋」から、Web 操作、チーム協働、AI Terminal、文字認識（OCR）、Halo の操作をワンクリックでオンにできます。ローカルのファイルやフォルダはそのまま添付でき、アップロードは不要です。
- **コーディング**：Claude Code、Codex、Halo SDK などのエンジンを選べます。変更ビューで AI が実際に何を変えたかを確認し、ワンクリックでクイックレビュー、または複数ロールによるチームレビューを開始できます。
- **AI Browser と AI Terminal**：AI が本物のブラウザとターミナルを操作し、あなたはその様子を横で見ながら、いつでも引き継いだり止めたりできます。
- **オフィス文書**：文書処理スキルと実行環境を内蔵しており、大量の依存関係を先に入れることなく、Word、Excel、PowerPoint、PDF を直接作成・編集できます。
- **ナレッジベースと記憶**：ファイル、フォルダ、PDF、Office 文書をナレッジベースに取り込むと、チャット中に自動で引用され、出典も示されます。同じ Space の複数のチャットは記憶を共有し、「現在の状態 / 履歴 / テーマ別の知識」に階層化して整理されるため、チャットを変えても一から説明し直す必要はありません。
- **会話同士の連携、Halo の操作**：新しい会話を開いて「ほかの会話はどうなってる？」と聞けば、一つずつ確認してまとめてくれます。AI が Space、デジタルヒューマン、設定の管理を代わりに行うこともできます。
- **手持ちのツールとつなぐ**：MCP サーバーとスキル（Skills）をワンクリックで接続。Claude Code の MCP と Skills のエコシステムと互換性があります。
- **マルチモデル、マルチアカウント**：任意の Anthropic / OpenAI 互換 API に対応し、複数の ChatGPT、Claude、GitHub Copilot アカウントに同時にサインインすることもできます。会話ごとにモデルと思考の強度を切り替えられます。

<p align="center">
  <img src="./assets/composer-capabilities.png" alt="チャット内の「＋」から、Web 操作、チーム協働、AI Terminal などの機能を必要に応じてオンにする"><br>
  <sub>図 1　チャット内の「＋」から、Web 操作、チーム協働、AI Terminal などの機能を必要に応じてオンにする</sub>
</p>

<p align="center">
  <img src="./assets/task-plan.png" alt="AI がタスクを計画に分解し、Web を検索しながら一項目ずつ進める"><br>
  <sub>図 2　AI がタスクを計画に分解し、Web を検索しながら一項目ずつ進める</sub>
</p>

<p align="center">
  <img src="./assets/mcp-connections.png" alt="WeCom の ToDo やドキュメントなどの MCP サービスをワンクリックで接続"><br>
  <sub>図 3　主要なツールとつなぐ：WeCom の ToDo やドキュメントなどの MCP サービスをワンクリックで接続</sub>
</p>

---

## 2. デジタルヒューマンとデジタルヒューマンチーム

一つの AI にすべてを任せると、注意力には限りがあります。あなたしか知らない AI では、チーム全体の役には立てません。分業が効くのは人だけでなく、AI も同じです。

| | 一つの AI にすべて任せる | デジタルヒューマンチーム |
|---|---|---|
| 分担 | 指示とツールが一か所に詰め込まれる | 各デジタルヒューマンが一つの工程だけを担当 |
| 失敗したとき | どのステップで間違えたのか分からない | どの工程で失敗したか一目で分かる |
| 引き継ぎ | 人が転送し、経緯を説明し直す | デジタルヒューマン同士が直接質問し、成果を渡す |
| 頼れる相手 | あなただけ | 同僚のデジタルヒューマンも |

- **デジタルヒューマン**：常駐して働く AI メンバー。スケジュールやイベントに応じて自動で動き（中国本土の営業日だけ動かすことも可能で、祝日や振替出勤日も考慮されます）、チャットで気軽にリマインダーを頼むこともできます。ストアからワンクリックでインストールするか、一言で作成できます。
- **一言でチーム結成**：どの Space でも AI に「この 3 つの製品を調べるチームを組んで」と言えば、調査、検証、執筆がそれぞれ分担されます。今後も使いたければ「このチームを残して」と一言。チーム全体に実行スケジュールを設定することもできます。
- **パソコンをまたいだチーム**：同僚が自分のデジタルヒューマンを連れてあなたのチームに加わり、それぞれ自分のパソコン上で動きます。データは各自のパソコンに残り、チームに公開された成果だけがチーム内を流れます。各デジタルヒューマンに何ができるかは、その持ち主が決めます。同じ LAN 内ならリモートアクセスをオンにするだけで招待でき、ネットワークをまたぐ場合は設定で中継ゲートウェイを構成します。
- **過程が見える**：チームワークスペースに、タスク、進捗、メンバー間のやり取り、成果がまとめて表示されます。デジタルヒューマン同士で調整し、チームで決められないことだけをあなたに聞きに来ます。

> こう言ってみてください：「これらの製品を調べて。資料集めと結論の検証は分担して、最後に一本のレポートにまとめて。」

<p align="center">
  <img src="./assets/team-workspace.png" alt="デジタルヒューマンチーム：リーダーがタスクを割り振り、メンバーが成果を納品し、互いに検収する"><br>
  <sub>図 4　デジタルヒューマンチーム：リーダーがタスクを割り振り、メンバーが成果を納品し、互いに検収する</sub>
</p>

<p align="center">
  <img src="./assets/daily-digest.png" alt="毎日のニュースダイジェストのデジタルヒューマン：毎日 08:00 に自動実行し、結果を WeCom にプッシュ"><br>
  <sub>図 5　毎日のニュースダイジェストのデジタルヒューマン：毎日 08:00 に自動実行し、結果を WeCom にプッシュ</sub>
</p>

### ストア、Browser Action とエコシステム

- **デジタルヒューマンストア**：一つ選んで設定をいくつか入力すれば、すぐに動き始めます。プロンプトを書く必要はありません。企業はプライベートストアをデプロイし、設定から追加するだけで使えます。
- **Browser Action：AI が判断し、スクリプトが実行**：あるプラットフォーム上の一つの具体的な操作を再利用可能な `.js` スクリプトとして書いておけば、AI は何をいつやるかだけを判断し、スクリプトが正確に実行します。Xiaohongshu、Bilibili、Zhihu、X などのプラットフォーム向けには既製の Action があり、社内システム向けにプライベートな Action を書くこともできます。[作ってみる →](https://hello-halo.cc/docs/en/developers/digital-humans/build.html)
- **デジタルヒューマンを公開**：`spec.yaml` を書いて [Digital Human Protocol（DHP）](https://github.com/openkursar/digital-human-protocol)に PR を提出すれば、マージ後すべての Halo ユーザーがインストールできるようになります。

<p align="center">
  <img src="./assets/shop_dh.png" alt="デジタルヒューマンストア：SNS 運用、ニュースブリーフィング、監視・巡回などの既製のデジタルヒューマン"><br>
  <sub>図 6　デジタルヒューマンストア：SNS 運用、ニュースブリーフィング、監視・巡回……入れればすぐ使える</sub>
</p>

---

## 3. どこからでも仕事を任せる

パソコンの前にいなくても、仕事は進み続けます。

- **スマートフォンとリモート Web**：自宅やオフィスのパソコンで動いている Halo にリモートアクセスし、タスクを任せ、資料をアップロードし、成果をダウンロードできます。
- **IM 連携**：Feishu、WeChat、WeCom に対応。使い慣れたチャット画面からデジタルヒューマンに仕事を任せられ、その裏で動くのはチーム丸ごとでも構いません。
- **IM で判断する**：結果はそのままチャットに届きます。あなたの判断が必要なことには一言返すだけで、仕事は先へ進みます。

<p align="center">
  <img src="./assets/mobile-remote.png" width="640" alt="スマートフォンからのリモート利用：左はスマートフォン上の Halo、右はパソコンが完成させた結果をスマートフォンで確認しているところ"><br>
  <sub>図 7　スマートフォンからのリモート利用：すべての機能を持ち歩き、一言でパソコンにタスクを完了させる</sub>
</p>

---

## 代表的なシナリオ

| シナリオ | やること | 結果 |
|---|---|---|
| 競合 / 業界リサーチ | 一言でチーム結成：調査、検証、執筆を分担 | チームワークスペースで進捗を確認し、完成したレポートを受け取る |
| 毎日の情報ブリーフィング | デジタルヒューマンが営業日ごとに業界や開発の動向を定時にまとめる | 毎朝始業前に Feishu / WeCom へプッシュ |
| 外出先から依頼 | スマートフォンの WeChat で「この提案書を直しておいて」と言う | パソコンに戻って完成品を開くか、スマートフォンで直接ダウンロード |
| コーディング | AI の修正を変更ビューでレビューし、さらにチームレビューを開始 | 何が変わったかを把握し、安心してコミット |
| オフィス文書 | AI に週報、表、プレゼン資料を作らせる | Word / Excel / PowerPoint ファイルがそのまま手に入る |
| 社内システムの巡回 | デジタルヒューマンが定時に OA、承認、チケットシステムにログインして巡回 | 期限切れや異常を IM にプッシュし、あなたの対応を待つ |
| SNS 運用 | ストアにある既製の Browser Action デジタルヒューマンをインストール | コメントへの定時返信、コンテンツ投稿、評判の追跡 |

**デモを見る**：[製品デモ](https://www.bilibili.com/video/BV1jEZYBaEcy/) · [デジタルヒューマンによる 7x24 運用](https://www.bilibili.com/video/BV1yfNuzaEtv/) · [AI Browser](https://github.com/user-attachments/assets/2d4d2f3e-d27c-44b0-8f1d-9059c8372003)

---

## クイックスタート

1. [ダウンロードしてインストール](#ダウンロードとインストール)し、Halo を開きます。
2. Claude または ChatGPT のアカウントでサインインするか、任意の Anthropic / OpenAI 互換サービスの API Key を入力します。
3. Space を作成します：1 プロジェクトにつき 1 つの Space で、ファイルと記憶が互いに干渉しません。
4. そのままチャットで仕事を任せるか、ストアからデジタルヒューマンをインストールし、一言でチームを結成します。
5. 必要に応じてリモートアクセスをオンにするか、Feishu / WeChat / WeCom と連携して、どこからでも続けられます。

## ダウンロードとインストール

| プラットフォーム | ダウンロード | 動作要件 |
|---|---|---|
| macOS（Apple シリコン） | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| macOS（Intel） | [.dmg](https://github.com/openkursar/hello-halo/releases/latest) | macOS 12+ |
| Windows | [.exe](https://github.com/openkursar/hello-halo/releases/latest) | Windows 10+（x64） |
| Linux | [.AppImage](https://github.com/openkursar/hello-halo/releases/latest) | glibc 2.34+（Ubuntu 22.04+、Debian 12+） |
| Android（リモートクライアント） | [.apk](https://github.com/openkursar/hello-halo/releases/latest) | Android 7.0+ |
| iOS（リモートクライアント） | ソースからビルド | iOS 15+ |

ダウンロードしてインストールし、起動するだけ。Node.js、npm、コマンドラインは不要で、サーバー側の依存関係もないため、IT 部門はそのまま配布できます。その後は自動で更新されます：Windows では 3.0 以降、新しいバージョンがバックグラウンドで準備され、再起動をクリックするだけで完了します。Linux 版には現時点で AI Terminal が含まれていません。

### ソースからビルド

```bash
git clone https://github.com/openkursar/hello-halo.git
cd hello-halo
npm install
npm run prepare
npm run dev
```

---

## 技術的な特長

- **オープンソース、あなた自身のパソコンで動く**：ファイルと作業環境はあなたの管理下にあります。Halo は独自のバックエンドサービスを持ちません。
- **差し替え可能な Agent エンジン**：Claude Code、Codex、そして自社開発の Halo SDK（リソース消費が少なく、起動が速く、オープンソースモデル向けに最適化）、DeepSeek dsh から、必要に応じて選べます。
- **非中央集権・分散型のデジタルヒューマンチーム**：メンバーは異なるパソコンに分散して協働し、中央サーバーはありません。チームの状態管理は Raft 合意アルゴリズムを参考にしており、多数決でリーダーノードを選出し、任期ごとにログを複製します。リーダーノードのあるパソコンがオフラインになると自動で再選出され、リーダーノードが 2 つ存在することはなく、チームはそのまま動き続けます。 [仕組み](https://hello-halo.cc/docs/en/advanced/team-consensus.html)（英語）
- **細部**：Space の分離、ライト / ダークテーマ、50%–150% の画面ズーム、7 言語に対応したインターフェース。

---

## コントリビュート

- **翻訳**：`src/renderer/i18n/`
- **バグ報告**：[Issues](https://github.com/openkursar/hello-halo/issues)
- **機能提案**：[Discussions](https://github.com/openkursar/hello-halo/discussions)
- **コード貢献**：PR を歓迎します。ソースからのビルドは[上記](#ソースからビルド)を参照

詳細は [CONTRIBUTING.md](../CONTRIBUTING.md) をご覧ください。

## コミュニティ

- [GitHub Discussions](https://github.com/openkursar/hello-halo/discussions)
- [GitHub Issues](https://github.com/openkursar/hello-halo/issues)

<p align="center">
  <img src="https://github.com/user-attachments/assets/500aa749-50d9-4587-986d-338b1ed899f1" width="200" alt="個人 WeChat QR コード">
</p>
<p align="center">
  <em>フィードバックや交流は、WeChat: go2halo を「Halo」というメモ付きで追加してください</em>
</p>

---

## Halo の物語

2025 年 10 月、シンプルな不満から始まりました：**Claude Code を使いたかったのに、一日中会議に追われていた。**

退屈な会議中に思いました：*自宅のパソコンの Claude Code をスマートフォンから操作できたらどうだろう？*

次に 2 つ目の問題が来ました — 非技術系の同僚も使いたがっていましたが、インストールでつまずきました。*「npm って何？」*

そこで Halo を作りました：ビジュアルなインターフェース、ワンクリックインストール、リモートアクセス。最初のバージョンは数時間で完成。その後のすべては？**ほぼすべて Halo 自身が構築しました。** 2026 年初頭、Halo はオープンソースになりました。

私たちは、次のステップは **AI ワークステーション**だと信じています：AI はもう、誰かが見張っていなくても仕事ができる。あなたが目標を設定し、デジタルヒューマンが 7x24 で自律的に前進させ、あなたは重要な節目でだけ判断を下す。3.0 ではデジタルヒューマンがチームを組み、パソコンをまたいで協働するようになり、この目標にまた一歩近づきました。

— [@openkursar-flynn](https://github.com/openkursar-flynn)、Halo 発起人

---

## ライセンス

MIT — [LICENSE](../LICENSE)

---

<div align="center">

## コントリビューター

<a href="https://github.com/openkursar/hello-halo/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openkursar/hello-halo" />
</a>

**このリポジトリにスターを付けて**、より多くの人が Halo を見つけられるようにしてください。

</div>

---

## パートナー & スポンサー

Halo があなたのプロジェクトにインスピレーションを与えた場合、または Halo をベースに何かを構築した場合は、ぜひご紹介ください。

### エンタープライズパートナー

| あなたの会社で Halo を使っていますか？ | [お知らせください](https://github.com/openkursar/hello-halo/issues/new?title=Add+our+company+as+partner) — ここでご紹介させていただきます。 |
|:---:|:---:|

### スポンサー

<a href="https://www.nnscholar.com/">
  <img src="https://www.nnscholar.com/favicon.ico" height="40" alt="NNScholar">
</a>

<p align="center">
  <a href="https://ifdian.net/a/hello-halo">爱发电（Alipay / WeChat）</a> · <a href="https://buy.polar.sh/polar_cl_x7bTGvMvt3rbUt6oE98z0zb2zFz1sT7dG37BA3foNsZ">Polar（国際クレジットカード）</a>
</p>

---

<div align="center">

[トップに戻る](#halo-ai-ワークステーション)

</div>
