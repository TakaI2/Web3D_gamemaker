# 設計 — サイキッカー空中アクション（TPS / tps-flight）

要件: `.tmp/requirements.md`。ベース: `swing-catch`。レンダラ WebGPU。

## 0. 全体アーキテクチャ
- 新規 `tps-flight/`（`index.html` + `tps-flight.js`）。swing-catch を雛形に、**FPS→TPS** と **NPC戦闘を除去**して作る。
- 流用（ほぼそのまま）: シーン/レンダラ/スカイ/IBL/フォグ、`buildArena`、浮遊オブジェクト（`spawnObject`/`spawnModelObject`/`stepObjects`/`physicsStep`/`syncObjectMeshes`/コリジョン）、`loadStage`/`loadSelectedModels`、`lib/vrm-cloth`、`createVRMAnimationClip`、`dataURIToBlob`。
- 除去/無効化: NPC（megus・敵戦闘・HUD・フロー postMessage）、ポインタロックFPS視点、カプセル重力・ジャンプ・床コリジョン（プレイヤーは飛行）。
- hub 登録: `hub/index.html` にカード1枚追加（GAME）。

## 1. 前提作業A: lib/vrm-cloth を「名前付きグループ」対応へ（旧 Stage 3）
**理由**: Joy_reborn の cloth は `gripGroups`(g5..g8)＋timeline は `groupId` トラック。現 `lib/vrm-cloth` は旧2ハンド(side)モデルで groupId を無視 → マント掴みが効かない。cloth-preview の per-vertex 方式へ統一する。

### GPU モデル（cloth-preview/cloth-editor と同一に統一）
- `vertexParams.w`(gripCode): **0=なし / 1=アンカー(常時) / 2=グリップ(グループactive時)**（現行の 1=左,2=右,3=anchor は廃止）。
- `bonePinTargetBuffer` を **vec3→vec4** に拡張（`xyz`=ターゲット, `w`=active フラグ）。アンカー頂点は w=1 固定、グリップ頂点は所属グループの active で 0/1。
- 旧 `leftGrip*/rightGrip*` uniform と分岐は削除。動的グラブ（`grab/moveGrab/releaseGrab`：プレイヤーが手でマントを掴む）は**残す**（互換）。

### データ読み込み（後方互換）
- グループ: `cloth.gripGroups`(新) を優先。各 `{id,name,bone,offset:[x,y,z],vertices:[..]}`。無ければ legacy `cloth.leftGripIndices/rightGripIndices`(+`handGrabOffsets`) から `leftHand`/`rightHand` グループを合成。
- 頂点→グループ: `gripMap`(Map idx→groupId)。重複は先勝ち。
- 各グループ: `{id,bone,boneNode,offset:Vector3,worldPos:Vector3,active:bool}`。グラブ点 worldPos = `boneWorldPos + boneWorldQuat × offset`（cloth-preview と同じ回転追従）。

### timeline グリップの解釈（後方互換 + 切替）
- 現状は生成時 `o.timeline` の固定。**ランタイム切替**のため API 追加:
  - `setTimeline(timeline)`: その timeline の grip トラックを解析して内部 `gripRanges`(Map groupId→[{start,end}]) を差し替え。
  - `setGroupsActive(idsOrMap)`（任意・簡易版）: フレーム評価せず直接 active 指定（state遷移ベースで使うなら）。
- `update(dt, frame)`:
  1. 各グループ active = `gripActiveAt(gripRanges[g.id], frame)`（frame=null なら全false）。
  2. アンカー/グリップの per-vertex ターゲットを `bonePinTargetBuffer`(vec4) に書く（アンカー: bone+rot×localOffset, w=1／グリップ: group.worldPos, w=active?1:0）。
  3. コライダーのボーン追従、固定タイムステップ compute（現行どおり）。
- timeline トラック互換: `groupId`(新) 優先、無ければ legacy `side:'left'/'right'` を leftHand/rightHand グループへ（cloth-preview importTimeline と同じマップ）。
- `gripPos`(グラブ点位置キーフレーム) は今回のゲームに不要 → **対象外**（将来）。group.offset は cloth データ固定。

### 影響と互換確認（重要）
- 既存利用箇所: `fps-cloth-vrm`・`swing-catch`（旧 megu 系：side timeline + leftGripIndices）。→ legacy 合成パスで従来どおり動くこと。`character-editor`/`cloth-editor`/`cloth-preview` は独自 sim なので影響なし。
- リスク: GPU バッファ構成変更（vec4 化）。**WebGPU の storage buffer 8本制限**に注意（cloth-preview で踏んだ罠）。現行 lib は anchor のみ vec3 一本→vec4 一本に置換なので本数は増えない見込み。要実機確認。

