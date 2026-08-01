// ar-vampire.js — AR吸血鬼サバイバル。JOY_vamp がプレイヤーを襲う一夜を耐える。
// 出現(壁の闇穴/天井から降下)→接近→キス(ダメージ)→十字架で撃退→消滅 の繰り返し。5分耐えれば勝ち。
// WebGL(=WebXR AR)。マント=CPU布。接地=歩きアニメのルートモーションを抽出してルートへ転写(足が滑らない)。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRButton } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/VRButton.js';
import { OculusHandModel } from 'https://esm.sh/three@0.184.0/examples/jsm/webxr/OculusHandModel.js';
import { VRMLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from 'https://esm.sh/@pixiv/three-vrm-animation@3.5.3?deps=three@0.184.0,@pixiv/three-vrm@3.5.3';
import { createVRMClothCPU } from '../lib/vrm-cloth-cpu.js';
import { createPortal } from '../lib/vamp-portal.js';
import { solveTwoBoneIK } from '../lib/vrm-ik.js';
import { sampleExpr, applyExpr, listExpressions } from '../lib/expr-timeline.js';

const $ = (id) => document.getElementById(id);
const setStatus = (m) => { const e = $('status'); if (e) e.textContent = m; };

// ── 設定（固定分）──
const KISS_RANGE = 0.55;       // この距離まで来たらキス開始
const REACH_RANGE = 0.75;      // 接近完了とみなす距離
const CROSS_RANGE = 0.6;       // 十字架がこの距離＋前方にあれば撃退
const CAPE = { thickness: 0.002, roughness: 0.10, unify: true };

// ── 敵挙動設定（enemyエディタ＝俯瞰モードで編集し public/vamp_param/vamp-enemy.json に保存）──
// states[各ステート]: anim=再生するtimeline.json(grip付)または.vrma / sfx=効果音ファイル / sfxMode=oneshot|loop / vol
const ENEMY = {
  states: {
    spawn_wall:    { anim: 'eri_model_walk.timeline.json', sfx: '', sfxMode: 'oneshot', vol: 0.9 },
    spawn_ceiling: { anim: 'eri_Fly_idle.timeline.json',   sfx: '', sfxMode: 'oneshot', vol: 0.9 },
    approach_walk: { anim: 'eri_model_walk.timeline.json', sfx: '', sfxMode: 'oneshot', vol: 0.9 },
    approach_fly:  { anim: 'eri_Fly_idle.timeline.json',   sfx: '', sfxMode: 'oneshot', vol: 0.9 },
    kiss:          { anim: 'eri_Fly_idle.timeline.json',   sfx: 'fat02.ogg', sfxMode: 'loop', vol: 0.95 },
    repelled:      { anim: 'eri_model_walk.timeline.json', sfx: '', sfxMode: 'oneshot', vol: 0.9 },
  },
  bgm: 'se1.ogg', bgmVol: 0.5,
  params: { nightSec: 300, kissToLose: 10, walkSpeed: 0.9, flySpeed: 0.7, animSpeed: 0.8, spawnGapMin: 2.5, spawnGapMax: 5.0, ceilingChance: 0.35, circleChance: 0.4 },
};
const STATE_LABELS = { spawn_wall: '壁から出現', spawn_ceiling: '天井から降臨', approach_walk: '歩いて接近', approach_fly: '飛んで接近', kiss: 'キス(吸血)', repelled: '撃退され退場' };

// ── レンダラ / シーン / XR ──
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setClearColor(0x000000, 0);
$('app').appendChild(renderer.domElement);
const vrBtn = VRButton.createButton(renderer); vrBtn.style.left = 'calc(50% - 130px)'; vrBtn.style.width = '110px';
document.body.appendChild(vrBtn);
function setupARButton() {
  const btn = document.createElement('button'); btn.textContent = 'ENTER AR';
  Object.assign(btn.style, { position: 'absolute', bottom: '20px', left: 'calc(50% + 20px)', width: '110px', padding: '12px 6px', border: '1px solid #fff', borderRadius: '4px', background: 'rgba(0,0,0,0.1)', color: '#fff', font: '13px sans-serif', cursor: 'pointer', zIndex: '10', textAlign: 'center', opacity: '0.5' });
  document.body.appendChild(btn);
  const init = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'plane-detection'] };
  let session = null;
  const onEnd = () => { session?.removeEventListener('end', onEnd); btn.textContent = 'ENTER AR'; session = null; };
  btn.onclick = () => {
    if (session) { session.end(); return; }
    navigator.xr.requestSession('immersive-ar', init).then(async (s) => { s.addEventListener('end', onEnd); renderer.xr.setReferenceSpaceType('local-floor'); await renderer.xr.setSession(s); btn.textContent = 'EXIT AR'; session = s; }).catch((e) => { btn.textContent = 'AR失敗'; console.error(e); });
  };
  if (navigator.xr) navigator.xr.isSessionSupported('immersive-ar').then((s) => { if (s) btn.style.opacity = '1'; else { btn.textContent = 'AR NOT SUPPORTED'; btn.disabled = true; } });
  else { btn.textContent = 'AR NOT SUPPORTED'; btn.disabled = true; }
}
setupARButton();

const scene = new THREE.Scene();
const BG = new THREE.Color(0x0a0a14);
scene.background = BG;
scene.environmentIntensity = 0.7;
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 1.5, 0.001);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 1.3, -2); controls.update();
scene.add(new THREE.HemisphereLight(0x8090b0, 0x101018, 0.45));
const keyLight = new THREE.DirectionalLight(0xa0b0e0, 0.9); keyLight.position.set(2, 3, 1); scene.add(keyLight);
new UltraHDRLoader().loadAsync('https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg')
  .then((t) => { t.mapping = THREE.EquirectangularReflectionMapping; scene.environment = t; }).catch(() => {});

// ── キャラ補助光（CityFly準拠：吸血鬼に追従する前後2灯のPointLight・距離減衰で世界は照らさない）──
const charFill = { key: null, rim: null };
let charLightCfg = { dirI: 1.9, ambI: 0.85, dirC: '#cfd8ff', ambC: '#b8c4dd' };
async function loadCharLight() {
  for (const u of ['./char-light.json', '../npc/char-light.json']) { try { charLightCfg = { ...charLightCfg, ...JSON.parse(await (await fetch(u)).text()) }; break; } catch { /* next */ } }
  if (charFill.key) { charFill.key.color.set(charLightCfg.dirC); charFill.key.intensity = charLightCfg.dirI; charFill.rim.color.set(charLightCfg.ambC); charFill.rim.intensity = charLightCfg.ambI; }
}
function attachCharFill() {   // bodyLocalFwd=顔の前方。キー光を顔前(=プレイヤー側)、リム光を背後上に
  const f = bodyLocalFwd;
  charFill.key = new THREE.PointLight(charLightCfg.dirC, charLightCfg.dirI, 7, 1.2); charFill.key.position.set(f.x * 0.6 + 0.18, 1.58, f.z * 0.6); npcRoot.add(charFill.key);
  charFill.rim = new THREE.PointLight(charLightCfg.ambC, charLightCfg.ambI, 6, 1.2); charFill.rim.position.set(-f.x * 0.8, 1.4, -f.z * 0.8); npcRoot.add(charFill.rim);
}

// XRで背景オフ＋近接クリップ対策（顔が近づいても目/眉が near で切れないよう depthNear を小さく）
function relaxXRNear(s) { try { s.updateRenderState({ depthNear: 0.01, depthFar: 100 }); } catch { /* noop */ } }
renderer.xr.addEventListener('sessionstart', () => { const s = renderer.xr.getSession(); const ar = s && s.environmentBlendMode && s.environmentBlendMode !== 'opaque'; scene.background = ar ? null : BG; if (s) relaxXRNear(s); });
renderer.xr.addEventListener('sessionend', () => { scene.background = BG; });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ── コントローラ＋手（十字架の掴み） ──
const _v = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
let crossHeld = false, crossHolder = null;   // 'c0'/'c1'/'h0'/'h1'
const controllersXR = [renderer.xr.getController(0), renderer.xr.getController(1)];
controllersXR.forEach((c, i) => {
  scene.add(c);
  c.addEventListener('squeezestart', () => tryGrabCross('c' + i, c));
  c.addEventListener('selectstart', () => tryGrabCross('c' + i, c));
  const rel = () => { if (crossHolder === 'c' + i) releaseCross(); };
  c.addEventListener('squeezeend', rel); c.addEventListener('selectend', rel);
});
const handsXR = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
for (const h of handsXR) { try { h.add(new OculusHandModel(h)); } catch (e) { /* noop */ } scene.add(h); }
function tipWorld(h, name, out) { const j = h.joints && h.joints[name]; return (j && j.visible) ? j.getWorldPosition(out) : null; }

