# §5+§7 NPCエディタ / Room生活プレビュー 設計メモ（2026-07-13）

## 要望（features.md より）
- §5: 現在いるnpcたちのエディタがほしい。職場、セリフなど調整する
- §7: room-editorでNPCの生活が見たい。家具インタラクションのアニメ選択/調整、
  時間経過のアクション変更やセリフ、床歩行/階段昇降の確認、1日スケジュール通りの外出/帰宅/家庭内行動

## 方針
### Stage A: エージェント決定的化（§5前提・今回）
- initAgents の Math.random → mulberry32(固定シード20260713)。自宅/職場/時刻/歩道側が毎回同一に
- 決定的な氏名を付与（姓20×名20）→ エディタ・将来の表札で個人を識別
- bldModels/roadNodes は既にシード済み/OSM由来で決定的 → 追加保存ゼロで「同じ住人」が再現される

### Stage B: 生活NPCエディタ（§5本体・今回）
- **ゲーム内オーバーレイ**（Mキー）として実装。理由: エージェントは道路グラフ+建物+時計に依存
  しており、別アプリに複製すると重い。ゲーム内なら「今の状態」をそのまま見て編集できる
- 構成:
  - 俯瞰マップ（canvas）: 道路網 + 全エージェント点（在宅=緑/勤務=青/歩行=橙）+ プレイヤー
    + 選択者の自宅■/職場■/通勤経路。クリックで選択
  - 一覧: 検索（ID/名前）+ 先頭60件表示
  - 詳細: 出勤/帰宅時刻(数値)、職場再抽選/最寄り職場、一言セリフ（実体化時に頭上バブル表示）
- 保存: public/npc/agent-overrides.json = { "<agentId>": {work,goWork,goHome,line} }
  読み込み時にシード生成へ上書き適用（差分だけ保存＝人口を増やしても互換）
- 編集の反映: 時刻変更→分バケット入替（bucketRemove+Add）/ 職場変更→workNode再計算+経路キャッシュ破棄

### Stage C: Room生活プレビュー（§7・次回）
- room-editor に「生活プレビュー」モード:
  - ken VRM 1体を部屋にスポーン、床グリッド（room-genの空きセル）でA*歩行、階段はstairsOpen経由で2F
  - 時計スライダ+速度: 朝(起床→キッチン→玄関から退場) / 夕(帰宅→ソファ→就寝) を lifeSpot アンカーで巡回
  - 家具インタラクション: lifeSpot {action:'sleep'|'sit'|...} に応じ VRMA 選択UI（素材が無い間は
    idleポーズ+ラベル表示のプレースホルダ）→ furniture-anims.json に保存しゲームと共用
  - セリフ: 行動遷移時に一言（speech-set流用）
- ゲーム側は既に m.lifeSpot を持つ → 同じJSONを読んで在宅NPCにも適用

## 触るファイル
- plateau-fly/plateau-fly.js: makeRng/氏名/overrides適用/エディタUI一式/Mキー/入力ガード
- plateau-fly/index.html: #agent-ed パネル+スタイル
- public/npc/agent-overrides.json: エディタが保存（新規）
- （次回）room-editor/*, lib/room-gen.js(歩行グリッド公開), public/furniture-anims.json