## 2. 前提作業B: timeline に VRMA 参照を埋め込む（cloth-preview 拡張）
- cloth-preview: VRMA をドロップダウン/ファイルで読んだとき `currentVrmaName`（例 `"move_Flying_front.vrma"`、ファイル読み込み時はそのファイル名）を保持。
- `exportTimeline()` に `vrma: currentVrmaName` を追加。`importTimeline(json)` で `json.vrma` を読み、TLドロップダウンからの読込時など、可能なら対応VRMA(`/vrma/<name>`)を自動ロード（任意・失敗無害）。
- 既存 `Joy_reborn_*.timeline.json` に `vrma` を**バックフィル**（確定マッピング）。スペース/`@`入りは値としてはそのまま（fetchは利用側で `encodeURI`）。

### 確定 VRMA マッピング（バックフィル）
| timeline | vrma |
|---|---|
| Joy_reborn_Fly_f | move_Flying_front.vrma |
| Joy_reborn_Fly_back | move_Flying_back.vrma |
| Joy_reborn_Fly_L | move_Flying_left.vrma |
| Joy_reborn_Fly_R | move_Flying_right.vrma |
| Joy_reborn_Fly_idle | idle.vrma（仮） |
| Joy_reborn_Fly_f2 | move_Flying_front02.vrma（仮） |
| Joy_reborn_capcher1 | attack01.vrma |
| Joy_reborn_cas1_L1 | HumanF@MagicAttackDirect1H01_L - Cast.vrma |

## 3. プレイヤー（Joy_reborn）とアニメ状態機械
### 生成
- `public/npc/Joy_reborn.npc.json` を fetch（NPCバンドル）。VRM を MToonNodeMaterial で生成（swing-catch createMegu と同様）。`vrm.scene` をシーンへ。
- cloth = `createVRMCloth({ renderer, scene, vrm, cloth: bundle.cloth, basePos: spawn, floorY:-1e9, timeline: <初期=idle> })`（重力で落ちないよう floorY 無効化、空中）。

### モーションセット（複数 VRMA → 1 mixer）
- 状態定義 `STATES`（キー→ `{ timelineFile, vrmaFile, loop }`）。確定マッピングを内蔵（timelineFile を fetch して vrma 名も取得できるが、確実性のためゲーム内テーブルにも持つ）。
- ロード手順（各状態）:
  1. `fetch('../timeline/<timelineFile>.timeline.json')` → grip 等トラック＋`vrma`。
  2. `fetch('../vrma/'+encodeURI(vrmaName))` → `createVRMAnimationClip` → `mixer.clipAction(clip)`。loop/once 設定。
  3. `state = { clip, action, timeline }` を保持。
- 1つの `AnimationMixer(vrm.scene)`。各 action を用意し、**crossFadeTo** で遷移（`fadeDuration≈0.15s`）。

### 状態機械
- 入力→希望状態を決定:
  - グラブ中ワンショット（capcher1）/ショット（cas1_L1）が再生中はそれを優先（再生終了 or 一定時間で抜ける）。
  - 移動入力あり: グラブ保持中なら `Fly_f2`、非保持なら方向別（前=Fly_f / 後=Fly_back / 左=Fly_L / 右=Fly_R）。複数同時は優先順（前後 > 左右、または合成は単純化して主方向）。
  - 入力なし: `Fly_idle`。
- 遷移時: `crossFadeTo`、かつ `cloth.setTimeline(state.timeline)`（grip グループ切替）。
- 毎フレーム: `mixer.update(dt)` → `vrm.update(dt)` → `frame = floor(activeAction.time * state.timeline.fps)` → `cloth.update(dt, frame)`。

### 注意
- VRMA はワールド原点基準のポーズ。プレイヤーの移動は `vrm.scene.position` を動かす（mixer はローカルポーズ、位置は別管理）。Hips のルート移動を含むモーションは要確認（移動と二重移動になるなら hips の XZ を無視 or そのまま許容を実機判断）。
- cloth `basePos`/コライダーはボーン追従なので、`vrm.scene.position` を動かせばマントも追従する。

