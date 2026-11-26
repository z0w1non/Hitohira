# 開発資料

文書ごとの役割と正本を一覧にする。製品利用者向けの案内はリポジトリ直下の[README](../README.md)を参照する。

| 資料 | 用途・正本となる情報 |
|---|---|
| [SPECIFICATION.md](./SPECIFICATION.md) | 製品の画面、入力、表示、保存、エクスポートなどの動作仕様。 |
| [TESTING.md](./TESTING.md) | テストの実行方法、ブラウザー環境、隔離、後始末。 |
| [coverage_matrix.md](./coverage_matrix.md) | 仕様機能と単体・ブラウザー操作テストの対応範囲。 |
| [ISSUES.md](./ISSUES.md) | 未解決課題、優先度、完了条件、阻害要因、次の作業。 |
| [DEVELOPMENT_KNOWLEDGE.md](./DEVELOPMENT_KNOWLEDGE.md) | 作業で得た再利用可能な知見、根拠、適用範囲、再確認条件。 |
| [DECISIONS.md](./DECISIONS.md) | 製品構成などの長期的な設計判断、背景、理由、影響、見直し条件。 |
| [PLANS.md](./PLANS.md) | 現在の実施順序と完了済みの大きな基盤作業。個別課題の状態はISSUES.mdを正とする。 |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | 公開ビルドに使うツールおよび推移依存の著作権・ライセンス通知。 |
| [../AGENTS.md](../AGENTS.md) | 開発・保守時の共通方針と文書更新ルール。 |
| [テストスキル](../skills/novel-viewer-tests/SKILL.md) | テストの設計・拡充と検証の進め方。実行コマンドはTESTING.mdを正とする。 |
| [リファクタリングスキル](../skills/novel-viewer-refactor/SKILL.md) | コード・仕様・開発方針をそろえて整理する手順。 |
| [公開ビルドスキル](../skills/novel-viewer-build/SKILL.md) | 編集用HTMLから公開用HTMLを再生成する手順。 |

## 作業別の参照先

| 作業 | 参照順 |
|---|---|
| 製品動作の変更 | [AGENTS.md](../AGENTS.md) → [SPECIFICATION.md](./SPECIFICATION.md) → [coverage_matrix.md](./coverage_matrix.md) |
| 課題の解決 | [ISSUES.md](./ISSUES.md) → 実装・仕様 → [TESTING.md](./TESTING.md) → [coverage_matrix.md](./coverage_matrix.md) |
| ビルド・ライセンス | [公開ビルドスキル](../skills/novel-viewer-build/SKILL.md) → [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) |
| 大きな設計変更 | [DECISIONS.md](./DECISIONS.md) → [SPECIFICATION.md](./SPECIFICATION.md) → 実装・テスト |