// ── 十字架＋スタンド（プレイヤー右横） ──
const crossStand = new THREE.Group();
crossStand.position.set(0.45, 0, -0.35);
scene.add(crossStand);
{ // 簡易カート/スタンド
  const mat = new THREE.MeshStandardMaterial({ color: 0x30384a, roughness: 0.7 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.24), mat); top.position.y = 0.9; crossStand.add(top);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.9, 10), mat); leg.position.y = 0.45; crossStand.add(leg);
}
// 十字架（単純形状）
const cross = new THREE.Group();
{
  const cm = new THREE.MeshStandardMaterial({ color: 0xf0ead6, roughness: 0.5, emissive: 0x222018, emissiveIntensity: 0.4 });
  const vert = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.28, 0.045), cm); vert.position.y = 0.0; cross.add(vert);
  const horiz = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.045, 0.045), cm); horiz.position.y = 0.05; cross.add(horiz);
}
const crossHome = new THREE.Vector3(0.45, 0.9 + 0.16, -0.35);
cross.position.copy(crossHome);
scene.add(cross);
const _crossTip = new THREE.Vector3();   // 十字架の上端（かざす先）
function crossTipWorld(out) { return cross.localToWorld(out.set(0, 0.16, 0)); }

function tryGrabCross(holder, srcObj) {
  if (crossHeld) return;
  srcObj.getWorldPosition(_v);
  if (_v.distanceTo(cross.position) < 0.22) { crossHeld = true; crossHolder = holder; }
}
function releaseCross() { crossHeld = false; crossHolder = null; }
function updateCrossHold() {
  if (!crossHeld) { cross.position.lerp(crossHome, 0.1); cross.quaternion.slerp(_qId, 0.1); return; }
  if (crossHolder && crossHolder[0] === 'c') { const src = controllersXR[+crossHolder[1]]; src.getWorldPosition(_v); cross.position.copy(_v); src.getWorldQuaternion(cross.quaternion); }
  else if (crossHolder && crossHolder[0] === 'h') { const h = handsXR[+crossHolder[1]]; const t = tipWorld(h, 'index-finger-tip', _v); if (t) cross.position.copy(t); }
  // それ以外(test)は位置そのまま
}
const _qId = new THREE.Quaternion();
// 手ピンチで掴み（毎フレーム）
function updateHandGrabCross() {
  handsXR.forEach((h, i) => {
    const id = 'h' + i;
    const th = tipWorld(h, 'thumb-tip', _v1), ix = tipWorld(h, 'index-finger-tip', _v2);
    const pinch = th && ix && _v1.distanceTo(_v2) < 0.03;
    if (pinch && !crossHeld) { _v.copy(_v1).add(_v2).multiplyScalar(0.5); if (_v.distanceTo(cross.position) < 0.25) { crossHeld = true; crossHolder = id; } }
    else if (!pinch && crossHolder === id) releaseCross();
  });
}

// ── プレイヤー頭位置（通常/AR=カメラ、俯瞰エディタ=仮想ゴーグルproxy） ──
const _player = new THREE.Vector3();
let overview = false, playerProxy = null, draggingProxy = false, crossUpTest = false;
function playerHead(out) { return (overview && playerProxy) ? playerProxy.getWorldPosition(out) : camera.getWorldPosition(out); }

// ── 吸血鬼(VRM+マント)＋アニメ ──
let vrm = null, mixer = null, cape = null;
let curAction = null, curFps = 30;   // 現在再生中のアクション（cape.updateへ渡すフレーム算出用）
let hipsNode = null, headNode = null; const hipsRest = new THREE.Vector3();
let armL = null, armR = null;   // 腕IK用チェーン {root:upperArm, mid:lowerArm, end:hand}（生ボーン）
const bodyLocalFwd = new THREE.Vector3(0, 0, 1);
const headFace = new THREE.Vector3(0, 0, 1);   // 頭ボーン基準の「顔の前方」(editorTransform.ry補正済み)
const _yAxis = new THREE.Vector3(0, 1, 0);
const npcRoot = new THREE.Group();   // 吸血鬼のルート（位置・向きを制御）
scene.add(npcRoot);
let ready = false;

function dataURIToBlob(uri) { const [head, data] = uri.split(','); const bin = atob(data); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: (head.match(/:(.*?);/) || [])[1] || 'application/octet-stream' }); }
async function fetchBundle() { for (const u of ['./JOY_vamp.npc.json', '../npc/JOY_vamp.npc.json']) { try { return JSON.parse(await (await fetch(u)).text()); } catch { /* next */ } } throw new Error('JOY_vamp.npc.json が読めません'); }
async function fetchVRMA(name) { for (const u of ['./vrma/' + name, '../vrma/' + name]) { try { const b = await (await fetch(u)).arrayBuffer(); const m = new Uint8Array(b, 0, 4); if (m[0] === 0x67 && m[1] === 0x6C && m[2] === 0x54 && m[3] === 0x46) return URL.createObjectURL(new Blob([b])); } catch { /* next */ } } return null; }
async function loadCapeParams(npcName) {   // cloth-npc の保存設定
  for (const u of ['./cape-' + npcName + '.json', '../vamp_param/cape-' + npcName + '.json']) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j && j.material) return j; } catch { /* next */ }
  }
  return null;
}
async function fetchTimeline(name) { for (const u of ['./timeline/' + name, '../timeline/' + name]) { try { return JSON.parse(await (await fetch(u)).text()); } catch { /* next */ } } return null; }

// ── アニメ/効果音の汎用再生（enemyエディタ設定 ENEMY に基づく）──
async function mkClip(vrmaName) { const url = await fetchVRMA(vrmaName); if (!url) return null; const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p)); const ag = await al.loadAsync(url); const a = ag.userData.vrmAnimations; return (a && a.length) ? createVRMAnimationClip(a[0], vrm) : null; }
const animCache = {};   // animName(timeline.json/.vrma) -> { action, tl, fps }
async function getAnim(animName) {
  if (!animName || !mixer || !vrm) return null;
  if (animCache[animName]) return animCache[animName];
  let tl = null, vrmaName = animName;
  if (animName.endsWith('.timeline.json')) { tl = await fetchTimeline(animName); vrmaName = (tl && tl.vrma) ? tl.vrma : null; }
  if (!vrmaName) return null;
  const clip = await mkClip(vrmaName); if (!clip) return null;
  animCache[animName] = { action: mixer.clipAction(clip), tl, fps: (tl && tl.fps) || 30 };
  return animCache[animName];
}
async function loadEnemyAnims() { for (const n of new Set(Object.values(ENEMY.states).map((s) => s.anim).filter(Boolean))) { try { await getAnim(n); } catch { /* skip */ } } }
function playStateAnim(stateId) {
  const cfg = ENEMY.states[stateId]; if (!cfg || !mixer) return;
  const rec = animCache[cfg.anim]; if (!rec) return;
  mixer.stopAllAction(); rec.action.reset(); rec.action.timeScale = ENEMY.params.animSpeed || 1; rec.action.play();
  curAction = rec.action; curFps = rec.fps; flInit = false;
  if (cape) cape.setTimeline(rec.tl);
}
// 効果音：state ごと。loop は離脱時に停止、oneshot は都度再生
const sfxEls = {};
function sfxEl(name) { if (sfxEls[name]) return sfxEls[name]; const a = new Audio(); a.src = '../audio/' + name; a.addEventListener('error', () => { if (!a.src.endsWith('./audio/' + name)) a.src = './audio/' + name; }, { once: true }); sfxEls[name] = a; return a; }
function preloadSfx() { for (const n of new Set(Object.values(ENEMY.states).map((s) => s.sfx).filter(Boolean))) sfxEl(n); }
let loopSfx = null;
function stopLoopSfx() { if (loopSfx) { try { loopSfx.pause(); loopSfx.currentTime = 0; } catch { /* noop */ } loopSfx = null; } }
function playStateSfx(stateId) {
  stopLoopSfx();
  const cfg = ENEMY.states[stateId]; if (!cfg || !cfg.sfx) return;
  const a = sfxEl(cfg.sfx); a.loop = cfg.sfxMode === 'loop'; a.volume = cfg.vol ?? 0.9; try { a.currentTime = 0; } catch { /* noop */ } a.play().catch(() => {});
  if (a.loop) loopSfx = a;
}
function applyStatePresentation(stateId) { playStateAnim(stateId); playStateSfx(stateId); exprT = 0; }
// ── ステート別の表情（ブレンドシェイプ）タイムライン。vamp-enemy.json の states.<st>.expr を再生 ──
let exprT = 0, exprManaged = [];
function updateStateExpr(dt, stateId) {
  if (!vrm) return;
  exprT += dt;
  const tr = ENEMY.states[stateId] && ENEMY.states[stateId].expr;
  if (!tr || !(tr.keys || []).length) {
    if (exprManaged.length) { applyExpr(vrm, {}, exprManaged); exprManaged = []; }
    return;
  }
  const w = sampleExpr(tr, exprT);
  exprManaged = [...new Set([...exprManaged, ...Object.keys(w)])];
  applyExpr(vrm, w, exprManaged);
}
// 設定ファイル（public/vamp_param/vamp-enemy.json）を読み込んで ENEMY にマージ
async function loadEnemy() {
  for (const u of ['./vamp-enemy.json', '../vamp_param/vamp-enemy.json']) {
    try { const j = JSON.parse(await (await fetch(u)).text()); if (j) { if (j.states) for (const k in j.states) ENEMY.states[k] = { ...ENEMY.states[k], ...j.states[k] }; if (j.params) Object.assign(ENEMY.params, j.params); if (j.bgm) ENEMY.bgm = j.bgm; if (typeof j.bgmVol === 'number') ENEMY.bgmVol = j.bgmVol; } break; } catch { /* next */ }
  }
}