## 4. TPS カメラ（球面 + スプリング）
- 状態: `camYaw, camPitch, camDist`（球面）、`camTarget`(注視点=プレイヤー頭付近)。
- 入力: ポインタロック中の `mousemove` で `camYaw -= dx*sens; camPitch -= dy*sens`（pitch を `[-1.3, +1.3]` 程度に制限）。
- 望ましいカメラ位置 `desiredPos = playerPos + offset(camYaw,camPitch,camDist)`、望ましい注視点 `desiredTarget = playerPos + headOffset`。
- **スプリング追従**: `camPosCurrent` と `camTargetCurrent` を毎フレーム指数補間（`k = 1 - exp(-follow * dt)`）で `desired` へ。`camera.position = camPosCurrent; camera.lookAt(camTargetCurrent)`。
- 前進方向 `camForward` = `(desiredTarget - desiredPos)` を正規化（3D、ピッチ込み）＝高度移動の素（要件2）。

## 5. 飛行移動
- `playerVel`(Vector3) を加減速。基底ベクトル:
  - `fwd` = カメラ視線方向（3D, 正規化）= 上記 camForward。
  - `right` = `fwd × up` 正規化（水平寄り）。左右平行移動に使用。
- 入力で加速: W/↑ `+fwd`、S/↓ `-fwd`、A/← `-right`、D/→ `+right`（`accel*dt`）。
- 減衰: `playerVel *= exp(-drag*dt)`、`clampSpeed(maxSpeed)`。重力なし。
- `vrm.scene.position += playerVel*dt`。アリーナ内クランプ（壁/天井/床に薄いマージン、反射はなしで停止 or 軽い反発）。
- **体の向き**: 移動入力中（特に前進）、`vrm.scene` の yaw を水平移動方向へ `slerp`/補間で滑らかに向ける（左右移動のみの時はカメラ正面 or 移動方向、実機調整）。

## 6. グラブ / ショット（マウス、目前吸着）
- アンカー `frontAnchor`（ワールド点）= `playerPos + bodyForward * GRAB_FRONT_DIST + up*~0.2`（体の向き前方、胸〜目線の高さ）。
- レイ: 画面中心からカメラレイ（swing-catch `tryGrab` 流用）。対象は浮遊オブジェクトのみ（megu 関連分岐は削除）。
- LMB: `tryGrab`。命中で `grabbed=obj; obj.grabbed=true`。グラブ中は `stepObjects` で対象を `frontAnchor` へバネ吸着（既存 line1104 の `handAnchor` を `frontAnchor` に置換）。`capcher1` ワンショット再生。保持中は移動アニメ `Fly_f2`。
- RMB: `fireProjectile` 改め `shoot()`。保持オブジェクトをカメラ前方へ射出（`vel = camForward * SHOT_SPEED`）。`cas1_L1` 再生。保持していない場合は何もしない（または既存の発射体）。要件はオブジェクト射出が主。
- 旧 `handAnchor`(camera+forward) は `frontAnchor`(player前方) に統一。

## 7. カメラ簡易調整 UI
- 右上に小パネル（プレイ中は隠す/トグル）。スライダー: 距離(camDist) / 高さ(headOffset.y, camPitch初期) / 追従(follow) / FOV / マウス感度。
- `localStorage('tps-cam')` に保存・復元。`bindSlider` 流用。

## 8. ファイル構成 / 変更点
- 追加: `tps-flight/index.html`, `tps-flight/tps-flight.js`。
- 変更: `lib/vrm-cloth.js`（名前付きグループ化・setTimeline）/ `cloth-preview/cloth-preview.js`(+index.html)（vrma 埋め込み）/ `public/timeline/Joy_reborn_*.timeline.json`（vrma バックフィル）/ `hub/index.html`（カード）。
- 既存ゲーム（fps-cloth-vrm/swing-catch）は **lib/vrm-cloth 改修の互換性のみ要確認**（コード変更なし）。

## 9. 主要リスク
- **lib/vrm-cloth 改修の後方互換**（megu の side timeline / legacy indices）。回帰確認必須（swing-catch で megu のマント掴み）。
- WebGPU storage buffer 8本制限（vec4 化で本数増やさない）。
- VRMA のルート移動（hips XZ）と自前移動の二重化 → 必要なら hips の水平成分を抑制。
- VRMA 切替時のポーズ飛び → crossFade で吸収。`idle`/`f2` は仮VRMAなので見た目要確認。
- スペース入り VRMA 名の fetch（encodeURI）。

## 10. 実装順（Stage 5 で詳細タスク化）
1. lib/vrm-cloth 名前付きグループ化＋setTimeline（＋swing-catch回帰確認）。
2. cloth-preview に vrma 埋め込み＋既存timelineバックフィル。
3. tps-flight 雛形（swing-catchから複製→TPS化・NPC除去・飛行移動）。
4. プレイヤー生成＋モーションセット＋状態機械＋cloth連携。
5. TPSカメラ（球面+スプリング）＋簡易UI。
6. グラブ/ショット（前方吸着・射出）。
7. hub 登録・実機調整。
