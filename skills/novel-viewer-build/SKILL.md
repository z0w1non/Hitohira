---
name: novel-viewer-build
description: Hitohiraの編集用HTMLから、実行時の圧縮器や復元コードを含まない公開用ミニファイHTMLをビルドする。
---

# ノベルビューア公開ビルド

## 入出力

- 編集・開発対象はリポジトリ直下の`hitohira.html`とする。ソースHTMLへミニファイ機能や復元用辞書を埋め込まない。
- このスキルは`hitohira.html`を変更するすべての作業で適用する。各変更後、テストや完了報告の前に必ず公開用HTMLを再生成する。
- 公開成果物は`public/hitohira.html`とし、`tools/generate_minified_viewer.js`で生成する。名前が同じでも、ルートの開発用`hitohira.html`と`public/hitohira.html`は別ファイルである。
- `public/hitohira.html`は生成物として扱い、直接編集しない。
- GitHubリポジトリのトップページに表示されるルート`README.md`から、GitHubのrawダウンロードURLで公開用HTMLを直接ダウンロードできるようにする。コード閲覧ページへの相対リンクにせず、READMEのダウンロード表示名は「Hitohiraをダウンロード」とする。

## ビルド手順

1. Node.jsとnpmを用意し、依存関係が未導入の場合はリポジトリルートで`npm ci`を実行する。依存の正確なバージョンは`package-lock.json`で固定する。
2. `npm run build:public`を実行する。`hitohira.html`を変更した作業では、この工程を省略しない。
3. `public/hitohira.html`が更新され、出力するファイル名、入力・出力バイト数、削減量、削減率が妥当であることを確認する。生成物も変更差分へ含める。
4. 生成HTMLにMITライセンス表記が完全に残り、ランタイム圧縮器・辞書・復元ハーネスが含まれないことを確認する。
5. `pwsh -File tests/run_tests.ps1 -Suite unit`、続けて`pwsh -File tests/run_tests.ps1 -Suite browser`を実行する。動的ポートで起動したブラウザーのネットワークを遮断し、公開用HTMLの起動、本文・設定・元ファイルの読み込み、保存と再読み込み後の復元、HTMLエクスポートを確認する。外部接続が失敗し、アプリ操作中にHTTP(S)要求がなく、出力HTMLに外部スクリプト・スタイルシートや実行元Blob URLが含まれないことを検証する。エクスポートされたHTMLも圧縮状態を保つことを確認する。サンドボックス無効化が必要な隔離環境だけ、各テストコマンドへ`-DisableSandbox`を明示する。

## 変換条件

- HTMLの属性・文章を壊す危険のある正規表現による全体空白置換はしない。タグ間空白のみ整理し、JavaScriptはAcornで構文確認後にTerserで圧縮する。JSONデータscriptは変更しない。
- MITライセンスコメントを一時退避し、他のコメントを除去してから原文のまま戻す。
- ビルド依存は出力HTMLへ含めない。製品HTMLは実行時ネットワーク接続を要求しない。
- ビルド依存のパッケージ名・バージョン・著作権表示・ライセンス全文は[第三者ライセンス通知](../../docs/THIRD_PARTY_NOTICES.md)で管理し、依存を変更したときは実際の依存ツリーと配布物を再確認する。

