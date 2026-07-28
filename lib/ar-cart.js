// ar-cart.js — AR空間に置く調整用カート（トレイ＋脚＋取っ手）と、その上のボタン群。
// 操作は Questコントローラのレイ（selectで押下）＋ 指先近接（ハンドトラッキング）。
// ボタンは「色ベース＋上面にCanvasラベル」。ラベルは値表示に随時書き換え可（setLabel）。
import * as THREE from 'https://esm.sh/three@0.184.0';

const CART = {
  traySize: [0.62, 0.03, 0.42], trayCenterY: 0.9, trayColor: 0x30384a,
  legRadius: 0.014, legColor: 0x20242e, casterRadius: 0.02, casterColor: 0x101216,
  handleH: 0.16, handleR: 0.012, handleColor: 0x8892a6, legInset: 0.04,
};
const BTN = { h: 0.016, labelPx: [256, 128] };

function makeLabelTexture(text, sub) {
  const cv = document.createElement('canvas');
  cv.width = BTN.labelPx[0]; cv.height = BTN.labelPx[1];
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (t, s) => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(10,14,24,0.9)';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf0ff'; ctx.font = 'bold 44px sans-serif';
    ctx.fillText(t, cv.width / 2, s != null ? cv.height * 0.36 : cv.height / 2);
    if (s != null) { ctx.fillStyle = '#7fd7ff'; ctx.font = 'bold 52px monospace'; ctx.fillText(String(s), cv.width / 2, cv.height * 0.72); }
    tex.needsUpdate = true;
  };
  draw(text, sub);
  return { tex, draw };
}

function buildFrame(group) {
  const trayTop = CART.trayCenterY + CART.traySize[1] / 2;
  const tray = new THREE.Mesh(new THREE.BoxGeometry(...CART.traySize), new THREE.MeshStandardMaterial({ color: CART.trayColor, roughness: 0.7 }));
  tray.position.set(0, CART.trayCenterY, 0);
  group.add(tray);
  const legMat = new THREE.MeshStandardMaterial({ color: CART.legColor, roughness: 0.6 });
  const trayBottom = CART.trayCenterY - CART.traySize[1] / 2;
  const hx = CART.traySize[0] / 2 - CART.legInset, hz = CART.traySize[2] / 2 - CART.legInset;
  for (const [x, z] of [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(CART.legRadius, CART.legRadius, trayBottom, 10), legMat);
    leg.position.set(x, trayBottom / 2, z); group.add(leg);
    const caster = new THREE.Mesh(new THREE.SphereGeometry(CART.casterRadius, 12, 8), legMat);
    caster.position.set(x, CART.casterRadius, z); group.add(caster);
  }
  // 取っ手（奥側）
  const hMat = new THREE.MeshStandardMaterial({ color: CART.handleColor, roughness: 0.5, metalness: 0.3 });
  const zBack = -CART.traySize[2] / 2 - 0.02;
  for (const x of [-hx, hx]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(CART.handleR, CART.handleR, CART.handleH, 10), hMat);
    post.position.set(x, trayTop + CART.handleH / 2, zBack); group.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(CART.handleR, CART.handleR, hx * 2, 12), hMat);
  bar.rotation.z = Math.PI / 2; bar.position.set(0, trayTop + CART.handleH, zBack); group.add(bar);
  return { trayTop, bar };
}

// buttons: [{ id, label, sub?, x, z, w=0.13, d=0.09, color?, type? }]  type:'display' は押せない値表示
export function createARCart(parent, { position = [0, 0, -0.75], yaw = 0, buttons = [], onPress } = {}) {
  const group = new THREE.Group();
  group.position.set(position[0], position[1], position[2]);
  group.rotation.y = yaw;
  parent.add(group);
  const { trayTop, bar } = buildFrame(group);

  const items = new Map();
  const pressables = [];
  for (const b of buttons) {
    const w = b.w ?? 0.13, d = b.d ?? 0.085;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(w, BTN.h, d),
      new THREE.MeshStandardMaterial({ color: b.color ?? (b.type === 'display' ? 0x1a2740 : 0x2b4a80), roughness: 0.5, emissive: 0x000000 }),
    );
    base.position.set(b.x, trayTop + BTN.h / 2 + 0.001, b.z);
    base.userData.id = b.id;
    group.add(base);
    const { tex, draw } = makeLabelTexture(b.label, b.sub);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.94, d * 0.94), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    face.rotation.x = -Math.PI / 2;            // 上面に寝かせて上から読めるように
    face.position.set(b.x, trayTop + BTN.h + 0.002, b.z);
    group.add(face);
    const rec = { base, face, draw, conf: b, restY: base.position.y, faceRestY: face.position.y, cool: 0 };
    items.set(b.id, rec);
    if (b.type !== 'display') { base.userData.rec = rec; pressables.push(base); }
  }

  const raycaster = new THREE.Raycaster();
  const _m = new THREE.Matrix4();
  const _tipLocal = new THREE.Vector3();
  const _box = new THREE.Box3();

  function fire(rec) {
    if (rec.cool > 0) return;
    rec.cool = 0.25;                            // 連打防止
    rec.base.position.y = rec.restY - 0.006;    // 押下アニメ
    rec.face.position.y = rec.faceRestY - 0.006;
    rec.base.material.emissive.setHex(0x224488);
    onPress?.(rec.conf.id, rec);
  }

  // コントローラのレイで押下（selectstartで呼ぶ）
  function pressFromController(controller) {
    _m.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m).normalize();
    const hit = raycaster.intersectObjects(pressables, false)[0];
    if (hit && hit.distance < 3) { fire(hit.object.userData.rec); return true; }
    return false;
  }

  // 指先（ワールド座標）近接で押下（毎フレーム）
  function pressFromTips(tips) {
    for (const tip of tips) {
      if (!tip) continue;
      for (const m of pressables) {
        _box.setFromObject(m).expandByScalar(0.005);
        if (_box.containsPoint(tip)) { fire(m.userData.rec); break; }
      }
    }
  }

  function setLabel(id, label, sub) { const r = items.get(id); if (r) r.draw(label, sub); }

  function update(dt) {   // 押下アニメの戻し
    for (const r of items.values()) {
      if (r.cool > 0) {
        r.cool -= dt;
        if (r.cool <= 0) { r.base.position.y = r.restY; r.face.position.y = r.faceRestY; r.base.material.emissive.setHex(0x000000); }
      }
    }
  }

  // ── 取っ手を掴んで移動 ──
  const _hw = new THREE.Vector3();
  let grabOffset = null;
  function handleWorld(out) { return bar.getWorldPosition(out); }
  function beginGrab(pointWorld) {   // 取っ手の近く(30cm)なら掴む
    bar.getWorldPosition(_hw);
    if (pointWorld.distanceTo(_hw) > 0.30) return false;
    grabOffset = new THREE.Vector3().copy(group.position).sub(pointWorld);
    bar.material.emissive.setHex(0x335577);
    return true;
  }
  function updateGrab(pointWorld) {
    if (!grabOffset) return;
    group.position.copy(pointWorld).add(grabOffset);
    if (group.position.y < 0) group.position.y = 0;
  }
  function endGrab() { grabOffset = null; bar.material.emissive.setHex(0x000000); }
  const isGrabbing = () => !!grabOffset;

  function dispose() { parent.remove(group); }
  return { group, pressFromController, pressFromTips, setLabel, update, dispose, handleWorld, beginGrab, updateGrab, endGrab, isGrabbing };
}
