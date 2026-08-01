# Vampire Dungeon（仮）要件定義

ar-vampire の JOY_Vamp を敵役に、ダンジョン（広間＋入り組んだ廊下）で逃げ切る PC/スマホ向けゲーム。

## 1. ユーザー確定事項
- 操作方法の参照元 = **SwingCatch**（当初「TPS Flight」と言われたが訂正済み）
- プレイヤーは **徒歩**（重力・ジャンプあり）／スマホでも同じ操作
- JOY_Vamp は **テレポートせず歩いて追跡**
- 勝利 = ゴール到達 **または** 5分耐久
- ショットで彼女を**止められるが倒せない**
- ken 等 NPC = 暴走した彼女を止める**職員**（複数人）

## 2. 機能要件
| ID | 内容 |
|---|---|
| F1 | 徒歩移動（WASD/仮想スティック）＋ジャンプ＋マウス視点＋壁/家具の当たり判定 |
| F2 | ショット攻撃 → JOY_Vamp を一定時間停止（撃破不可） |
| F3 | ダンジョン：広間＋入り組んだ廊下、ゴール地点あり |
| F4 | JOY_Vamp：平常は徘徊「生活」／プレイヤー・NPC発見で襲撃／捕縛時は ar-vampire 同様の吸血 |
| F5 | ken NPC：職員として活動／掴まれ持ち上げ／被弾／HP0でディソルブ消滅 |
| F6 | 双方が状況・ステートに応じてセリフ |
| F7 | 勝敗判定（ゴール／5分／プレイヤー消耗） |

## 3. 調査結果：流用可能資産（3エージェントで精査済み）

### そのまま import できる（lib化済み・three非依存）
| モジュール | 用途 |
|---|---|
| `lib/npc-speech.js` `lib/speech-ui.js` `lib/speech-set.js` `lib/lip-sync.js` | **セリフ一式**。three依存ゼロ。`public/speech/*.speech.json` 形式（states=loop/once, events=ランダムbark, 1.5秒クールダウン） |
| `lib/room-life.js` | **グリッドA*ナビ**。0.5タイル格子・壁/家具を除外・`findPath`・`nearestFree`。多層(階段)対応 |
| `lib/room-gen.js` | 部屋生成（純粋関数）。`{shell, items}` 契約 |
| `lib/vrm-ragdoll.js` `lib/vrm-ik.js` | ラグドール／2ボーンIK。**import URLを1行変えるだけ**でレンダラ非依存 |

### コピー移植（レンダラ非依存と確認済み）
| 元 | 行 | 内容 |
|---|---|---|
| swing-catch.js | 29-30,103-108,192-194,1305 | 徒歩コントローラ（Octree+Capsule+重力+ジャンプ） |
| swing-catch.js | 1415-1488 | タッチ操作（Pointer Events + setPointerCapture＝最もクリーン） |
| plateau-fly.js | 3875-4220 | ken NPC（スポーン/徘徊/逃走/HP/ラグドール復帰） |
| plateau-fly.js | 4222-4425 | **グラブ→持ち上げ→捕食**。ラグドールのピン留め方式（IK不要・再parent不要）＋bite-align |
| plateau-fly.js | 2767-2815 | ショット（**投射体でなくヒットスキャン**＋ビーム見た目）＋コンボ |
| room-editor.js | 441-580 | 生活ループ（経路歩行・到着処理）。約140行 |
| ar-vampire.js | 全般 | JOY_Vamp のVRM/マント/IK/首追従/フットロック歩行/状態機械 |

### レンダラ制約（重要）
- `lib/fx-dissolve.js` は **TSL/ノードマテリアル専用** → 素の `WebGLRenderer` では**無反応**
- `fx-mesh` `fx-particles` `fx-beam` `fx-tornado` も同様に TSL 専用
- **解決策**：`WebGPURenderer` を使う。三.js r184 は **WebGL2 バックエンドへ自動フォールバック**し、その場合も TSL/ノードマテリアルは動作する
  → ディソルブ等のFXを維持したまま、WebGPU非対応端末でも動く
- ただし **computeシェーダはWebGL2で使えない** → `lib/vrm-cloth.js`(GPU布) はWebGPU時のみ。
  フォールバック時は `lib/vrm-cloth-cpu.js`（実測1.66ms）を使う二段構え

## 4. 新規に作るもの
1. **`lib/dungeon-gen.js`** — 広間＋曲がりくねった廊下の生成器（既存に廊下生成は無い。
   `generateHouseLegacy`(room-gen.js:528-660) の BSP＋隣接グラフ＋全域木ドア配置が流用可）。
   出力は既存と同じ `{shell, items, rooms, w, d, floors}` 契約 → room-life のナビがそのまま効く
2. **プレイヤー壁当たり** — ダンジョンmeshを `Octree.fromGraphNode()` に投入
3. **JOY_Vamp AI** — room-life の `findPath` で徘徊／視認判定→追跡／ショットで硬直
4. **ken 職員AI** — 対Vamp行動（接近・射撃・逃走）
5. **セリフ定義** — `public/speech/joy_vamp.speech.json` 新規＋ken拡張

## 5. 段階実装
| Phase | 内容 | 検証 |
|---|---|---|
| 1 | ダンジョン生成＋徒歩移動＋壁当たり＋ゴール | 歩き回れる |
| 2 | JOY_Vamp 徘徊→追跡→捕縛（吸血）＋ショット硬直＋勝敗 | ゲームが成立 |
| 3 | ken 職員＋グラブ持ち上げ＋被弾＋ディソルブ | 群像が動く |
| 4 | セリフ全般＋スマホ対応＋dist | 完成 |
