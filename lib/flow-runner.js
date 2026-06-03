// flow-runner.js — ゲームフローのノードグラフ走査（素JS・3D非依存）
// 設計: .tmp/design.md §3
//
// nodes/edges のグラフを保持し、現在ノードと「出力ポート」から次ノードを解決する。
// 実行（ストーリー再生・戦闘）は flow-player が iframe で担当し、結果(port)をここに渡す。
//
// 使い方:
//   const flow = createFlow(flowJson);
//   let node = flow.getStart();
//   // story/start 完了 → node = flow.next(node.id, 'next')
//   // battle 終了    → node = flow.next(node.id, result /* 'win'|'lose' */)
//   // node === null でフロー終了

export const NODE_TYPES = {
  start:  { label: '開始',       ports: ['next'] },
  story:  { label: 'ストーリー', ports: ['next'] },
  battle: { label: '戦闘',       ports: ['win', 'lose'] },
  end:    { label: '終了',       ports: [] },
};

export const WIN_TYPES = {
  defeatCount: { label: '撃破累計', fields: [{ key: 'count', type: 'number', def: 5 }] },
  // 将来: bossHp など
};

export const LOSE_TYPES = {
  playerHp: { label: 'プレイヤーHP', fields: [{ key: 'hp', type: 'number', def: 5 }] },
  // 将来: timeout など
};

export function nodePorts(type) {
  const d = NODE_TYPES[type];
  return d ? d.ports : [];
}

export function createFlow(flow) {
  const f = flow || {};
  const nodes = Array.isArray(f.nodes) ? f.nodes : [];
  const edges = Array.isArray(f.edges) ? f.edges : [];
  const byId = new Map(nodes.map(n => [n.id, n]));

  function getStart() {
    if (f.start && byId.has(f.start)) return byId.get(f.start);
    return nodes.find(n => n.type === 'start') || nodes[0] || null;
  }
  function getNode(id) { return byId.get(id) || null; }
  function next(nodeId, port) {
    const e = edges.find(e => e.from === nodeId && e.fromPort === port);
    if (!e) return null;
    const t = byId.get(e.to);
    if (!t) { console.warn('[flow] エッジ先ノードが見つかりません:', e.to); return null; }
    return t;
  }

  return { getStart, getNode, next, nodes, edges };
}
