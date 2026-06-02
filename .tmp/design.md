# 設計書 - 3D ストーリー（シナリオ）システム

要件: `.tmp/requirements.md`
対象: story-player / story-editor（新規ページ）＋ 共通 lib

---

## 1. 全体アーキテクチャ

```
  story-editor/  ──┐                         ┌── story-player/
  （編集UI）        │                         │   （薄いラッパ）
        │          ▼                         ▼          │
        │   ┌──────────────────────────────────────┐    │
        └──▶│        lib/story-stage.js            │◀───┘
            │  3Dシーン+カメラ+アクター+UI+runner    │
            └───┬───────────────┬───────────────┬──┘
                ▼               ▼               ▼
      lib/story-runner.js  lib/story-actors.js  lib/speech-ui.js
       （線形実行・3D非依存） （VRMアクター管理）  （流用）
                                    │
                       lib/lip-sync / vrm-cloth / vrm-ragdoll（流用）
```

設計方針:
- **story-stage が「再生エンジン」**。player と editor のプレビューは同じ story-stage を使い、エンジンを二重実装しない。
- runner は 3D 非依存（hooks 注入）。アクター・カメラ・UI 操作は story-stage が hooks 実装として注入。
- op パラメータ定義は `lib/story-ops.js` に集約し、エディタのフォームを**データ駆動**で生成（NFR-03）。

---

## 2. 新規/変更ファイル

| 種別 | パス | 内容 |
|------|------|------|
| 新規 | `lib/story-runner.js` | 線形スクリプト実行（pc 管理・blocking/await・stop） |
| 新規 | `lib/story-actors.js` | VRM アクター管理（show/move/anim/face/expression/ragdoll/speak/update） |
| 新規 | `lib/story-ops.js` | op 定義（種別・フィールド・既定値）。runner と editor が参照 |
| 新規 | `lib/story-stage.js` | 再生エンジン（scene/camera/actors/speech-ui/runner を統合・hooks 実装） |
| 新規 | `story-player/index.html` `story-player.js` | 再生ページ（story-stage の薄いラッパ） |
| 新規 | `story-editor/index.html` `story-editor.js` | コマンド編集UI＋埋め込みプレビュー |
| 変更 | `vite.config.ts` | save 許可 dir に `story` 追加、`/story/manifest.json` 配信 |
| 新規(任意) | `public/story/` | `*.story.json` 保存先（実行時生成） |

---

## 3. lib/story-ops.js（op スキーマ・データ駆動の核）

各 op の表示名・フィールド・既定値・同期種別を定義。editor のフォーム生成、既定値補完、検証に使う。

```js
// fieldType: 'text'|'number'|'vec3'|'bool'|'lines'|'actorRef'|'npcRef'|'vrmaRef'|'stageRef'|'expr'|'select'
export const STORY_OPS = {
  'say':            { label: 'セリフ', blocking: true,  fields: [
      { key:'actor', type:'actorRef' }, { key:'lines', type:'lines' }, { key:'cps', type:'number', def:8 } ] },
  'wait':           { label: 'クリック待ち', blocking: true, fields: [] },
  'actor.show':     { label: '登場', fields: [
      { key:'id', type:'actorRef' }, { key:'x', type:'number', def:0 }, { key:'y', type:'number', def:0 },
      { key:'z', type:'number', def:0 }, { key:'ry', type:'number', def:0 }, { key:'scale', type:'number', def:1 } ] },
  'actor.hide':     { label: '退場', fields: [ { key:'id', type:'actorRef' }, { key:'fade', type:'number', def:300 } ] },
  'actor.move':     { label: '移動', fields: [
      { key:'id', type:'actorRef' }, { key:'x', type:'number' }, { key:'z', type:'number' },
      { key:'duration', type:'number', def:1000 }, { key:'wait', type:'bool', def:true } ] },
  'actor.face':     { label: '向く', fields: [ { key:'id', type:'actorRef' }, { key:'target', type:'text', def:'camera' } ] },
  'actor.anim':     { label: 'モーション', fields: [
      { key:'id', type:'actorRef' }, { key:'vrma', type:'vrmaRef' }, { key:'loop', type:'bool', def:false }, { key:'wait', type:'bool', def:false } ] },
  'actor.expression':{ label: '表情', fields: [
      { key:'id', type:'actorRef' }, { key:'expression', type:'expr' }, { key:'weight', type:'number', def:1 }, { key:'duration', type:'number', def:300 } ] },
  'actor.ragdoll':  { label: '崩れ', fields: [ { key:'id', type:'actorRef' }, { key:'active', type:'bool', def:true } ] },
  'camera':         { label: 'カメラ', fields: [
      { key:'pos', type:'vec3' }, { key:'target', type:'vec3' }, { key:'duration', type:'number', def:1000 }, { key:'wait', type:'bool', def:false } ] },
  'stage':          { label: 'ステージ', fields: [ { key:'name', type:'stageRef', def:'stage.json' } ] },
  'bg':             { label: '背景', fields: [ { key:'color', type:'text' } ] },
  'bgm.play':       { label: 'BGM再生', fields: [ { key:'name', type:'text' }, { key:'loop', type:'bool', def:true }, { key:'volume', type:'number', def:0.6 } ] },
  'bgm.stop':       { label: 'BGM停止', fields: [ { key:'fade', type:'number', def:500 } ] },
  'se':             { label: 'SE', fields: [ { key:'name', type:'text' }, { key:'volume', type:'number', def:1 } ] },
  'delay':          { label: 'ウェイト', blocking: true, fields: [ { key:'duration', type:'number', def:500 } ] },
  'fade.in':        { label: 'フェードイン', blocking: true, fields: [ { key:'color', type:'text', def:'#000' }, { key:'duration', type:'number', def:500 } ] },
  'fade.out':       { label: 'フェードアウト', blocking: true, fields: [ { key:'color', type:'text', def:'#000' }, { key:'duration', type:'number', def:500 } ] },
  'end':            { label: '終了', fields: [] },
};
export const OP_ORDER = Object.keys(STORY_OPS);
```