async function loadVampire() {
  setStatus('JOY_vamp 読み込み中…');
  const bundle = await fetchBundle();
  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(URL.createObjectURL(dataURIToBlob(bundle.vrm)));
  vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.combineSkeletons(gltf.scene);
  vrm.scene.updateMatrixWorld(true);
  npcRoot.add(vrm.scene);
  hipsNode = vrm.humanoid?.getNormalizedBoneNode('hips') ?? null;
  headNode = vrm.humanoid?.getNormalizedBoneNode('head') ?? null;
  leftFootNode = vrm.humanoid?.getNormalizedBoneNode('leftFoot') ?? null;
  rightFootNode = vrm.humanoid?.getNormalizedBoneNode('rightFoot') ?? null;
  // 腕IK用の生ボーン（メッシュが追従する実スケルトン。vrm.update後に上書きする）
  const raw = (n) => vrm.humanoid?.getRawBoneNode(n) ?? null;
  armL = { root: raw('leftUpperArm'), mid: raw('leftLowerArm'), end: raw('leftHand') };
  armR = { root: raw('rightUpperArm'), mid: raw('rightLowerArm'), end: raw('rightHand') };
  if (hipsNode) hipsRest.copy(hipsNode.position);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;
  // 前方を確定（顔正面=+Zへ整列。ゲーム中は都度プレイヤーへ向ける）
  vrm.update(0); vrm.scene.updateMatrixWorld(true);
  if (headNode) {
    headNode.getWorldQuaternion(_bq); _fwd.copy(HEAD_FWD).applyQuaternion(_bq); _fwd.y = 0;
    if (_fwd.lengthSq() > 1e-6) {
      _fwd.normalize(); vrm.scene.getWorldQuaternion(_bq); bodyLocalFwd.copy(_fwd).applyQuaternion(_bq.invert());
      // モデルのメッシュ本体が骨に対し editorTransform.ry だけ回っている場合（JOY_vamp=180°等）、
      // 頭ボーンの+Zは「骨の前」であって見た目の正面ではない。ry分を回して見た目の前方へ補正。
      const ryRad = ((bundle.cloth && bundle.cloth.editorTransform && bundle.cloth.editorTransform.ry) || 0) * Math.PI / 180;
      if (ryRad) bodyLocalFwd.applyAxisAngle(_yAxis, ryRad);
      bodyLocalFwd.y = 0; if (bodyLocalFwd.lengthSq() > 1e-6) bodyLocalFwd.normalize();
      // 頭Look-at用の「顔の前方」も同じ ry でボーン内で補正（顔がメッシュ前方＝プレイヤーを向く）
      headFace.copy(HEAD_FWD); if (ryRad) headFace.applyAxisAngle(_yAxis, ryRad); headFace.normalize();
    }
  }
  // 敵設定を読み込み（アニメ/効果音/パラメータ）→ 参照アニメを事前ロード
  mixer = new THREE.AnimationMixer(vrm.scene);
  await loadEnemy();
  await loadEnemyAnims();
  preloadSfx(); initBGM();
  // マント（設定固定）。初期タイムラインは approach_walk のアニメ（両手掴み）
  vrm.update(0); vrm.scene.updateMatrixWorld(true);
  const initTl = animCache[ENEMY.states.approach_walk.anim] ? animCache[ENEMY.states.approach_walk.anim].tl : null;
  cape = createVRMClothCPU({ scene, vrm, cloth: bundle.cloth, timeline: initTl, basePos: new THREE.Vector3(), floorY: 0 });
  // cloth-npc で保存したマント設定があれば優先（無ければ既定の CAPE）
  const cp = await loadCapeParams('JOY_vamp');
  const cm = cp && cp.material ? cp.material : {};
  cape.setMaterial({
    thickness: cm.thickness ?? CAPE.thickness,
    roughness: cm.roughness ?? CAPE.roughness,
    unify: cm.unify ?? CAPE.unify,
    sheen: cm.sheen, opacity: cm.opacity,
  });
  if (cp && cp.env != null) scene.environmentIntensity = cp.env;
  cape.setTimeline(initTl);
  attachCharFill(); loadCharLight();   // キャラ補助光
  ready = true;
  npcRoot.visible = false;
  setStatus('');
}

// ── 首/顔をプレイヤーの頭(ゴーグル)へ（cloth-npc の updateHeadLook 方式：正面錐で重み＋平滑化。顔前方はheadFace=ry補正） ──
const lookTarget = new THREE.Object3D(); scene.add(lookTarget);   // 視線(目)のターゲット＝プレイヤー頭
const _lp = new THREE.Vector3(), _hp = new THREE.Vector3(), _fwd = new THREE.Vector3(), _dh = new THREE.Vector3();
const _bq = new THREE.Quaternion(), _hqCur = new THREE.Quaternion(), _hqDes = new THREE.Quaternion(), _hqPar = new THREE.Quaternion(), _hqDelta = new THREE.Quaternion();
const _hFwd = new THREE.Vector3(), _hDir = new THREE.Vector3();
const HEAD_FWD = new THREE.Vector3(0, 0, 1);   // VRM頭の顔正面既定=+Z。実際の顔前方は headFace(ry補正済み)
const lookS = { w: 0 };
const LK = { HEAD_MAX: Math.PI * 0.6, IN: 1.0, OUT: 1.9, SPEED: 6 };
function updateHeadLook(dt, force) {
  if (!headNode) return;
  playerHead(_lp); headNode.getWorldPosition(_hp);
  // 正面錐の重み：モデル前方(ry補正済み・アニメで揺れない)とプレイヤー水平方向の角
  npcRoot.getWorldQuaternion(_bq); _fwd.copy(bodyLocalFwd).applyQuaternion(_bq); _fwd.y = 0;
  _dh.copy(_lp).sub(_hp); _dh.y = 0;
  let wt = 0;
  if (_fwd.lengthSq() > 1e-6 && _dh.lengthSq() > 1e-6) { const fa = _fwd.normalize().angleTo(_dh.normalize()); wt = fa < LK.IN ? 1 : fa > LK.OUT ? 0 : (LK.OUT - fa) / (LK.OUT - LK.IN); }
  if (force) wt = 1;   // キス中など必ず見る
  lookS.w += (wt - lookS.w) * (1 - Math.exp(-dt * LK.SPEED));   // 滑らかに（急に向かない）
  if (lookS.w < 0.01) return;
  _hDir.copy(_lp).sub(_hp); if (_hDir.lengthSq() < 1e-8) return; _hDir.normalize();
  headNode.getWorldQuaternion(_hqCur); _hFwd.copy(headFace).applyQuaternion(_hqCur).normalize();
  const ang = _hFwd.angleTo(_hDir); if (ang < 1e-4) return;
  let w = lookS.w; if (ang > LK.HEAD_MAX) w *= LK.HEAD_MAX / ang;   // 後ろへ向きすぎない
  _hqDelta.setFromUnitVectors(_hFwd, _hDir);
  _hqDes.identity().slerp(_hqDelta, w).multiply(_hqCur);
  headNode.parent.getWorldQuaternion(_hqPar);
  headNode.quaternion.copy(_hqPar.invert().multiply(_hqDes)).normalize();
}

// 体をプレイヤーへ向ける（yawをlerp）。dir<0で背を向ける（後退用）
function facePlayer(dt, k, back) {
  playerHead(_lp); _dh.copy(_lp).sub(npcRoot.position); _dh.y = 0;
  if (_dh.lengthSq() < 1e-6) return;
  const want = Math.atan2(_dh.x, _dh.z) + (back ? Math.PI : 0);
  // bodyLocalFwd を +Z(=want方向)へ合わせる yaw
  const cur = npcRoot.rotation.y;
  let d = want - Math.atan2(bodyLocalFwd.x, bodyLocalFwd.z) - cur;
  while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
  npcRoot.rotation.y = cur + d * Math.min(1, dt * k);
}

// ── フットロック接地: model_walk は「その場歩き」なので、接地している足が世界で止まるように
// 体(ルート)を前へ動かす＝足が滑らない。接地足=低い方の足、その前後移動の逆分だけルートを進める。
let leftFootNode = null, rightFootNode = null;
let flLastL = 0, flLastR = 0, flInit = false;
function footFwd(node) {   // 足の「体前方(ワールド)」成分（腰基準・ルート移動に依らない＝アニメの足運びのみ）
  node.getWorldPosition(_v); hipsNode.getWorldPosition(_v1); _v.sub(_v1);
  npcRoot.getWorldQuaternion(_bq); _fwd.copy(bodyLocalFwd).applyQuaternion(_bq); _fwd.y = 0; _fwd.normalize();
  return _v.x * _fwd.x + _v.z * _fwd.z;
}
function footLockMove(dt) {
  if (!leftFootNode || !rightFootNode || !hipsNode) return;
  const fL = footFwd(leftFootNode), fR = footFwd(rightFootNode);
  if (!flInit) { flLastL = fL; flLastR = fR; flInit = true; return; }
  const dL = fL - flLastL, dR = fR - flLastR;   // 負=後ろへ動く＝接地足
  flLastL = fL; flLastR = fR;
  let move = -Math.min(dL, dR);                 // 最も後ろへ動いた足の分だけ体を前へ（チラつかない）
  const cap = ENEMY.params.walkSpeed * dt;
  move = Math.max(0, Math.min(cap, move));
  npcRoot.getWorldQuaternion(_bq); _fwd.copy(bodyLocalFwd).applyQuaternion(_bq); _fwd.y = 0;
  if (_fwd.lengthSq() > 1e-6) { _fwd.normalize(); npcRoot.position.addScaledVector(_fwd, move); }
}

