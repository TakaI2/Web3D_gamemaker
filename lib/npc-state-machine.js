// npc-state-machine.js — NPC ステートマシン（フレームワーク非依存・副作用なしの素JSコア）
// 設計: .tmp/character_editor_design.md
//
// 状態: idle / alert / attack / downed / recovering
// downed/recovering はラグドールの状態（ctx.ragdollActive / ragdollRecovering）に従属。
// idle/alert/attack は behavior（検知距離・攻撃性）に基づき遷移。
//
// 使い方:
//   const sm = createNpcStateMachine(bundle.character);   // character 省略可（既定で後方互換＝検知無効）
//   const dir = sm.update(dt, { ragdollActive, ragdollRecovering, held, distanceToPlayer });
//   // dir = { state, expression:{name->weight}, lookAtEye:0-1, lookAtHead:0-1, attacking:bool }
//   // 呼び出し側が dir に従い setRagdoll / expressionManager / lookAt / 速度 を制御する（副作用は持たせない）

const DEFAULT_BEHAVIOR = {
  aggressiveOnRecover: false,
  sightRange:   0,     // 0 = 検知無効（idle/downed/recovering のみ＝既存挙動）
  loseRange:    14,
  detectChance: 0.6,   // idle→alert 判定確率（毎秒あたり）
  approachAccel: 5,    // attack 時の接近加速度
  recoverDelaySec: 2.5,
};

// 状態既定値。lookAtEye/Head は 0-1（視線=目 / 顔=頭 のプレイヤー追従強度）。
const DEFAULT_STATES = {
  idle:       { expression: {},                 lookAtEye: 1.0, lookAtHead: 0.0, durationSec: 0 },
  alert:      { expression: { surprised: 0.8 }, lookAtEye: 1.0, lookAtHead: 0.6, durationSec: 0.6 },
  attack:     { expression: { angry: 1.0 },     lookAtEye: 1.0, lookAtHead: 0.8, durationSec: 3.0 },
  downed:     { expression: { sad: 0.4 },       lookAtEye: 0.0, lookAtHead: 0.0, durationSec: 0 },
  recovering: { expression: {},                 lookAtEye: 1.0, lookAtHead: 0.3, durationSec: 0 },
};

function mergeStates(custom) {
  const out = {};
  for (const k of Object.keys(DEFAULT_STATES)) {
    out[k] = Object.assign({}, DEFAULT_STATES[k], custom && custom[k]);
  }
  return out;
}

export function createNpcStateMachine(characterDef) {
  const behavior = Object.assign({}, DEFAULT_BEHAVIOR, characterDef && characterDef.behavior);
  const states   = mergeStates(characterDef && characterDef.states);

  const sm = {
    state: (characterDef && characterDef.defaultState) || 'idle',
    timer: 0,
    behavior,
    states,
    // 全状態で使う表情名の和集合（呼び出し側が「使わない表情を0に戻す」のに使う）
    expressionNames: collectExpressionNames(states),
  };

  sm.update = (dt, ctx) => update(sm, dt, ctx || {});
  return sm;
}

function collectExpressionNames(states) {
  const set = new Set();
  for (const k of Object.keys(states)) {
    const e = states[k].expression || {};
    for (const name of Object.keys(e)) set.add(name);
  }
  return [...set];
}

function update(sm, dt, ctx) {
  const b = sm.behavior;

  // ラグドール状態が最優先（被弾/掴み/落下=downed、復帰補間=recovering）
  if (ctx.ragdollActive) {
    sm.state = 'downed';
  } else if (ctx.ragdollRecovering) {
    sm.state = 'recovering';
  } else {
    // 非ラグドール（idle/alert/attack）
    if (sm.state === 'downed' || sm.state === 'recovering') {
      // 復帰完了 → 攻撃性に応じて attack か idle へ
      sm.state = b.aggressiveOnRecover ? 'attack' : 'idle';
      sm.timer = sm.states[sm.state].durationSec || 0;
    }
    const dist = ctx.distanceToPlayer != null ? ctx.distanceToPlayer : Infinity;
    if (sm.state === 'idle') {
      if (b.sightRange > 0 && dist < b.sightRange && Math.random() < b.detectChance * dt) {
        sm.state = 'alert';
        sm.timer = sm.states.alert.durationSec || 0.6;
      }
    } else if (sm.state === 'alert') {
      sm.timer -= dt;
      if (sm.timer <= 0) { sm.state = 'attack'; sm.timer = sm.states.attack.durationSec || 3.0; }
    } else if (sm.state === 'attack') {
      sm.timer -= dt;
      if (sm.timer <= 0 || dist > b.loseRange) { sm.state = 'idle'; sm.timer = 0; }
    }
  }

  const st = sm.states[sm.state] || {};
  return {
    state:      sm.state,
    expression: st.expression || {},
    lookAtEye:  st.lookAtEye != null ? st.lookAtEye : 0,
    lookAtHead: st.lookAtHead != null ? st.lookAtHead : 0,
    attacking:  sm.state === 'attack',
  };
}