---

## 4. lib/story-runner.js（線形実行・3D非依存）

```js
export function createStoryRunner(script, hooks) {
  let pc = 0, stopped = false, running = false;

  function isBlocking(op, def) { return !!(def && def.blocking) || op.wait === true; }

  async function run(fromPc = 0) {
    pc = fromPc; stopped = false; running = true;
    while (pc < script.length && !stopped) {
      const op = script[pc++];
      const def = hooks._ops ? hooks._ops[op.op] : null;   // STORY_OPS 注入（blocking 判定用）
      const fn = hooks[op.op];
      if (typeof fn !== 'function') { console.warn('[story] unknown op:', op.op); continue; }
      try {
        const p = fn(op);                       // Promise | void
        if (isBlocking(op, def)) await p;        // blocking or wait:true は完了待ち
      } catch (e) { console.warn('[story] op failed:', op.op, e); }
      if (op.op === 'end') break;
    }
    running = false;
  }

  return {
    run,
    stop() { stopped = true; },
    get pc() { return pc; },
    get running() { return running; },
  };
}
```

- 同期判定: STORY_OPS の `blocking` または op に `wait:true`。
- ノンブロッキング op は `fn(op)` を呼ぶだけ（tween は story-actors / camera が毎フレーム進める）。
- 未知 op はスキップ（FR-01-2 / NFR-04）。

---

## 5. lib/story-actors.js（VRM アクター管理）

```js
import { createLipSync } from './lip-sync.js';
import { createVRMCloth } from './vrm-cloth.js';
import { createRagdoll, setRagdollActive, updateRagdoll } from './vrm-ragdoll.js';

export function createActorManager({ THREE, scene, renderer, loaders }) {
  const actors = new Map();   // id -> actor
  // actor = { id, vrm, mixer, action, cloth, ragdoll, lip, displayName,
  //           pos, ry, move:null, face:null, expr:{}, exprTween:null, tlFps, tlDuration, tlClock }

  return {
    async show(id, npcFileOrBundle, tr) { /* fetch npc.json→VRM/cloth/ragdoll/lip 生成, 位置設定 */ },
    hide(id, fade) { /* フェードして scene から除去 */ },
    move(id, x, z, duration, opts) { /* tween 設定。Promise を返す（wait用） */ },
    face(id, target /* 'camera'|actorId|[x,z] */) { /* 目標ヨーへ補間 */ },
    async anim(id, vrmaFile, loop) { /* public/vrma 読込→crossFade。Promise（1周）返す */ },
    expression(id, name, weight, duration) { /* exprTween で補間設定 */ },
    ragdoll(id, active) { setRagdollActive(...) },
    speak(id, text, cps, exprName, exprWeight) { /* lip.play + 行表情。Promise は player 側でクリック制御 */ },
    get(id) { return actors.get(id); },
    headWorldPos(id, out) { /* 頭ボーン+offset のワールド座標（吹き出し投影用） */ },
    update(dt, camera) {
      // 各 actor: move tween → pos 補間, face tween → ry 補間, mixer.update, expr 適用(state表情なし),
      //           lip.update, vrm.update, cloth.update, ragdoll（active時）
    },
    clear() { /* 全 actor 破棄 */ },
  };
}
```