// ── ゲーム状態機械 ──
let phase = 'load';   // load / playing / gameover / win
let nightT = 0, kissT = 0;
let invincible = false;   // 無敵モード（ライフが減らない）
// キス時の口の密着位置（bite-editor流：口=頭+offset を プレイヤー顔へ剛体で寄せる）。俯瞰UIで調整・localStorage保存
const kissCfg = { fwd: 0.09, up: -0.03, gap: 0.0, lean: 0.4 };
try { const s = JSON.parse(localStorage.getItem('arvamp-kiss') || 'null'); if (s) Object.assign(kissCfg, s); } catch { /* noop */ }
// キス時、腕IKでプレイヤーの「グラブポイント（両肩）」に手を伸ばして押さえる。俯瞰で調整・保存。
const GRAB = { enabled: true, side: 0.17, down: 0.14, fwd: 0.03 };
const V = { state: 'hidden', t: 0, timer: 0, mode: 'wall', circle: 0 };
const portal = createPortal(scene, {});
const _spawnPos = new THREE.Vector3();

function pickSpawn(ceiling) {
  playerHead(_lp);
  const ang = Math.random() * Math.PI * 2;
  const dist = 2.2 + Math.random() * 1.3;
  _spawnPos.set(_lp.x + Math.sin(ang) * dist, ceiling ? 2.3 : 0, _lp.z + Math.cos(ang) * dist);
  return _spawnPos;
}

function toHidden(gap) { V.state = 'hidden'; V.timer = gap ?? (ENEMY.params.spawnGapMin + Math.random() * (ENEMY.params.spawnGapMax - ENEMY.params.spawnGapMin)); npcRoot.visible = false; portal.setProgress(0); stopLoopSfx(); }
function startAttack() {
  const ceiling = Math.random() < ENEMY.params.ceilingChance;   // 天井降下の確率
  V.mode = ceiling ? 'ceiling' : 'wall';
  V.circle = Math.random() < ENEMY.params.circleChance ? (Math.random() < 0.5 ? 1 : -1) : 0;   // 回り込み
  pickSpawn(ceiling);
  playerHead(_lp);
  portal.place(_spawnPos.clone().setY(ceiling ? 2.3 : 1.1), _lp);
  npcRoot.position.copy(_spawnPos);
  npcRoot.visible = true;
  V.state = ceiling ? 'spawn_ceiling' : 'spawn_wall'; V.t = 0;
  applyStatePresentation(V.state);
}

// ── 部屋ワイヤーフレーム（Questルームスキャン: XR plane detection の結果を表示） ──
let showRoom = false;
const roomWire = new THREE.Group(); roomWire.visible = false; scene.add(roomWire);
const wireMatWall = new THREE.LineBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.9 });   // 壁=水色
const wireMatHorz = new THREE.LineBasicMaterial({ color: 0xffd070, transparent: true, opacity: 0.9 });   // 床/天井=橙
const planeMap = new Map();   // XRPlane -> { line, ts }
function updateRoomWire(frame) {
  roomWire.visible = showRoom;
  if (!showRoom || !frame || !frame.detectedPlanes) return;
  const refSpace = renderer.xr.getReferenceSpace(); if (!refSpace) return;
  const planes = frame.detectedPlanes;
  for (const [pl, rec] of planeMap) { if (!planes.has(pl)) { roomWire.remove(rec.line); rec.line.geometry.dispose(); planeMap.delete(pl); } }
  planes.forEach((plane) => {
    let rec = planeMap.get(plane);
    if (!rec || rec.ts !== plane.lastChangedTime) {
      const pts = []; for (const p of (plane.polygon || [])) pts.push(p.x, p.y, p.z);
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      if (rec) { roomWire.remove(rec.line); rec.line.geometry.dispose(); }
      const line = new THREE.LineLoop(geo, plane.orientation === 'vertical' ? wireMatWall : wireMatHorz);
      line.matrixAutoUpdate = false; line.frustumCulled = false; roomWire.add(line);
      rec = { line, ts: plane.lastChangedTime }; planeMap.set(plane, rec);
    }
    const pose = frame.getPose(plane.planeSpace, refSpace);
    if (pose) { rec.line.matrix.fromArray(pose.transform.matrix); rec.line.visible = true; } else rec.line.visible = false;
  });
}
{ const c = $('chk-room'); if (c) c.addEventListener('change', (e) => { showRoom = e.target.checked; }); }

// ── メインループ ──
let last = performance.now(), frames = 0, fps = 0;
const clock = new THREE.Clock();
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  updateHandGrabCross(); updateCrossHold();
  updateOverview();
  updateRoomWire(frame);

  if (phase === 'playing' && ready && !preview) {
    nightT += dt;
    updateVampire(dt);
    if (nightT >= ENEMY.params.nightSec) win();
  }

  // VRM/マント更新
  if (mixer) mixer.update(dt);
  if (ready && phase !== 'load') {
    if (hipsNode) { hipsNode.position.x = hipsRest.x; hipsNode.position.z = hipsRest.z; }   // 腰はその場（フットロックでルートを動かす）
    if (V.state === 'approach_walk' || V.state === 'repelled') footLockMove(dt);
    playerHead(lookTarget.position);
    vrm.scene.updateMatrixWorld(true);
    if (npcRoot.visible) updateHeadLook(dt, V.state === 'kiss' || V.state === 'peek');
    updateStateExpr(dt, V.state);
    vrm.update(dt); vrm.scene.updateMatrixWorld(true);
    if ((V.state === 'kiss' || V.state === 'peek') && npcRoot.visible) updateHandIK();   // 腕IKで肩を押さえる（vrm.update後に上書き）
    if (cape && npcRoot.visible) cape.update(dt, curAction ? curAction.time * curFps : 0);
    cape && (cape.clothMesh.visible = npcRoot.visible);
  }

  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
  if (overview) renderPip();

  frames++; const now = performance.now();
  if (now - last >= 500) { fps = Math.round(frames / ((now - last) / 1000)); frames = 0; last = now; updateHUD(); }
});

function updateVampire(dt) {
  V.t += dt;
  playerHead(_player);
  const dist = Math.hypot(npcRoot.position.x - _player.x, npcRoot.position.z - _player.z);   // 水平距離（床歩きでも届く）
  const crossRepel = isCrossUp();

  switch (V.state) {
    case 'hidden':
      V.timer -= dt; if (V.timer <= 0) startAttack();
      break;
    case 'spawn_wall': {
      portal.setProgress(Math.min(1, V.t / 1.6));   // ゆっくり穴が開く
      if (V.t > 1.6) { V.state = 'approach_walk'; V.t = 0; applyStatePresentation('approach_walk'); }
      break;
    }
    case 'spawn_ceiling': {
      portal.setProgress(Math.min(1, V.t / 1.6));
      if (V.t > 1.4) { V.state = 'approach_fly'; V.t = 0; applyStatePresentation('approach_fly'); }
      break;
    }
    case 'approach_walk': {
      facePlayer(dt, 3, false);
      if (V.circle && dist < 1.8) {   // 回り込み（プレイヤー周囲を歩く）
        const tang = _v.copy(_player).sub(npcRoot.position); tang.y = 0; tang.normalize();
        _v1.set(-tang.z, 0, tang.x).multiplyScalar(V.circle);
        npcRoot.position.addScaledVector(_v1, dt * 0.4);
      }
      // ルートモーションで前進（stepRootMotionで実施）
      npcRoot.position.y = 0;
      if (crossRepel) { toRepelled(); break; }
      if (dist < KISS_RANGE) { toKiss(); }
      portal.setProgress(Math.max(0, 1 - (V.t) * 1.5));   // 出たら穴は閉じる
      break;
    }
    case 'approach_fly': {
      facePlayer(dt, 3, false);
      const tgt = _v.copy(_player); tgt.y = Math.max(0, _player.y - 0.2);
      npcRoot.position.addScaledVector(_v1.copy(tgt).sub(npcRoot.position).normalize(), ENEMY.params.flySpeed * dt);
      if (crossRepel) { toRepelled(); break; }
      if (dist < KISS_RANGE) { toKiss(); }
      portal.setProgress(Math.max(0, 1 - V.t * 1.2));
      break;
    }
    case 'kiss': {
      // 体をプレイヤーへ向け、口(頭+offset)を顔へ密着させ続ける＋ダメージ
      facePlayer(dt, 5, false);
      kissApproach(dt);
      if (!invincible) kissT += dt;
      if (crossRepel) { toRepelled(); break; }
      if (kissT >= ENEMY.params.kissToLose) gameover();
      break;
    }
    case 'repelled': {
      facePlayer(dt, 4, true);   // 背を向ける
      npcRoot.position.y = 0;
      V.timer -= dt;
      portal.place(_spawnPos.clone().setY(1.1), _player);
      portal.setProgress(Math.min(1, (1.2 - V.timer) / 0.6));
      if (V.timer <= 0) { toHidden(); }   // 壁へ消えた
      break;
    }
  }
}
function toKiss() { V.state = 'kiss'; V.t = 0; applyStatePresentation('kiss'); }
function toRepelled() { V.state = 'repelled'; V.t = 0; V.timer = 1.2; _spawnPos.copy(npcRoot.position); applyStatePresentation('repelled'); }

