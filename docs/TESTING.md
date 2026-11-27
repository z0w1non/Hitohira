# テスト実行ガイド

テストのコマンド、環境、隔離、後始末を定義する。テストが対象とする機能は[カバレッジマトリクス](./coverage_matrix.md)、製品の期待動作は[仕様書](./SPECIFICATION.md)を参照する。

## 実行コマンド

リポジトリルートから実行する。Node.js標準モジュールを使うため、テスト実行にnpmパッケージの追加インストールは不要。

| 対象 | PowerShell | Node.js |
|---|---|---|
| 単体テスト | `pwsh -File tests/run_tests.ps1 -Suite unit` | `node tests/run_tests.js unit` |
| Chrome/Edgeブラウザー操作 | `pwsh -File tests/run_tests.ps1 -Suite browser` | `node tests/run_tests.js browser` |
| Firefox操作 | `pwsh -File tests/run_tests.ps1 -Suite firefox` | `node tests/run_tests.js firefox` |
| 単体とChrome/Edge | `pwsh -File tests/run_tests.ps1 -Suite all` | `node tests/run_tests.js all` |

PowerShellラッパーは`-Node`でNode.js実行ファイルを指定できる。`-Suite`を省略した場合は`all`を実行する。

ブラウザー操作テストとFirefox操作テストは不安定なため、利用者が実行を明示的に指示した場合に限り実施する。`all`スイートはChrome/Edgeブラウザー操作テストを含むため、明示指示がない場合は単体テストの`unit`を指定する。テスト変更時もブラウザー操作テストを自動実行せず、未実施として報告する。

## ブラウザー環境

- Chrome/Edgeのテストはブラウザーをテスト自身で起動し、一時プロファイルと動的CDPポートを使う。既定ではインストール済みChromeを優先し、必要ならEdgeを選ぶ。比較時は`NOVEL_VIEWER_BROWSER=chrome`または`edge`を指定する。
- Firefoxテストの開発環境にはFirefoxをインストールする。標準外の場所にある場合は`NOVEL_VIEWER_FIREFOX_PATH`で実行ファイルを指定する。WebDriver BiDiポートは動的に割り当てる。
- ループバックTCPを使えない場合、`NOVEL_VIEWER_CDP_PIPE=1`を設定してChrome/Edgeテストをパイプ接続で実行できる。
- ブラウザー操作テストはCDP応答8秒、WebSocket接続5秒、ブラウザー起動・ターゲット検出8秒の上限を設ける。状態ポーリングは50ms間隔で必要な状態が整った時点で終了し、失敗時は待ち続けず診断を出す。
- ブラウザー操作テストの失敗ログは、Crashpad起動失敗、CDPループバック拒否、ポート通知なし、ターゲット取得失敗、WebSocket失敗、パイプ失敗、その他に分類する。ブラウザー実行ファイル、接続方式と失敗段階、対象URL、起動引数、プロセス終了情報、当該ブラウザーの標準エラーを併記する。
- 実行時間を調べるときは`NOVEL_VIEWER_TEST_TIMINGS=1`を設定する。テスト全体と、直前の成功チェックから次の成功チェックまでが長かった上位8区間を表示する。これは隣接するチェック間の経過時間であり、単一関数の実行時間とは限らない。
- 通知の5秒自動閉鎖は依存性注入したタイマーを使う単体テストで確認し、ブラウザー操作テストでは表示と手動閉鎖を確認する。実時間の経過を待たず、テスト時間を短縮する。
- 単体テストでは実時間の経過、固定sleep、実タイマーの発火待ちを使わない。時間・タイマーを対象処理へ注入し、`tests/test_utils.js`の`createFakeClock()`で`clock.runUntil(operation)`または`clock.advanceBy(ms)`を使って時刻とタイマーを決定論的に進める。タイマーに依存する処理は、テストで差し替えられるよう依存注入境界を設ける。実時間待機は明示実行するブラウザー操作テストなど、実際の経過時間を検証対象とする場合に限る。
- `pwsh -File tests/run_tests.ps1`はテスト結果を逐次表示する。`NOVEL_VIEWER_DISABLE_SANDBOX=1`を明示設定した場合はラッパー実行時も保持し、隔離環境でだけ利用できる。
- ポリシー・容量制御の追加ケースは`NOVEL_VIEWER_POLICY_TESTS=1`を設定して実行する。ループバック接続が必要で、テストが一時HTTPサーバーと容量上限を管理する。
- ブラウザーは既定でヘッドレス起動する。Chromeのウィンドウを確認する場合はPowerShellラッパーへ`-ShowBrowser`を指定する。

## オフライン配布テスト

Chrome/Edgeのブラウザー操作スイートは、ネットワーク遮断下で公開HTMLを起動し、本文表示・設定・本文取込・保存と再読み込み後の復元・HTMLエクスポートを確認する。アプリ操作中のHTTP(S)要求がなく、エクスポートHTMLが外部実行リソースや実行元Blob URLを参照しないことも検査する。

## 隔離と後始末

- ブラウザー操作テストはサンドボックスを有効にして実行する。サンドボックス無効化が必要な隔離済み検証環境に限り、`$env:NOVEL_VIEWER_DISABLE_SANDBOX='1'`を明示設定してから実行する。ループバック接続も制限される隔離環境では`NOVEL_VIEWER_CDP_PIPE=1`を併用する。
- テストは正常終了・失敗・例外・中断を問わず、起動したプロセスツリー、BiDi/CDP接続、一時プロファイル、ダウンロード領域、テスト用保存データを後始末する。ユーザーが起動したブラウザーは終了しない。
- PowerShellラッパーはNode.jsのUTF-8出力を表示し、終了時に呼び出し元の出力エンコーディング設定を復元する。
- ブラウザー接続に失敗した場合は、ログの原因分類と、起動引数、動的ポートまたはパイプ、対象URL、終了コード、当該ブラウザーの標準エラーを確認する。未実施なら理由と終了コードを記録する。
