// story-runner.js — ストーリーの線形スクリプトを実行する（素JS・3D非依存）
// 設計: .tmp/design.md §4
//
// op を pc（プログラムカウンタ）順に1つずつ実行する。各 op は hooks[op.op](op) を呼び、
// blocking（say/wait/delay/fade 等）または op.wait===true のときは Promise の完了を待つ。
// ノンブロッキング op は開始のみ（移動・カメラ等の補間は呼び出し側が毎フレーム進める）。
//
// 使い方:
//   const runner = createStoryRunner(script, hooks);
//   await runner.run(0);       // 先頭から再生（任意 pc から開始可）
//   runner.stop();             // 中断

import { isBlocking, applyDefaults } from './story-ops.js';

export function createStoryRunner(script, hooks) {
  let pc = 0;
  let stopped = false;
  let running = false;

  async function run(fromPc = 0) {
    pc = fromPc;
    stopped = false;
    running = true;
    while (pc < script.length && !stopped) {
      const raw = script[pc];
      pc++;
      const op = applyDefaults(raw);
      const fn = hooks[op.op];
      if (typeof fn !== 'function') { console.warn('[story] 未知の op をスキップ:', op.op); continue; }
      try {
        const p = fn(op);
        if (isBlocking(op)) await p;          // blocking / wait:true は完了待ち
      } catch (e) {
        console.warn('[story] op の実行に失敗（継続）:', op.op, e);
      }
      if (stopped) break;
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
