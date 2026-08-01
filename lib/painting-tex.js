// painting-tex.js — 絵画用の手続き生成テクスチャ（canvas）。
// 将来エディタから差し替えられるよう、URL指定があればそれを優先して読む設計にしてある。
//   const tex = makePaintingTexture(THREE, { id: 3, url: null });
// url を与えると画像を読み込み、無ければ id から決定的に「肖像画/風景画/抽象画」を生成する。

function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function drawPortrait(ctx, w, h, r) {
  // 暗い背景＋人影のシルエット（お屋敷の肖像画風）
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${20 + r() * 30}, 25%, ${12 + r() * 8}%)`);
  g.addColorStop(1, `hsl(${20 + r() * 30}, 20%, 5%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const cx = w / 2, sk = `hsl(${25 + r() * 15}, ${25 + r() * 20}%, ${45 + r() * 20}%)`;
  ctx.fillStyle = `hsl(${r() * 360}, ${20 + r() * 30}%, ${15 + r() * 15}%)`;   // 服
  ctx.beginPath(); ctx.moveTo(cx - w * 0.34, h); ctx.quadraticCurveTo(cx, h * 0.52, cx + w * 0.34, h); ctx.fill();
  ctx.fillStyle = sk;                                                          // 顔
  ctx.beginPath(); ctx.ellipse(cx, h * 0.42, w * 0.13, h * 0.17, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `hsl(${20 + r() * 25}, 30%, ${8 + r() * 12}%)`;              // 髪
  ctx.beginPath(); ctx.ellipse(cx, h * 0.33, w * 0.16, h * 0.13, 0, Math.PI, Math.PI * 2); ctx.fill();
}

function drawLandscape(ctx, w, h, r) {
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, `hsl(${200 + r() * 30}, 35%, ${30 + r() * 20}%)`);
  sky.addColorStop(1, `hsl(${30 + r() * 20}, 40%, ${45 + r() * 15}%)`);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  for (let layer = 0; layer < 3; layer++) {   // 遠景の山並み
    ctx.fillStyle = `hsl(${140 + r() * 60}, ${15 + layer * 8}%, ${12 + layer * 9}%)`;
    ctx.beginPath(); ctx.moveTo(0, h);
    const baseY = h * (0.45 + layer * 0.12);
    for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, baseY + (r() - 0.5) * h * 0.16);
    ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
  }
}

function drawAbstract(ctx, w, h, r) {
  ctx.fillStyle = `hsl(${r() * 360}, 20%, 10%)`; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `hsla(${r() * 360}, ${40 + r() * 40}%, ${25 + r() * 40}%, ${0.25 + r() * 0.5})`;
    ctx.beginPath(); ctx.ellipse(r() * w, r() * h, w * (0.05 + r() * 0.25), h * (0.05 + r() * 0.25), r() * 6.28, 0, Math.PI * 2); ctx.fill();
  }
}

/** id から決定的に絵を生成。opts.url があればその画像を使う（エディタ差し替え用） */
export function makePaintingTexture(THREE, opts = {}) {
  if (opts.url) {
    const t = new THREE.TextureLoader().load(opts.url);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const id = opts.id ?? 0;
  const W = 256, H = 320;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const r = rng(id + 1);
  const kind = Math.floor(r() * 3);
  if (kind === 0) drawPortrait(ctx, W, H, r);
  else if (kind === 1) drawLandscape(ctx, W, H, r);
  else drawAbstract(ctx, W, H, r);
  // 経年のくすみ（お屋敷の古い絵）
  ctx.fillStyle = 'rgba(60,40,15,0.20)'; ctx.fillRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