要点:
- VRM/VRMA 読込は swing-catch/character-editor と同じ手順（`GLTFLoader`+`VRMLoaderPlugin` / `VRMAnimationLoaderPlugin`+`createVRMAnimationClip`）。npc.json の vrm/vrma は data URI、外部 VRMA は URL。
- `move`: pos を線形/easeInOut 補間。進行方向へ ry も向ける（face='move'）。
- `anim`: 既存 action を fadeOut、新規 action を fadeIn。`loop=false` は LoopOnce + clampWhenFinished。
- `expression`: state を持たないので直接 expressionManager に補間適用（lip の viseme と別チャンネル）。
- `speak`: lip-sync 駆動（口パク）＋行表情。テキスト送り表示は speech-ui（player が担当）。

---

## 6. lib/story-stage.js（再生エンジン・player/editor 共用）

```js
export async function createStoryStage({ container, mode }) {
  // mode: 'play' | 'edit'（edit はプレビュー用。両者ほぼ共通）
  // 1. WebGPURenderer + scene(sky/floor/lights, swing-catch init を簡略移植) + camera
  // 2. actorManager = createActorManager({...})
  // 3. speechUI = createSpeechUI({ dom: container })
  // 4. cameraTween（pos/target を duration 補間、Promise 返す moveTo）
  // 5. fadeOverlay（DOM 黒幕、in/out Promise）
  // 6. audio（BGM/SE。HTMLAudio。無ければ無音継続）
  // 7. stageLoader（stage.json の GLB 配置。swing-catch loadStage を流用移植）

  // hooks（runner へ注入）:
  const hooks = {
    _ops: STORY_OPS,
    'say': (op) => sayFlow(op),              // ↓ §7
    'actor.show': (op) => actorManager.show(op.id, resolveNpc(op.id), op),
    'actor.hide': (op) => actorManager.hide(op.id, op.fade),
    'actor.move': (op) => actorManager.move(op.id, op.x, op.z, op.duration, op),
    'actor.face': (op) => actorManager.face(op.id, op.target),
    'actor.anim': (op) => actorManager.anim(op.id, op.vrma, op.loop),
    'actor.expression': (op) => actorManager.expression(op.id, op.expression, op.weight, op.duration),
    'actor.ragdoll': (op) => actorManager.ragdoll(op.id, op.active),
    'camera': (op) => cameraTween.moveTo(op.pos, op.target, op.duration),
    'stage': (op) => stageLoader.load(op.name),
    'bg': (op) => setBackground(op),
    'bgm.play': (op) => audio.bgm(op),
    'bgm.stop': (op) => audio.bgmStop(op.fade),
    'se': (op) => audio.se(op),
    'delay': (op) => wait(op.duration),
    'fade.in': (op) => fadeOverlay.in(op),
    'fade.out': (op) => fadeOverlay.out(op),
    'end': () => { onEnd && onEnd(); },
  };

  function loadStory(json) { /* actors 宣言を保持、script を runner へ */ }
  function play(fromPc=0) { runner = createStoryRunner(story.script, hooks); return runner.run(fromPc); }
  function stop() { runner && runner.stop(); }

  // 毎フレーム
  renderer.setAnimationLoop(() => {
    const dt = Math.min(timer.getDelta(), 1/30);
    actorManager.update(dt, camera);
    cameraTween.update(dt);
    speechUI.update(dt, (actor)=> projectHead(actor));   // 頭上吹き出し
    renderer.render(scene, camera);
  });

  return { loadStory, play, stop, actorManager, camera, dispose, setOnEnd };
}
```

`actors` 宣言の解決: story.actors の `{id, npc}` を保持し、`actor.show` で `id` から npc ファイルを引く（show に npc 明示があればそれを優先）。

---

## 7. say フロー（クリック送り・口パク・UI）

```
sayFlow(op):
  actor = actorManager.get(op.actor)
  for each line in normalize(op.lines):     // 文字列 or {text,expression,weight}
    speechUI.showBottom(actor.displayName, line.text, cps)   // 下部ウィンドウ
    speechUI.setBubble(actor, line.text, cps)                // 頭上吹き出し
    actorManager.speak(op.actor, line.text, cps, line.expression, line.weight)  // 口パク＋表情
    await waitForAdvance()    // クリック/Space。タイピング途中なら一気に全文表示→次クリックで送り
  return
```

- `waitForAdvance`: player はクリック/Space リスナでキューを resolve。
- editor プレビューでも同じ（プレビュー領域クリックで送り）。