// bite-editor流：口(頭+headFace*fwd＋up) を プレイヤー顔(=head+彼女側gap)へ、ルートを剛体で寄せて密着させる
const _mouth = new THREE.Vector3(), _ktar = new THREE.Vector3(), _kd = new THREE.Vector3();
function kissApproach(dt) {
  if (!headNode) return;
  headNode.getWorldPosition(_hp); headNode.getWorldQuaternion(_bq);
  _mouth.copy(headFace).multiplyScalar(kissCfg.fwd); _mouth.y += kissCfg.up; _mouth.applyQuaternion(_bq).add(_hp);   // 口ワールド
  playerHead(_lp);
  _dh.copy(_hp).sub(_lp); _dh.y = 0; if (_dh.lengthSq() > 1e-6) _dh.normalize();   // プレイヤー→彼女(水平)
  _ktar.copy(_lp).addScaledVector(_dh, kissCfg.gap);   // 目標＝プレイヤー顔＋彼女側へgap
  _kd.copy(_ktar).sub(_mouth);
  const k = Math.min(1, dt * 6);
  npcRoot.position.x += _kd.x * k; npcRoot.position.z += _kd.z * k; npcRoot.position.y += _kd.y * kissCfg.lean * k;
}

// ── 腕IK：キス時、プレイヤーの両肩(グラブポイント)へ手を伸ばして押さえる ──
const _gpL = new THREE.Vector3(), _gpR = new THREE.Vector3(), _perp = new THREE.Vector3();
function computeGrabTargets(outL, outR) {
  playerHead(_lp);
  _dh.copy(_lp).sub(npcRoot.position); _dh.y = 0;   // 吸血鬼→プレイヤー(水平)
  if (_dh.lengthSq() > 1e-6) _dh.normalize(); else _dh.set(0, 0, 1);
  _perp.copy(_dh).cross(_yAxis).normalize();         // 水平の横方向
  outL.copy(_lp); outL.y -= GRAB.down; outL.addScaledVector(_dh, -GRAB.fwd);   // 基準＝頭の少し下＋吸血鬼側
  outR.copy(outL);
  outL.addScaledVector(_perp, GRAB.side);            // 吸血鬼の左手→片肩
  outR.addScaledVector(_perp, -GRAB.side);           // 吸血鬼の右手→反対肩
}
function applyArmIK(chain, target) {
  if (!chain || !chain.root || !chain.mid || !chain.end) return;
  const res = solveTwoBoneIK(chain, target);
  chain.root.quaternion.copy(res.rootQuat);
  chain.mid.quaternion.copy(res.midQuat);
  chain.root.updateWorldMatrix(true, true);
}
function updateHandIK() {
  if (!GRAB.enabled || !armL || !armR) return;
  computeGrabTargets(_gpL, _gpR);
  applyArmIK(armL, _gpL);
  applyArmIK(armR, _gpR);
  vrm.scene.updateMatrixWorld(true);
}

// 十字架がプレイヤー付近で吸血鬼の顔前にかざされているか
const _ctip = new THREE.Vector3(), _hface = new THREE.Vector3();
function isCrossUp() {
  if (!crossHeld || !headNode || !npcRoot.visible) return false;
  crossTipWorld(_ctip); headNode.getWorldPosition(_hface);
  if (_ctip.distanceTo(_hface) > CROSS_RANGE) return false;
  // 顔の前方(headFace=ry補正済み) ~ 十字架方向（彼女の顔の前にあるか）
  headNode.getWorldQuaternion(_bq); _hFwd.copy(headFace).applyQuaternion(_bq).normalize();
  _hDir.copy(_ctip).sub(_hface).normalize();
  return _hFwd.dot(_hDir) > 0.2;
}

// ── BGM（ゲーム中ループ・音量0.5） ──
const bgm = { el: null };
function initBGM() { const name = ENEMY.bgm || 'se1.ogg'; const a = new Audio(); a.loop = true; a.volume = ENEMY.bgmVol ?? 0.5; a.src = '../BGM/' + name; a.addEventListener('error', () => { if (!a.src.endsWith('./BGM/' + name)) a.src = './BGM/' + name; }, { once: true }); bgm.el = a; }
function playBGM() { if (bgm.el) { bgm.el.currentTime = 0; bgm.el.play().catch(() => {}); } }
function stopBGM() { if (bgm.el) bgm.el.pause(); }

// ── キス音（oggループ） ──

// ── ゲーム進行 ──
function startGame() {
  preview = false;
  phase = 'playing'; nightT = 0; kissT = 0;
  toHidden(1.5);
  playBGM();
  $('overlay').style.display = 'none';
}
function gameover() { phase = 'gameover'; stopLoopSfx(); stopBGM(); toHidden(9999); npcRoot.visible = false; showOverlay('GAME OVER', '朝を迎えられなかった…', '#f66'); }
function win() { phase = 'win'; stopLoopSfx(); stopBGM(); toHidden(9999); npcRoot.visible = false; showOverlay('DAWN', '夜明けだ。生き延びた！', '#8f8'); }
function showOverlay(title, sub, col) { $('ov-title').textContent = title; $('ov-title').style.color = col; $('ov-sub').textContent = sub; $('overlay').style.display = 'flex'; }

function updateHUD() {
  if (phase === 'load') return;
  const remain = Math.max(0, ENEMY.params.nightSec - nightT);
  $('hud-time').textContent = `残り ${Math.floor(remain / 60)}:${String(Math.floor(remain % 60)).padStart(2, '0')}`;
  const danger = Math.min(1, kissT / ENEMY.params.kissToLose);
  $('hud-danger').style.width = (danger * 100) + '%';
  $('hud-state').textContent = { hidden: '…', spawn_wall: '出現', spawn_ceiling: '降臨', approach_walk: '接近中', approach_fly: '降下中', kiss: 'キス中！十字架を！', repelled: '撃退' }[V.state] || '';
  $('hud-fps').textContent = fps + ' FPS';
}

