// story-ops.js — ストーリー op（コマンド）のスキーマ定義（素JS・3D非依存）
// 設計: .tmp/design.md §3
//
// 各 op の表示名・同期種別(blocking)・編集フィールドと既定値を定義する。
// story-runner は blocking 判定に、story-editor はフォーム生成・既定値補完に使う。
//
// fieldType:
//   'text' | 'number' | 'bool' | 'vec3' | 'lines'
//   'actorRef'(story.actors の id) | 'npcRef'(/npc) | 'vrmaRef'(/vrma) | 'stageRef'(/models)
//   'expr'(表情プリセット) | 'select'(options 指定)

export const EXPR_PRESETS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

export const STORY_OPS = {
  'say':             { label: 'セリフ',       blocking: true, fields: [
    { key: 'actor', type: 'actorRef' },
    { key: 'lines', type: 'lines' },
    { key: 'cps',   type: 'number', def: 8 },
  ] },
  'wait':            { label: 'クリック待ち', blocking: true, fields: [] },
  'actor.show':      { label: '登場',         fields: [
    { key: 'id',    type: 'actorRef' },
    { key: 'x',     type: 'number', def: 0 },
    { key: 'y',     type: 'number', def: 0 },
    { key: 'z',     type: 'number', def: 0 },
    { key: 'ry',    type: 'number', def: 0 },
    { key: 'scale', type: 'number', def: 1 },
    { key: 'fade',  type: 'number', def: 300 },
  ] },
  'actor.hide':      { label: '退場',         fields: [
    { key: 'id',   type: 'actorRef' },
    { key: 'fade', type: 'number', def: 300 },
  ] },
  'actor.move':      { label: '移動',         fields: [
    { key: 'id',       type: 'actorRef' },
    { key: 'x',        type: 'number', def: 0 },
    { key: 'z',        type: 'number', def: 0 },
    { key: 'duration', type: 'number', def: 1000 },
    { key: 'face',     type: 'bool',   def: true },
    { key: 'wait',     type: 'bool',   def: true },
  ] },
  'actor.face':      { label: '向く',         fields: [
    { key: 'id',     type: 'actorRef' },
    { key: 'target', type: 'text', def: 'camera' },   // 'camera' | actorId | 'x,z'
  ] },
  'actor.anim':      { label: 'モーション',   fields: [
    { key: 'id',   type: 'actorRef' },
    { key: 'vrma', type: 'vrmaRef' },
    { key: 'loop', type: 'bool', def: false },
    { key: 'wait', type: 'bool', def: false },
  ] },
  'actor.expression':{ label: '表情',         fields: [
    { key: 'id',         type: 'actorRef' },
    { key: 'expression', type: 'expr' },
    { key: 'weight',     type: 'number', def: 1 },
    { key: 'duration',   type: 'number', def: 300 },
  ] },
  'actor.ragdoll':   { label: '崩れ',         fields: [
    { key: 'id',     type: 'actorRef' },
    { key: 'active', type: 'bool', def: true },
  ] },
  'camera':          { label: 'カメラ',       fields: [
    { key: 'pos',      type: 'vec3', def: [0, 1.4, 3] },
    { key: 'target',   type: 'vec3', def: [0, 1.2, 0] },
    { key: 'duration', type: 'number', def: 1000 },
    { key: 'wait',     type: 'bool',   def: false },
  ] },
  'stage':           { label: 'ステージ',     fields: [
    { key: 'name', type: 'stageRef', def: 'stage.json' },
  ] },
  'bg':              { label: '背景',         fields: [
    { key: 'color', type: 'text', def: '#bcd8ef' },
  ] },
  'bgm.play':        { label: 'BGM再生',      fields: [
    { key: 'name',   type: 'text' },
    { key: 'loop',   type: 'bool',   def: true },
    { key: 'volume', type: 'number', def: 0.6 },
  ] },
  'bgm.stop':        { label: 'BGM停止',      fields: [
    { key: 'fade', type: 'number', def: 500 },
  ] },
  'se':              { label: 'SE',           fields: [
    { key: 'name',   type: 'text' },
    { key: 'volume', type: 'number', def: 1 },
  ] },
  'delay':           { label: 'ウェイト',     blocking: true, fields: [
    { key: 'duration', type: 'number', def: 500 },
  ] },
  'fade.in':         { label: 'フェードイン', blocking: true, fields: [
    { key: 'color',    type: 'text',   def: '#000' },
    { key: 'duration', type: 'number', def: 500 },
  ] },
  'fade.out':        { label: 'フェードアウト', blocking: true, fields: [
    { key: 'color',    type: 'text',   def: '#000' },
    { key: 'duration', type: 'number', def: 500 },
  ] },
  'end':             { label: '終了',         fields: [] },
};

export const OP_ORDER = Object.keys(STORY_OPS);

// op を1つ、既定値で生成する（editor の追加用）
export function makeOp(opName) {
  const def = STORY_OPS[opName];
  const op = { op: opName };
  if (def) for (const f of def.fields) if (f.def !== undefined) op[f.key] = cloneDef(f.def);
  return op;
}

// 欠損フィールドを既定値で補完したコピーを返す（runner/stage の安全用）
export function applyDefaults(op) {
  const def = STORY_OPS[op.op];
  if (!def) return { ...op };
  const out = { ...op };
  for (const f of def.fields) {
    if (out[f.key] === undefined && f.def !== undefined) out[f.key] = cloneDef(f.def);
  }
  return out;
}

export function isBlocking(op) {
  const def = STORY_OPS[op.op];
  return !!(def && def.blocking) || op.wait === true;
}

function cloneDef(v) { return Array.isArray(v) ? v.slice() : v; }