---

## 8. story-player/（薄いラッパ）

- `index.html`: `#app`（3D）, `#story-select`（public/story 一覧）, ローディング/エラー表示, ← hub 戻り。
- `story-player.js`: `createStoryStage({container:'#app', mode:'play'})` → `/story/manifest.json` で一覧 → 選択 or URL の `?id=` で `*.story.json` 取得 → `loadStory` → クリックで `play()`。`end` でセレクトへ戻す。

## 9. story-editor/（編集UI＋プレビュー）

レイアウト（他エディタと同系統の3カラム）:
```
┌ topbar: story選択 / 新規 / 保存 / タイトル・stage 設定 ┐
├ left: コマンドリスト ──┬ center: 3Dプレビュー ──┬ right: 選択コマンドのパラメータ ┐
│  [#] op ラベル 要約    │ (story-stage mode:edit) │  op別フォーム(STORY_OPS駆動)     │
│  ▲▼ 並べ替え / ✕削除   │ ▶最初から / ▶ここから    │  actorRef/vrmaRef等は一覧selectで │
│  ＋ コマンド追加(op選択)│ / ⏹停止                 │                               │
│  ── アクター一覧 ──    │                         │                               │
│  id ↔ npc.json select  │                         │                               │
└────────────────────────┴─────────────────────────┴───────────────────────────────┘
```

- コマンドリスト: `script[]` を行表示。行クリックで選択→右にフォーム。`▲▼` で入れ替え、`✕` 削除、`＋` で op ピッカーから追加（既定値は STORY_OPS の def）。
- パラメータフォーム: 選択行の op を STORY_OPS から引き、field.type で入力UIを生成:
  - `actorRef`→story.actors の id セレクト / `npcRef`→`/npc/manifest.json` / `vrmaRef`→`/vrma/manifest.json` / `stageRef`→`/models/manifest.json` / `expr`→表情プリセット / `vec3`→数値3 / `lines`→複数行＋行ごと表情 / それ以外は text/number/bool。
- アクター一覧: story.actors を編集（id 入力＋ npc セレクト）。
- プレビュー: 埋め込み story-stage(mode:edit)。`▶ここから`=選択行 pc から play、`▶最初から`=0 から、`⏹`=stop。編集中の `story` オブジェクトをそのまま loadStory。
- 保存/読込: `POST ../api/save {dir:'story', filename:'<id>.story.json', content}`。`/story/manifest.json` で一覧、選択で取得し編集。

## 10. vite.config.ts 変更

```ts
const allowed = { npc:'npc', timeline:'timeline', models:'models', story:'story' };  // story 追加
// 追加ミドルウェア（npc manifest と同型）:
server.middlewares.use((req,res,next)=>{
  if (!url.endsWith('/story/manifest.json')) return next();
  const dir = path.join(pub,'story');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f=>f.endsWith('.story.json')) : [];
  res.end(JSON.stringify(files));
});
// ビルド時 manifest 生成対象にも story を追加（任意）
```

---

## 11. 定数（ハードコード回避）

| 定数 | 値 | 場所 |
|------|----|------|
| DEFAULT_CPS | 8 | story-actors / sayFlow |
| MOVE_EASE | easeInOut | story-actors |
| ANIM_CROSSFADE | 0.3s | story-actors |
| CAMERA_EASE | easeInOut | story-stage(cameraTween) |
| FADE_DEFAULT_MS | 500 | story-stage(fadeOverlay) |
| FLOOR/ SKY 設定 | swing-catch 準拠 | story-stage |

---

## 12. エッジケース・後方互換

- 未知 op / 欠損パラメータ → スキップ＋警告、再生継続（NFR-04）。
- actor.show 前に say/move 等で未登場 id 参照 → 警告しスキップ。
- viseme 非対応 VRM → 口パク無効・表情/UI は機能（lip-sync の既存仕様）。
- stage 無し → 床＋空のみ。BGM/SE 音源無し → 無音で継続。
- WebGPU 非対応 → 警告表示し再生不可（他ページと同様）。
- editor プレビューと player は同一 story-stage を使うため挙動一致。

---

## 13. 実装順序（タスクは tasks.md）

1. lib/story-ops.js（スキーマ）→ lib/story-runner.js（実行）
2. lib/story-actors.js（VRM・流用lib結線）
3. lib/story-stage.js（エンジン統合・hooks）
4. story-player/（再生確認）→ サンプル story.json で動作確認
5. story-editor/（編集UI＋プレビュー）
6. vite.config.ts（story 保存・一覧）
