// grab-shapes.js — 掴み対象プロップの形状定義。
// City-Fly 本編（チュートリアルのグラブ訓練）と grab-editor が共有する単一の情報源。
// ここを直せば本編の見た目・当たり判定・エディタの表示がまとめて追従する。
//   box: [幅X, 高Y, 奥Z] / cyl: [半径, 高さ, 分割] / glb: モデル相対パス（fitX=長軸の実寸m）
// ジオメトリは「底面 y=0・XZ中心」に正規化して返す（本編の配置がこの前提）。

export const GRAB_SHAPES = {
  crate:     { label: '木箱',       mass: 1.2, color: 0xc9a860, box: [4, 4, 4] },
  block:     { label: 'ブロック',   mass: 2,   color: 0x7fa6c9, box: [6.5, 3.2, 5] },
  pillar:    { label: '柱',         mass: 12,  color: 0x9a90c9, cyl: [5, 28, 12] },
  beam:      { label: '梁',         mass: 32,  color: 0x8891a5, box: [55, 8, 10] },
  container: { label: 'コンテナ',   mass: 3,   color: 0xffffff, glb: 'waterfront_GLB format/cargo-container-a.glb', fitX: 6.2 },
};

export function makeGrabGeo(THREE, kind) {   // 基本図形のジオメトリ（GLBはnull＝呼び出し側でロード）
  const d = GRAB_SHAPES[kind];
  if (!d) return null;
  let g = null;
  if (d.box) { g = new THREE.BoxGeometry(d.box[0], d.box[1], d.box[2]); g.translate(0, d.box[1] / 2, 0); }
  else if (d.cyl) { g = new THREE.CylinderGeometry(d.cyl[0], d.cyl[0], d.cyl[1], d.cyl[2]); g.translate(0, d.cyl[1] / 2, 0); }
  return g;
}

// ジオメトリ実寸 → 当たり判定OBB（ローカルの中心と半寸法）。本編・エディタで同じ既定値になる
export function fitHitBox(THREE, geo) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  return { c: bb.getCenter(new THREE.Vector3()), h: bb.getSize(new THREE.Vector3()).multiplyScalar(0.5) };
}