// ── 俯瞰エディタ（ゴーグルを被らず、仮想プレイヤーに対する挙動を上から確認） ──
let ovGrid = null, playerRing = null, pipCamera = null, mouthMarker = null, faceMarker = null, linkLine = null, grabMarkerL = null, grabMarkerR = null;
function markerSphere(r, col) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 })); m.renderOrder = 999; m.visible = false; scene.add(m); return m; }
function buildPlayerProxy() {
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 16), new THREE.MeshStandardMaterial({ color: 0xd8b89a, roughness: 0.85 })); g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.085, 0.13), new THREE.MeshStandardMaterial({ color: 0x0c0c14, roughness: 0.25, metalness: 0.5, emissive: 0x2a44ff, emissiveIntensity: 0.35 })); visor.position.set(0, 0.0, -0.075); g.add(visor);
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.018, 8, 24), new THREE.MeshStandardMaterial({ color: 0x2a3040 })); strap.rotation.y = Math.PI / 2; g.add(strap);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 14), new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x1a5566, emissiveIntensity: 0.5 })); arrow.position.set(0, 0, -0.24); arrow.rotation.x = -Math.PI / 2; g.add(arrow);   // 視線(前方=-Z)
  g.position.set(0, 1.5, 0);
  g.userData.pickable = [head, visor, strap, arrow];
  return g;
}
function enterOverview() {
  if (!overview) {
    overview = true;
    if (!playerProxy) { playerProxy = buildPlayerProxy(); scene.add(playerProxy); }
    if (!ovGrid) { ovGrid = new THREE.GridHelper(10, 20, 0x3a5a80, 0x223044); ovGrid.position.y = 0; scene.add(ovGrid); }
    if (!playerRing) { playerRing = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 28), new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide })); playerRing.rotation.x = -Math.PI / 2; playerRing.position.y = 0.01; scene.add(playerRing); }
    if (!mouthMarker) {   // 口アンカー(彼女の唇=赤桃) / 狙い点(プレイヤー顔=水色) / 連結線
      mouthMarker = markerSphere(0.02, 0xff3d6e); faceMarker = markerSphere(0.022, 0x66e0ff);
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
      linkLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false, transparent: true, opacity: 0.9 })); linkLine.renderOrder = 998; linkLine.visible = false; scene.add(linkLine);
    }
    if (!pipCamera) { pipCamera = new THREE.PerspectiveCamera(72, 1.5, 0.008, 50); scene.add(pipCamera); }
    if (!grabMarkerL) { grabMarkerL = markerSphere(0.032, 0x3a86ff); grabMarkerR = markerSphere(0.032, 0xff8a3a); }   // 左手=青 / 右手=橙
    playerProxy.visible = ovGrid.visible = playerRing.visible = true;
    if ($('pip-frame')) $('pip-frame').style.display = 'block';
    scene.background = new THREE.Color(0x0a0d16);
    camera.position.set(3.6, 4.6, 5.4); controls.target.set(0, 1.0, -0.6); controls.update();
    $('ov-panel').style.display = 'block';
  }
  startGame();
}
// proxy をマウスドラッグで床上を移動（proxyメッシュを掴んだ時だけ。それ以外はOrbit操作）
const _ray = new THREE.Raycaster(), _ndc = new THREE.Vector2(), _dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _hit = new THREE.Vector3();
function ndcFromEvent(e) { const r = renderer.domElement.getBoundingClientRect(); _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!overview || !playerProxy) return;
  ndcFromEvent(e); _ray.setFromCamera(_ndc, camera);
  if (_ray.intersectObjects(playerProxy.userData.pickable, false).length) { draggingProxy = true; controls.enabled = false; }
});
addEventListener('pointermove', (e) => {
  if (!draggingProxy) return;
  ndcFromEvent(e); _ray.setFromCamera(_ndc, camera);
  _dragPlane.constant = -playerProxy.position.y;   // proxyの高さの水平面
  if (_ray.ray.intersectPlane(_dragPlane, _hit)) { playerProxy.position.x = _hit.x; playerProxy.position.z = _hit.z; }
});
addEventListener('pointerup', () => { if (draggingProxy) { draggingProxy = false; controls.enabled = true; } });
// 俯瞰時の十字架かざしテスト＋proxy足元リング更新
function updateOverview() {
  if (!overview) return;
  if (playerProxy && playerRing) { playerRing.position.x = playerProxy.position.x; playerRing.position.z = playerProxy.position.z; }
  if (crossUpTest && headNode && npcRoot.visible) {
    headNode.getWorldPosition(_v); headNode.getWorldQuaternion(_bq);
    _v.addScaledVector(_hFwd.copy(headFace).applyQuaternion(_bq), 0.26);
    cross.position.copy(_v); crossHeld = true; crossHolder = 'test';
  } else if (crossHolder === 'test' && !crossUpTest) { releaseCross(); }
  // 口アンカー可視化（bite-editor風）：彼女の唇(mouth) と 狙い点(プレイヤー顔) と 連結線
  if (mouthMarker && headNode) {
    headNode.getWorldPosition(_hp); headNode.getWorldQuaternion(_bq);
    _mouth.copy(headFace).multiplyScalar(kissCfg.fwd); _mouth.y += kissCfg.up; _mouth.applyQuaternion(_bq).add(_hp);
    playerHead(_lp); _dh.copy(_hp).sub(_lp); _dh.y = 0; if (_dh.lengthSq() > 1e-6) _dh.normalize();
    _ktar.copy(_lp).addScaledVector(_dh, kissCfg.gap);
    mouthMarker.position.copy(_mouth); mouthMarker.visible = npcRoot.visible;
    faceMarker.position.copy(_ktar); faceMarker.visible = true;
    const pa = linkLine.geometry.attributes.position; pa.setXYZ(0, _mouth.x, _mouth.y, _mouth.z); pa.setXYZ(1, _ktar.x, _ktar.y, _ktar.z); pa.needsUpdate = true;
    linkLine.visible = npcRoot.visible;
  }
  // グラブ点（両肩）可視化
  if (grabMarkerL) {
    const show = GRAB.enabled && npcRoot.visible;
    if (show) { computeGrabTargets(_gpL, _gpR); grabMarkerL.position.copy(_gpL); grabMarkerR.position.copy(_gpR); }
    grabMarkerL.visible = grabMarkerR.visible = show;
  }
  // プレイヤー視界カメラ：ゴーグル位置から、見えていれば吸血鬼の顔を見る
  if (pipCamera && playerProxy) {
    pipCamera.position.copy(playerProxy.position);
    if (npcRoot.visible && headNode) { headNode.getWorldPosition(_hp); pipCamera.lookAt(_hp); }
    else pipCamera.lookAt(playerProxy.position.x, playerProxy.position.y, playerProxy.position.z - 2);
  }
}
// プレイヤー視界を右下のサブ画面(PiP)に描画（自分の頭・狙い点マーカーは隠す）
function renderPip() {
  if (!pipCamera) return;
  const PW = 300, PH = 200, M = 12, px = innerWidth - PW - M, py = M;   // 原点は左下→右下へ
  const hide = [playerProxy, playerRing, faceMarker], vis = hide.map((o) => o && o.visible);
  hide.forEach((o) => { if (o) o.visible = false; });
  renderer.setScissorTest(true);
  renderer.setViewport(px, py, PW, PH); renderer.setScissor(px, py, PW, PH);
  pipCamera.aspect = PW / PH; pipCamera.updateProjectionMatrix();
  renderer.render(scene, pipCamera);
  renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
  hide.forEach((o, i) => { if (o) o.visible = vis[i]; });
}

