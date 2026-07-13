// 実道路グラフ（ローカルXZメートル）に沿って Kenney 建物を決定的に配置する純関数ジェネレータ。
// Y は実行時に DEM から与える前提なので、ここでは水平(XZ)のみ扱う。
// ゾーン（中心=八王子原点からの距離）で 家 / 中層ビル / 高層ビル を割り当てる＝「大きさで家かビルか」。
// three 非依存・副作用なし。ブラウザでもプレビュー(node)でも同一結果。関連: lib/city-gen.js

// 決定的PRNG（cellごとに固定シード）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash3(seed, x, y) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 自動配置インスタンスの決定的ID（map-editorの差分編集=removed/movedのキー）。
// 元の自動配置座標から作るので、moved適用「前」に計算すること
export function instanceId(i) {
  return i.kit + '|' + i.model + '|' + Math.round(i.x) + '_' + Math.round(i.z);
}
// ティア別の追加用既定（map-editorの「＋建物」）
export const TIER_INFO = {
  house: { kit: 'suburban', models: () => DEFAULT_MODELS.houses },
  mid: { kit: 'city', models: () => DEFAULT_MODELS.mids },
  tower: { kit: 'city', models: () => DEFAULT_MODELS.towers },
};

const DEFAULT_MODELS = {
  // city kit（外部 colormap 同居必須）: 中心=高層、中間=中層
  towers: ['building-skyscraper-a', 'building-skyscraper-b', 'building-skyscraper-c', 'building-skyscraper-d', 'building-skyscraper-e', 'building-a', 'building-d', 'building-h', 'building-k'],
  mids: ['building-a', 'building-b', 'building-c', 'building-d', 'building-e', 'building-f', 'building-g', 'building-h', 'building-i', 'building-j', 'building-k', 'building-l', 'building-m', 'building-n'],
  // suburban kit: 郊外=住宅
  houses: ['building-type-a', 'building-type-b', 'building-type-c', 'building-type-d', 'building-type-e', 'building-type-f', 'building-type-g', 'building-type-h', 'building-type-i', 'building-type-j', 'building-type-k', 'building-type-l', 'building-type-m', 'building-type-n', 'building-type-o', 'building-type-p', 'building-type-q', 'building-type-r', 'building-type-s', 'building-type-t', 'building-type-u'],
};

const DEFAULTS = {
  seed: 20260706,
  spacing: 15,        // 道路沿いの配置間隔(m)
  cellSize: 6,        // 占有格子(m)。細かめ。フットプリント分をマークして道路/建物同士の重なりを防ぐ
  roadHalfWidth: 6,   // 道路の半幅(m)。この内側には建物を作らない（車道確保）
  margin: 2,          // 道路端から建物までの余白(m)
  maxScale: 1.15,     // 個体差スケールの最大（後退量・占有マークに反映して塞ぎを防ぐ）
  footprint: { tower: 26, mid: 15, house: 10 },   // ランタイム TARGET_FOOT と一致（ゾーン別の実寸フットプリント m）
  downtownR: 500,     // これ以内=高層ビル(ゾーン tower)
  midR: 1100,         // これ以内=中層ビル(ゾーン mid)、外=住宅(house)
  chunkSize: 256,     // ストリーミング用チャンク(m)
  maxPerEdge: 60,     // 長い辺の暴走防止
  models: DEFAULT_MODELS,
};

// (gx,gz) を中心に半径 r セルを占有マーク（フットプリント確保）
function markOccupied(occupied, gx, gz, r) {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) occupied.add((gx + dx) + '_' + (gz + dz));
}

/**
 * @param {Array<[number,number,number,number,number,number]>} edges  [ax,ay,az,bx,by,bz]（ローカルworld m）
 * @param {object} [options]
 * @returns {{ instances: Array, chunkSize:number, zones:{tower:number,mid:number,house:number} }}
 */
export function generateBuildings(edges, options = {}) {
  const o = { ...DEFAULTS, ...options, models: { ...DEFAULT_MODELS, ...(options.models || {}) } };
  const occupied = new Set();          // "cx_cz" 占有格子
  const instances = [];
  const zones = { tower: 0, mid: 0, house: 0 };

  for (const e of edges) {
    const ax = e[0], ay = e[1], az = e[2], bx = e[3], by = e[4], bz = e[5];
    let dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);            // 水平距離
    if (len < o.spacing * 0.5) continue;      // 短すぎる辺は飛ばす
    dx /= len; dz /= len;
    const px = -dz, pz = dx;                   // 道路に垂直な単位ベクトル
    const steps = Math.min(o.maxPerEdge, Math.max(1, Math.round(len / o.spacing)));
    for (let i = 1; i < steps; i++) {          // 端点(交差点)は避けて内側だけ
      const t = i / steps;
      const cx0 = ax + dx * len * t, cz0 = az + dz * len * t;
      const cy0 = ay + (by - ay) * t;          // 地面Y=道路エッジのY補間
      // ゾーン(家/中層/高層)は道路中心点の距離で決定
      const distC = Math.hypot(cx0, cz0);
      let kit, list, tall, tier;
      if (distC < o.downtownR) { kit = 'city'; list = o.models.towers; tall = true; tier = 'tower'; }
      else if (distC < o.midR) { kit = 'city'; list = o.models.mids; tall = true; tier = 'mid'; }
      else { kit = 'suburban'; list = o.models.houses; tall = false; tier = 'house'; }
      const halfMax = o.footprint[tier] * 0.5 * o.maxScale;      // 最大時の半フットプリント
      const setback = o.roadHalfWidth + halfMax + o.margin;      // 中心の後退量＝道路半幅＋建物半分＋余白（車道を塞がない）
      const rCells = Math.max(1, Math.round(halfMax / o.cellSize));
      for (const side of [1, -1]) {
        const x = cx0 + px * side * setback;
        const z = cz0 + pz * side * setback;
        const gx = Math.round(x / o.cellSize), gz = Math.round(z / o.cellSize);
        if (occupied.has(gx + '_' + gz)) continue;   // 中心セルが埋まっていれば重なり回避
        markOccupied(occupied, gx, gz, rCells);      // フットプリント分を占有

        const rng = mulberry32(hash3(o.seed, gx, gz));
        if (tier === 'tower') zones.tower++; else if (tier === 'mid') zones.mid++; else zones.house++;
        const model = list[(rng() * list.length) | 0];
        const s = 0.9 + rng() * 0.25;                // 個体差（0.9〜1.15。maxScaleと整合）
        // 建物正面を道路側へ（垂直ベクトルは道路の外向き→反転して道路を向く）
        const ry = Math.atan2(-px * side, -pz * side);
        instances.push({
          chunk: Math.floor(x / o.chunkSize) + '_' + Math.floor(z / o.chunkSize),
          x, y: cy0, z, ry, kit, model, tier, s, tall,
        });
      }
    }
  }
  return { instances, chunkSize: o.chunkSize, zones };
}

export { DEFAULT_MODELS, DEFAULTS };
