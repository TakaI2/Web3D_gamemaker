// jet-shapes.js — 旧戦闘機（手続き生成）の形状定義。city-fly.js と paint-editor.js で共有する
// （grab-shapes.js と同じ流儀。エディタのプレビューと実際のゲーム描画を確実に一致させるため）。
// 色は3系統のみ: 本体(body)・アクセント(accent)・コクピット発光(glow)。

export const JET_DEFAULT_COLORS = { body: '#16121e', accent: '#5b2fa8', glow: '#9a5cff' };

// dim(): glowスロットは「暗い地色+明るい発光」の2値をユーザーには1色として見せるため、
// pickした色を暗くしたものをベース色、そのままを発光色に使う
function dim(hex, k) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return (r << 16) | (g << 8) | b;
}

// THREE: 呼び出し側のTHREE名前空間（CDN版/コア版どちらでも可）を渡す
// colors: { body, accent, glow }（省略時 JET_DEFAULT_COLORS）
// 戻り値: { group, materials:{mBody,mAcc,mGlow} }（materialsは被弾フラッシュ等で使い回すため公開）
export function buildLegacyJet(THREE, colors = JET_DEFAULT_COLORS) {
  const g = new THREE.Group();
  const mBody = new THREE.MeshStandardMaterial({ color: colors.body, metalness: 0.7, roughness: 0.35 });
  const mAcc = new THREE.MeshStandardMaterial({ color: colors.accent, metalness: 0.6, roughness: 0.4 });
  const mGlow = new THREE.MeshStandardMaterial({ color: dim(colors.glow, 0.35), emissive: colors.glow, emissiveIntensity: 2.2 });
  const fus = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.3, 10), mBody); g.add(fus);            // 胴体（機首=+Z）
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.85, 3.2, 8), mBody);
  nose.rotation.x = Math.PI / 2; nose.position.z = 6.5; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), mGlow);
  canopy.scale.set(0.8, 0.6, 1.6); canopy.position.set(0, 0.7, 2.6); g.add(canopy);
  for (const sgn of [-1, 1]) {   // 後退翼＋垂直尾翼
    const wing = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.16, 3.2), mAcc);
    wing.position.set(sgn * 3.1, 0, -1.2); wing.rotation.y = sgn * 0.55; g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.9, 1.7), mAcc);
    tail.position.set(sgn * 0.9, 1.1, -4.4); tail.rotation.z = sgn * -0.35; g.add(tail);
  }
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 1.2, 10), mGlow);
  engine.rotation.x = Math.PI / 2; engine.position.z = -5.2; g.add(engine);
  return { group: g, materials: { mBody, mAcc, mGlow } };
}