// ── Enemy エディタ（俯瞰内・アニメ/効果音/挙動を設定→ public/vamp_param/vamp-enemy.json へ上書き保存）──
// アニメ候補は public/timeline フォルダから動的に取得（下は取得失敗時のフォールバック）
let ANIM_OPTIONS = [['eri_model_walk.timeline.json', 'eri_model_walk'], ['eri_Fly_idle.timeline.json', 'eri_Fly_idle']];
async function loadTimelineList() {
  for (const u of ['/timeline/manifest.json?ext=timeline.json', '../timeline/manifest.json?ext=timeline.json']) {
    try {
      const files = await (await fetch(u)).json();
      if (Array.isArray(files) && files.length) { ANIM_OPTIONS = files.slice().sort().map((f) => [f, f.replace(/\.timeline\.json$/, '')]); return; }
    } catch { /* next */ }
  }
}
const SFX_OPTIONS = [['', '（なし）'], ['fat02.ogg', 'fat02(吸血)'], ['basa.ogg', 'basa(羽)'], ['basa2.ogg', 'basa2'], ['basa3.ogg', 'basa3'], ['chu1.ogg', 'chu1'], ['chu2.ogg', 'chu2'], ['chu3.ogg', 'chu3'], ['chuchu1.ogg', 'chuchu1'], ['chuchu2.ogg', 'chuchu2'], ['chupo1.ogg', 'chupo1'], ['chupo2.ogg', 'chupo2'], ['chupo3.ogg', 'chupo3'], ['aura2.ogg', 'aura2'], ['grind1.ogg', 'grind1'], ['心臓音03.ogg', '心臓音03'], ['心臓音04.ogg', '心臓音04'], ['eject.ogg', 'eject']];
const BGM_OPTIONS = [['se1.ogg', 'se1']];
const PARAM_FIELDS = [['nightSec', '夜の長さ(秒)', 30, 900, 10], ['kissToLose', 'ダウンまで(キス秒)', 3, 30, 1], ['walkSpeed', '歩き速度', 0.2, 2, 0.05], ['flySpeed', '降下速度', 0.2, 2, 0.05], ['animSpeed', 'アニメ速度', 0.3, 1.5, 0.05], ['spawnGapMin', '出現間隔min(秒)', 0.5, 10, 0.5], ['spawnGapMax', '出現間隔max(秒)', 1, 15, 0.5], ['ceilingChance', '天井から確率', 0, 1, 0.05], ['circleChance', '回り込み確率', 0, 1, 0.05]];
const EN_STATES = ['spawn_wall', 'spawn_ceiling', 'approach_walk', 'approach_fly', 'kiss', 'repelled'];
let preview = false;
function buildEnemyEditor() {
  const host = $('enemy-body'); if (!host) return;
  const selOpts = (arr, cur) => arr.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${l}</option>`).join('');
  const rowStyle = 'style="border-top:1px solid #223;padding:7px 0;"';
  const selS = 'style="width:100%;background:#1a2030;color:#cfe;border:1px solid #345;border-radius:4px;padding:3px;margin-top:2px;"';
  let html = '<div style="color:#9ab;font-size:10px;line-height:1.4;margin-bottom:4px;">各ステートの再生アニメ・効果音・挙動を設定。▶で即プレビュー（この間ゲームは一時停止）。変更は自動保存。</div>';
  for (const st of EN_STATES) {
    const c = ENEMY.states[st];
    html += `<div ${rowStyle}><div style="font-weight:bold;color:#f9a;display:flex;justify-content:space-between;align-items:center;">${STATE_LABELS[st]}<button class="ep" data-st="${st}" style="background:#38607a;border:none;color:#fff;border-radius:4px;padding:2px 9px;cursor:pointer;font-size:11px;">▶再生</button></div>`;
    html += `<label style="display:block;margin-top:3px;">アニメ<select class="ea" data-st="${st}" ${selS}>${selOpts(ANIM_OPTIONS, c.anim)}</select></label>`;
    html += `<label style="display:block;margin-top:3px;">効果音<select class="es" data-st="${st}" ${selS}>${selOpts(SFX_OPTIONS, c.sfx || '')}</select></label>`;
    html += `<div style="display:flex;gap:6px;margin-top:3px;align-items:center;"><select class="em" data-st="${st}" style="flex:1;background:#1a2030;color:#cfe;border:1px solid #345;border-radius:4px;padding:3px;"><option value="oneshot"${c.sfxMode !== 'loop' ? ' selected' : ''}>1回</option><option value="loop"${c.sfxMode === 'loop' ? ' selected' : ''}>ループ</option></select><span style="font-size:10px;">音量</span><input type="range" class="ev" data-st="${st}" min="0" max="1" step="0.05" value="${c.vol ?? 0.9}" style="flex:1;"></div>`;
    html += exprEditorHtml(st, c);
    html += `</div>`;
  }
  html += '<div style="border-top:1px solid #345;margin-top:8px;padding-top:6px;font-weight:bold;color:#9fe6ff;">挙動パラメータ</div>';
  for (const [k, l, mn, mx, sp] of PARAM_FIELDS) html += `<label style="display:block;margin-top:4px;font-size:11px;">${l} <span id="epv-${k}">${ENEMY.params[k]}</span><br><input type="range" class="epa" data-k="${k}" min="${mn}" max="${mx}" step="${sp}" value="${ENEMY.params[k]}" style="width:100%;"></label>`;
  html += `<label style="display:block;margin-top:8px;">BGM<select id="en-bgm" ${selS}>${selOpts(BGM_OPTIONS, ENEMY.bgm)}</select></label>`;
  html += `<label style="display:block;margin-top:3px;">BGM音量 <span id="en-bgmv">${ENEMY.bgmVol}</span><br><input type="range" id="en-bgmvol" min="0" max="1" step="0.05" value="${ENEMY.bgmVol}" style="width:100%;"></label>`;
  html += `<button id="enemy-save" style="margin-top:10px;width:100%;padding:9px;background:#6a2b4a;border:none;border-radius:5px;color:#fff;cursor:pointer;">💾 敵設定を保存（vamp-enemy.json）</button>`;
  host.innerHTML = html;
  host.querySelectorAll('.ea').forEach((el) => el.addEventListener('change', async (e) => { const st = e.target.dataset.st; ENEMY.states[st].anim = e.target.value; await getAnim(e.target.value); scheduleSaveEnemy(); }));
  host.querySelectorAll('.es').forEach((el) => el.addEventListener('change', (e) => { const st = e.target.dataset.st; ENEMY.states[st].sfx = e.target.value; if (e.target.value) sfxEl(e.target.value); scheduleSaveEnemy(); }));
  host.querySelectorAll('.em').forEach((el) => el.addEventListener('change', (e) => { ENEMY.states[e.target.dataset.st].sfxMode = e.target.value; scheduleSaveEnemy(); }));
  host.querySelectorAll('.ev').forEach((el) => el.addEventListener('input', (e) => { ENEMY.states[e.target.dataset.st].vol = +e.target.value; scheduleSaveEnemy(); }));
  host.querySelectorAll('.ep').forEach((el) => el.addEventListener('click', (e) => previewState(e.target.dataset.st)));
  host.querySelectorAll('.epa').forEach((el) => el.addEventListener('input', (e) => { const k = e.target.dataset.k; ENEMY.params[k] = +e.target.value; const s = $('epv-' + k); if (s) s.textContent = ENEMY.params[k]; scheduleSaveEnemy(); }));
  const bg = $('en-bgm'); if (bg) bg.addEventListener('change', (e) => { ENEMY.bgm = e.target.value; initBGM(); scheduleSaveEnemy(); });
  const bv = $('en-bgmvol'); if (bv) bv.addEventListener('input', (e) => { ENEMY.bgmVol = +e.target.value; if (bgm.el) bgm.el.volume = ENEMY.bgmVol; const s = $('en-bgmv'); if (s) s.textContent = ENEMY.bgmVol; scheduleSaveEnemy(); });
  bindExprEditor(host);
  const sb = $('enemy-save'); if (sb) sb.addEventListener('click', () => saveEnemy(true));
}
// ── ステートごとの表情タイムライン編集UI ──
function exprEditorHtml(st, c) {
  const tr = c.expr || (c.expr = { dur: 2, loop: true, keys: [] });
  const opts = listExpressions(vrm).map((n) => `<option value="${n}">${n}</option>`).join('');
  const inS = 'style="width:46px;background:#1a2030;color:#cfe;border:1px solid #345;border-radius:3px;"';
  let h = `<div style="margin-top:5px;border-top:1px dashed #334;padding-top:4px;">`;
  h += `<div style="display:flex;align-items:center;gap:5px;font-size:10px;color:#9fe6ff;">表情タイムライン`;
  h += `<label style="color:#9ab;">尺<input type="number" class="xd" data-st="${st}" value="${tr.dur}" step="0.1" min="0.1" ${inS}></label>`;
  h += `<label style="color:#9ab;cursor:pointer;"><input type="checkbox" class="xl" data-st="${st}" ${tr.loop ? 'checked' : ''}>ループ</label></div>`;
  tr.keys.slice().sort((a, b) => a.t - b.t).forEach((k, i) => {
    const list = Object.entries(k.v || {}).map(([n, v]) => `${n}:${(+v).toFixed(2)}`).join(' ') || '（なし）';
    h += `<div style="display:flex;align-items:center;gap:4px;margin-top:2px;font-size:10px;">`;
    h += `<input type="number" class="xt" data-st="${st}" data-i="${i}" value="${k.t}" step="0.05" min="0" ${inS}>s`;
    h += `<span style="flex:1;color:#ccd;overflow:hidden;text-overflow:ellipsis;">${list}</span>`;
    h += `<button class="xk" data-st="${st}" data-i="${i}" title="いま表示中の表情をこのキーへ焼き込む" style="background:#2a4a6a;border:none;color:#fff;border-radius:3px;cursor:pointer;">録</button>`;
    h += `<button class="xr" data-st="${st}" data-i="${i}" title="削除" style="background:#5a2a2a;border:none;color:#fff;border-radius:3px;cursor:pointer;">×</button></div>`;
  });
  h += `<div style="display:flex;gap:4px;margin-top:3px;align-items:center;">`;
  h += `<select class="xn" data-st="${st}" style="flex:1;background:#1a2030;color:#cfe;border:1px solid #345;border-radius:3px;font-size:10px;">${opts}</select>`;
  h += `<input type="range" class="xw" data-st="${st}" min="0" max="1" step="0.05" value="1" style="flex:1;">`;
  h += `<button class="xa" data-st="${st}" title="選んだ表情と強さでキーを追加" style="background:#2b6a4a;border:none;color:#fff;border-radius:3px;padding:1px 7px;cursor:pointer;">＋キー</button></div></div>`;
  return h;
}
function bindExprEditor(host) {
  const trOf = (st) => (ENEMY.states[st].expr || (ENEMY.states[st].expr = { dur: 2, loop: true, keys: [] }));
  const sorted = (st) => trOf(st).keys.slice().sort((a, b) => a.t - b.t);
  host.querySelectorAll('.xd').forEach((el) => el.addEventListener('change', (e) => { trOf(e.target.dataset.st).dur = Math.max(0.1, +e.target.value); scheduleSaveEnemy(); }));
  host.querySelectorAll('.xl').forEach((el) => el.addEventListener('change', (e) => { trOf(e.target.dataset.st).loop = e.target.checked; scheduleSaveEnemy(); }));
  host.querySelectorAll('.xt').forEach((el) => el.addEventListener('change', (e) => {
    const k = sorted(e.target.dataset.st)[+e.target.dataset.i];
    if (k) { k.t = Math.max(0, +e.target.value); scheduleSaveEnemy(); buildEnemyEditor(); }
  }));
  host.querySelectorAll('.xr').forEach((el) => el.addEventListener('click', (e) => {
    const st = e.target.dataset.st, t = trOf(st), k = sorted(st)[+e.target.dataset.i];
    const j = t.keys.indexOf(k); if (j >= 0) t.keys.splice(j, 1);
    scheduleSaveEnemy(); buildEnemyEditor();
  }));
  host.querySelectorAll('.xk').forEach((el) => el.addEventListener('click', (e) => {
    const k = sorted(e.target.dataset.st)[+e.target.dataset.i];
    if (!k || !vrm) return;
    const v = {};
    for (const n of listExpressions(vrm)) { const w = vrm.expressionManager.getValue(n) || 0; if (w > 0.001) v[n] = +w.toFixed(2); }
    k.v = v; scheduleSaveEnemy(); buildEnemyEditor();
  }));
  host.querySelectorAll('.xa').forEach((el) => el.addEventListener('click', (e) => {
    const st = e.target.dataset.st, t = trOf(st);
    const name = host.querySelector(`.xn[data-st="${st}"]`) && host.querySelector(`.xn[data-st="${st}"]`).value;
    const w = +((host.querySelector(`.xw[data-st="${st}"]`) || {}).value ?? 1);
    if (!name) return;
    const at = t.keys.length ? Math.max(...t.keys.map((k) => k.t)) + 0.5 : 0;
    t.keys.push({ t: +Math.min(at, t.dur).toFixed(2), v: { [name]: w } });
    scheduleSaveEnemy(); buildEnemyEditor();
  }));
  // スライダーで即プレビュー（当たりを見ながら決められる）
  host.querySelectorAll('.xw').forEach((el) => el.addEventListener('input', (e) => {
    const st = e.target.dataset.st;
    const sel = host.querySelector(`.xn[data-st="${st}"]`);
    if (sel && vrm) { try { vrm.expressionManager.setValue(sel.value, +e.target.value); } catch { /* noop */ } }
  }));
}

function previewState(stateId) {   // エディタで即実演（ゲームは一時停止＝preview中）
  preview = true;
  if (overview && playerProxy) npcRoot.position.set(playerProxy.position.x, 0, playerProxy.position.z - 1.3);
  npcRoot.visible = true; V.state = stateId; V.t = 0;
  applyStatePresentation(stateId);
}
let _enemySaveTimer = null;
function scheduleSaveEnemy() { if (_enemySaveTimer) clearTimeout(_enemySaveTimer); _enemySaveTimer = setTimeout(() => saveEnemy(false), 500); }
async function saveEnemy(manual) {
  const body = JSON.stringify({ dir: 'vamp_param', filename: 'vamp-enemy.json', content: JSON.stringify({ states: ENEMY.states, bgm: ENEMY.bgm, bgmVol: ENEMY.bgmVol, params: ENEMY.params }, null, 2) });
  let ok = false; try { ok = (await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).ok; } catch { /* devサーバ無 */ }
  if (manual) { const b = $('enemy-save'); if (b) { b.textContent = ok ? '✓ vamp_param に上書き保存' : '↓ DL（devサーバ無）'; if (!ok) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ states: ENEMY.states, bgm: ENEMY.bgm, bgmVol: ENEMY.bgmVol, params: ENEMY.params }, null, 2)], { type: 'application/json' })); a.download = 'vamp-enemy.json'; a.click(); } setTimeout(() => { b.textContent = '💾 敵設定を保存（vamp-enemy.json）'; }, 1600); } }
}
function openEnemyEditor() { if ($('enemy-panel')) $('enemy-panel').style.display = 'flex'; preview = true; }
function closeEnemyEditor() { if ($('enemy-panel')) $('enemy-panel').style.display = 'none'; preview = false; }

// ── 起動 ── （敵設定・アニメ・SFX・BGM は loadVampire 内で読込）
loadVampire().then(() => { $('btn-start').disabled = false; if ($('btn-overview')) $('btn-overview').disabled = false; loadTimelineList().then(buildEnemyEditor); }).catch((e) => { setStatus('読み込み失敗: ' + e.message); console.error(e); });
if ($('btn-enemy')) $('btn-enemy').addEventListener('click', openEnemyEditor);
if ($('enemy-close')) $('enemy-close').addEventListener('click', closeEnemyEditor);
$('btn-start').addEventListener('click', startGame);
$('btn-retry').addEventListener('click', startGame);
if ($('btn-overview')) $('btn-overview').addEventListener('click', enterOverview);
if ($('ov-height')) $('ov-height').addEventListener('input', (e) => { if (playerProxy) playerProxy.position.y = +e.target.value; if ($('ov-height-v')) $('ov-height-v').textContent = (+e.target.value).toFixed(2); });
if ($('ov-cross')) { const b = $('ov-cross'); const dn = (ev) => { ev.preventDefault(); crossUpTest = true; b.style.background = '#8a3'; }; const up = () => { crossUpTest = false; b.style.background = ''; }; b.addEventListener('pointerdown', dn); addEventListener('pointerup', up); b.addEventListener('pointerleave', up); }
// C キー＝十字架をかざす（俯瞰モードで手が無いとき用）
addEventListener('keydown', (e) => { if ((e.key === 'c' || e.key === 'C') && !e.repeat) crossUpTest = true; });
addEventListener('keyup', (e) => { if (e.key === 'c' || e.key === 'C') crossUpTest = false; });
// 無敵モード
if ($('chk-invincible')) $('chk-invincible').addEventListener('change', (e) => { invincible = e.target.checked; });
// キス位置調整スライダー（口の前後/上下/密着ギャップ/前傾）→ kissCfg。保存(JSON DL)＋起動時に反映
const KISS_SLIDERS = [['kiss-fwd', 'fwd', 3], ['kiss-up', 'up', 3], ['kiss-gap', 'gap', 3], ['kiss-lean', 'lean', 2]];
function syncKissSliders() { for (const [id, key, d] of KISS_SLIDERS) { const el = $(id); if (!el) continue; el.value = kissCfg[key]; const lab = $(id + '-v'); if (lab) lab.textContent = (+kissCfg[key]).toFixed(d); } }
for (const [id, key, d] of KISS_SLIDERS) { const el = $(id); if (!el) continue; el.addEventListener('input', (e) => { kissCfg[key] = +e.target.value; const lab = $(id + '-v'); if (lab) lab.textContent = kissCfg[key].toFixed(d); try { localStorage.setItem('arvamp-kiss', JSON.stringify(kissCfg)); } catch { /* noop */ } scheduleAutoSave(); }); }
syncKissSliders();
// 調整値の保存：dev サーバの /api/save で public/vamp_param/vamp-tune.json を直接“上書き”。値変更で自動保存＋ボタンで手動保存。
const TUNE_JSON = () => JSON.stringify({ kiss: { ...kissCfg }, grab: { ...GRAB } }, null, 2);
async function writeTuneToDisk() {
  try {
    const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'vamp_param', filename: 'vamp-tune.json', content: TUNE_JSON() }) });
    return r.ok;
  } catch { return false; }   // dev サーバが無い（dist）等
}
let _saveTimer = null;
function scheduleAutoSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(() => { writeTuneToDisk(); }, 500); }   // 変更を 0.5s デバウンスで固定場所へ上書き
function saveTune() {   // 手動保存ボタン。devサーバへ上書き、無ければダウンロードにフォールバック
  try { localStorage.setItem('arvamp-kiss', JSON.stringify(kissCfg)); } catch { /* noop */ }
  const b = $('ov-save'); const t0 = '💾 調整値を保存（vamp_param へ上書き）';
  writeTuneToDisk().then((ok) => {
    if (!b) return;
    if (ok) { b.textContent = '✓ vamp_param に上書き保存'; }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([TUNE_JSON()], { type: 'application/json' })); a.download = 'vamp-tune.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); b.textContent = '↓ DL（devサーバ無）'; }
    setTimeout(() => { b.textContent = t0; }, 1600);
  });
}
async function loadTune() {
  let fromFile = false;   // 保存ファイル(public/vamp_param)を最優先で反映。無ければ localStorage
  for (const u of ['./vamp-tune.json', '../vamp_param/vamp-tune.json', '../vamp-tune.json']) { try { const t = JSON.parse(await (await fetch(u)).text()); if (t && (t.kiss || t.grab)) { if (t.kiss) Object.assign(kissCfg, t.kiss); if (t.grab) Object.assign(GRAB, t.grab); fromFile = true; break; } } catch { /* next */ } }
  if (!fromFile) { try { const s = JSON.parse(localStorage.getItem('arvamp-kiss') || 'null'); if (s) Object.assign(kissCfg, s); } catch { /* noop */ } }
  syncKissSliders(); syncGrabUI();
}
// グラブ(腕IK)UI
const GRAB_SLIDERS = [['grab-side', 'side', 3], ['grab-down', 'down', 3], ['grab-fwd', 'fwd', 3]];
function syncGrabUI() { const c = $('grab-en'); if (c) c.checked = GRAB.enabled; for (const [id, key, d] of GRAB_SLIDERS) { const el = $(id); if (!el) continue; el.value = GRAB[key]; const lab = $(id + '-v'); if (lab) lab.textContent = (+GRAB[key]).toFixed(d); } }
if ($('grab-en')) $('grab-en').addEventListener('change', (e) => { GRAB.enabled = e.target.checked; scheduleAutoSave(); });
for (const [id, key, d] of GRAB_SLIDERS) { const el = $(id); if (!el) continue; el.addEventListener('input', (e) => { GRAB[key] = +e.target.value; const lab = $(id + '-v'); if (lab) lab.textContent = GRAB[key].toFixed(d); scheduleAutoSave(); }); }
if ($('ov-save')) $('ov-save').addEventListener('click', saveTune);
loadTune();
window.__game = { get V() { return V; }, get phase() { return phase; }, startGame, camera, controls, get npcRoot() { return npcRoot; }, get hips() { return hipsNode; }, get head() { return headNode; }, get hipsRest() { return hipsRest; }, get blf() { return bodyLocalFwd; }, get headFace() { return headFace; }, get cape() { return cape; }, get tl() { return { anims: Object.keys(animCache), curFps }; }, get enemy() { return ENEMY; },
  testCrossUp() { if (headNode) { headNode.getWorldPosition(_v); headNode.getWorldQuaternion(_bq); _v.addScaledVector(_hFwd.copy(headFace).applyQuaternion(_bq), 0.25); cross.position.copy(_v); crossHeld = true; crossHolder = 'test'; } },
  forceState: (st) => { V.state = st; V.t = 0; },
  get proxy() { return playerProxy; }, enterOverview, setCrossUp: (v) => { crossUpTest = v; },
  get kissCfg() { return kissCfg; }, set invincible(v) { invincible = v; }, get invincible() { return invincible; },
  mouthWorld() { if (!headNode) return null; headNode.getWorldPosition(_hp); headNode.getWorldQuaternion(_bq); return _mouth.copy(headFace).multiplyScalar(kissCfg.fwd).setY(kissCfg.up).applyQuaternion(_bq).add(_hp).clone(); },
  get grab() { return GRAB; },
  grabTargets() { computeGrabTargets(_gpL, _gpR); return { l: _gpL.clone(), r: _gpR.clone() }; },
  handWorld() { return { l: armL?.end ? armL.end.getWorldPosition(new THREE.Vector3()) : null, r: armR?.end ? armR.end.getWorldPosition(new THREE.Vector3()) : null }; } };
