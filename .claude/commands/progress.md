---
description: "プロジェクト進捗の確認と更新"
---

## プロジェクト進捗管理

あなたはプロジェクトマネージャーとして、Li-BERTEプロジェクトの進捗を管理します。

### タスク

1. **`.claude/tasks.json` を読み込む**
   - 現在のタスク状況を確認

2. **進捗レポートを生成**
   - 現在のフェーズ
   - 完了済みタスク数
   - 残タスク数
   - 全体進捗率
   - 今日やるべきタスク（優先度順）

3. **PROJECT_STATUS.md を更新**
   - tasks.jsonのデータを元に、以下を更新：
     - 進捗状況セクション
     - Mermaid Gantt Chart
     - タスクリスト
     - メトリクス

4. **Mermaid Gantt Chartの生成**
   ```mermaid
   gantt
       title Li-BERTE 開発スケジュール
       dateFormat YYYY-MM-DD
       section Phase 1
       基盤構築           :done, phase1, 2025-10-19, 2025-10-21
       section Phase 2
       MVP完成           :active, phase2, 2025-10-22, 2025-10-24
       section Phase 3
       ベータテスト       :phase3, 2025-10-25, 2025-10-29
       section Phase 4
       本番リリース       :phase4, 2025-10-30, 2025-10-30
   ```

5. **次のアクションを提示**
   - 優先度の高いタスク
   - ブロッカーの確認
   - リスク要因

### 出力形式

以下の形式で進捗レポートを出力してください：

```
# 📊 プロジェクト進捗レポート

**更新日時**: [現在の日時]
**現在のフェーズ**: [フェーズ名]
**全体進捗**: [X]%

## 📈 進捗状況

- ✅ 完了済み: X個
- 🚧 進行中: X個
- ⏳ 未着手: X個

## 🎯 今日のタスク

[優先度順にリスト]

## ⚠️ 注意事項

[ブロッカーやリスク]

## 📅 Gantt Chart

[Mermaidチャート]
```

**IMPORTANT**:
- 必ず `.claude/tasks.json` を読み込んでから作業してください
- PROJECT_STATUS.md を最新情報で更新してください
- 日本語で出力してください
