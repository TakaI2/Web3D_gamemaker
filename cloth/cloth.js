import * as THREE from 'https://esm.sh/three@0.184.0/webgpu';
import {
  Fn, If, Return,
  instancedArray, instanceIndex, uniform,
  select, attribute, Loop, float,
  transformNormalToView, cross, triNoise3D, time,
  frontFacing, dFdx, dFdy, positionView, texture, uv,
} from 'https://esm.sh/three@0.184.0/tsl';
import { OrbitControls } from 'https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js';
import { UltraHDRLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/UltraHDRLoader.js';
import { FBXLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, MToonMaterialLoaderPlugin, VRMUtils } from 'https://esm.sh/@pixiv/three-vrm@3.5.3?deps=three@0.184.0';
import { MToonNodeMaterial } from 'https://esm.sh/@pixiv/three-vrm@3.5.3/nodes?deps=three@0.184.0';

// ---- Cloth geometry constants ----
const sphereRadius  = 0.15;
const CLOTH_SPACING = 1.3; // インスタンス間隔 (m)

// ---- Shape params (UI で変更可) ----
const shapeParams = {
  type:         'rect',  // 'rect' | 'trapezoid' | 'semicircle' | 'circle'
  holeD:        0.3,     // circle: 中心穴の直径(m)。穴の円周が固定点になる
  holeRatio:    1.0,     // circle: 穴の縦横比（Z/X。体形合わせ用の楕円化）
  slitN:        0,       // circle: スリット本数（0=なし）
  slitDepth:    0.5,     // circle: スリット深さ（裾からの割合 0-0.9）
  slitRot:      0,       // circle: スリット位置の回転(度)
  topWidth:     1.0,
  bottomWidth:  1.0,
  height:       1.0,
  pinCount:     7,       // 上端に打つピン数
  topCurve:     0.0,     // 上端曲率: + で中央が前へ（肩フィット）, - で後ろへ。semicircleは弧長保存カール（±1=完全な輪）
  topRatio:     1.0,     // semicircle: カールで出来る輪の縦横比（Z/X。円布の穴と同じ体形合わせ）
  arcAngle:     180,     // semicircle の中心角（度）: 30〜360
  hemJag:       0.0,     // 下端ギザギザの深さ(m): 0=なし
  hemTeeth:     6,       // 下端ギザギザの歯数
  collar:       false,   // 衿を有効にするか
  collarHeight: 0.2,     // 衿の高さ
  collarFlare:  0.5,     // 衿の広がり係数（0=直筒, 1=ラッパ状）
  collarCurve:  0.0,     // 衿上端の前後カーブ（+ で前方へ, - で後方へ）※直線襟のみ
  collarFold:   0.0,     // リング襟の折り返し（0=直立 → 1=外へ180°めくれて垂れる）
  collarAngle:  0,       // リング襟の付け根の倒し角(度)。0=直立・+=外へ倒す・-=内へ倒す
  collarTaper:  0.0,     // リング襟の前細り（前合わせに近づくほど襟を低く。1=前でゼロ）
  collarSpline: false,   // リング襟のプロファイルをスプラインで編集（角度/折り返しの代わり）
  collarProfile: null,   // スプライン制御点 [[外向きm, 高さm], ...]（先頭に暗黙の(0,0)）
  topRotX:      0,       // (旧・後方互換) 上端の回転X。topRows未設定時に第1段へ移行される
  topRotY:      0,       // (旧・後方互換)
  topRotZ:      0,       // (旧・後方互換)
  topRows:      null,    // semicircle: 上端3段の [[回転X,回転Y,回転Z,上下m,曲率|null,縦横比|null,前後m], ...]（null=上段を継承）
  topRowPin:    null,    // semicircle: 第2/第3段をピン留めするか [段2, 段3]（ピン列は上端と同じ）
  topShapeOn:   false,   // semicircle: 上から見た襟ぐり形状をスプラインで指定（左右対称・完全な輪）
  topShape:     null,    // 右半分の制御点 [[x,z],...] ワールド座標。先頭=前中心(x=0)・末尾=後ろ中心(x=0)
};

// ---- Picking constants ----
const GRAB_NONE        = -1;      // grabbedIndexUniform の「掴みなし」値
const GRAB_THRESHOLD_PX = 32;    // スクリーン上の最大ピッキング距離 (px)

// ---- Mutable settings ----
let clothNumSegments = 30;
let instanceCount    = 1;
let simRunning       = true;
let customCloth      = null;   // FBX取込マント {basePositions, positions, springs, renderMap, renderIndex, renderUv, tex, pins:Set}
let pinEditMode      = false;  // 📌 ピン編集モード（クリックで頂点の固定/解除）
let pinGroup         = null;   // ピン可視化マーカー群

// ---- Scene ----
let renderer, scene, camera, controls;
let timeSinceLastStep = 0;
let timestamp         = 0;

// ---- Shared uniforms (全インスタンス共通) ----
let stiffnessUniform;
let dampeningUniform;
let windUniform;
let sphereVisibleUniform;

// ---- Shared color uniforms ----
let frontColorUniform;
let backColorUniform;

// ---- Instance list ----
const instances = [];

// ---- FPS ----
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ---- Grab state ----
const grab = {
  active:      false,
  instanceIdx: -1,
  vertexIdx:   -1,
  dragPlane:   new THREE.Plane(),
  raycaster:   new THREE.Raycaster(),
  highlightMesh: null,
  // クリック時に1回だけ readback する CPU 座標スナップショット（インスタンス毎）
  snapshots:       [],   // Float32Array[], indexed by instances index
  pendingDown:     false, // pointerdown→readback完了までの保留中フラグ
};

// ---- Runtime params ----
const params = {
  wireframe: false,
  sphere:    true,
  wind:      1.0,
};
const matParams = {
  colorFront:     '#204080',
  colorBack:      '#803020',
  roughness:      1.0,
  sheen:          1.0,
  sheenRoughness: 0.5,
  sheenColor:     '#ffffff',
  opacity:        0.85,
};

const timer = new THREE.Timer();
timer.connect(document);

// ============================================================
// Per-instance creation / teardown
// ============================================================

/**
 * グリッド上の (xi, yi) → ワールド座標 を返す。
 * yi=0 が上端（ピン行）、yi=segs が下端。
 */
function calcVertexPos(xi, yi, segs, sp) {
  const t = yi / segs; // 0=上端, 1=下端

  // X・Z: 形状に応じて計算
  let posX;
  let posZArcFactor = 1.0; // Z = t * height * posZArcFactor (semicircle のみ変化)

  let semiTopZ = null;   // semicircle: 上端カール由来のZ（generic curveOffsetを置き換える）
  if (sp.type === 'trapezoid') {
    // 上から下へ topWidth→bottomWidth にリニア補間
    const halfW = (sp.topWidth + (sp.bottomWidth - sp.topWidth) * t) * 0.5;
    posX = (xi / segs) * 2 * halfW - halfW;
  } else if (sp.type === 'semicircle') {
    // 上端は topWidth の直線、下端は arcAngle 度の円弧
    // 両端が Z=0、中央が Z=height となるように正規化する
    const halfArc   = (sp.arcAngle ?? 180) * Math.PI / 180 / 2;
    const angle     = (xi / segs * 2 - 1) * halfArc; // -halfArc 〜 +halfArc
    const cosHalf   = Math.cos(halfArc);
    // (cos(angle) - cos(halfArc)) / (1 - cos(halfArc)) → 両端=0、中央=1
    posZArcFactor   = (Math.cos(angle) - cosHalf) / (1 - cosHalf + 1e-9);
    // 上端曲率: 直線を弧長保存のまま丸める。±1で完全な円（円布の穴のように首を囲む輪）。符号=巻く向き
    const [c, cRatio] = rowCurveAt(sp, Math.min(2, yi));   // 段ごとの実効曲率/縦横比
    const sPos = (xi / segs - 0.5) * sp.topWidth;   // 上端の弧長座標
    let topX = sPos, topZ = 0;
    if (sp.topShapeOn && Array.isArray(sp.topShape) && sp.topShape.length >= 3) {
      const q = lutPoint(getTopLUT(sp), xi / segs);   // 上面スプライン（完全な輪・前中心が合わせ目）
      topX = -q[0];
      topZ = -q[1];   // ワールド→パラメータ空間（返却時に再負号）
    } else if (Math.abs(c) > 1e-4) {
      const theta = Math.min(1, Math.abs(c)) * Math.PI * 2;   // 巻き込み角（1.0=360°）
      const rho   = sp.topWidth / theta;                       // 円弧半径（弧長=topWidth維持）
      const phi   = sPos / rho;
      topX = rho * Math.sin(phi);
      topZ = Math.sign(c) * rho * (1 - Math.cos(phi)) * cRatio;   // 縦横比＝輪の楕円化（体形合わせ）
    }
    const arcX = Math.sin(angle) * sp.bottomWidth * 0.5;
    posX = topX + (arcX - topX) * t;
    semiTopZ = topZ;
  } else {
    // rect（デフォルト）
    posX = (xi / segs - 0.5) * sp.topWidth;
  }

  // 上端曲率: 半円=弧長保存カール / それ以外=放物線オフセット。下へ向かいフェードアウト
  const nx          = (xi / segs) * 2 - 1;            // -1(左端) 〜 +1(右端)
  const curveOffset = semiTopZ != null ? semiTopZ * (1 - t) : sp.topCurve * (1 - nx * nx) * (1 - t);
  let posZ = t * sp.height * posZArcFactor + curveOffset;

  // 下端ギザギザ: 列ごとの三角波を Z(=裾の長さ)方向に加算。下端付近のみ作用させる。
  if ((sp.hemJag ?? 0) > 0 && (sp.hemTeeth ?? 0) > 0) {
    const phase = (xi / segs) * sp.hemTeeth;
    const frac  = phase - Math.floor(phase);
    const tri   = 1 - Math.abs(frac * 2 - 1);          // 歯の谷=0, 歯先=1 の三角波
    const ramp  = Math.max(0, (t - 0.6) / 0.4);        // t>0.6 で徐々に効かせる（下端で最大）
    posZ += sp.hemJag * tri * ramp;
  }

  let posY = sp.height * 0.5;
  if (sp.type === 'semicircle') {   // 上端3段のトランスフォーム（回転XYZ＋上下）
    const rXf = applyTopRowXform(sp, segs, yi, posX, posY, posZ);
    posX = rXf[0]; posY = rXf[1]; posZ = rXf[2];
  }
  return { posX: -posX, posY, posZ: -posZ };   // VRMの向きに合わせて180°回転（2026-07: マントが背中側に来る）
}

/**
 * 衿頂点 (xi, collarYi) のワールド座標を返す。
 * collarYi=0 がピン行（マント上端と共有）、collarYi=collarSegs が衿の自由端（上端）。
 */
function calcCollarPos(xi, collarYi, collarSegs, segs, sp) {
  const tc  = collarYi / collarSegs;             // 0=ピン行, 1=衿上端
  // 上面スプライン: 襟ぐり曲線に沿って衿を生成（外向き法線＋プロファイルは既存の仕組みを使用）
  if (sp.type === 'semicircle' && sp.topShapeOn && Array.isArray(sp.topShape) && sp.topShape.length >= 3) {
    const lut = getTopLUT(sp);
    const u = xi / segs;
    const q = lutPoint(lut, u);
    const nrm = lutNormal(lut, u);
    const tFront = 1 - Math.min(u, 1 - u) * 2;   // 0=後ろ中心, 1=前(合わせ目)
    const hscale = 1 - (sp.collarTaper ?? 0) * Math.max(0, Math.min(1, tFront));
    const H0 = Math.max(1e-4, sp.collarHeight ?? 0.2);
    let rProf, yProf;
    if (sp.collarSpline && Array.isArray(sp.collarProfile) && sp.collarProfile.length >= 2) {
      const pt = catmullChain([[0, 0], ...sp.collarProfile], tc);
      rProf = pt[0] * hscale;
      yProf = pt[1] * hscale;
    } else {
      const sArc = tc * H0 * hscale;
      const f = sp.collarFold ?? 0;
      const th0 = Math.PI / 2 - (sp.collarAngle ?? 0) * Math.PI / 180;
      if (f > 1e-4) {
        const kap = f * Math.PI / H0;
        rProf = (Math.sin(th0) - Math.sin(th0 - kap * sArc)) / kap;
        yProf = (Math.cos(th0 - kap * sArc) - Math.cos(th0)) / kap;
      } else {
        rProf = sArc * Math.cos(th0);
        yProf = sArc * Math.sin(th0);
      }
      rProf += (sp.collarFlare ?? 0) * tc * 0.25 * hscale;   // フレア（基準0.25m）
    }
    let wx = q[0] + nrm[0] * rProf, wy = sp.height * 0.5 + yProf, wz = q[1] + nrm[1] * rProf;
    const tr0 = Array.isArray(sp.topRows) ? sp.topRows[0] : null;
    if (tr0 && (tr0[0] || tr0[1] || tr0[2] || tr0[3] || tr0[6])) {
      const rr = applyTopRot(
        [wx - lut.cx, wy - sp.height * 0.5, wz - lut.cz],
        (tr0[0] || 0) * Math.PI / 180, (tr0[1] || 0) * Math.PI / 180, (tr0[2] || 0) * Math.PI / 180,
      );
      wx = lut.cx + rr[0];
      wy = sp.height * 0.5 + rr[1] + (tr0[3] || 0);
      wz = lut.cz + rr[2] - (tr0[6] || 0);
    }
    return { posX: wx, posY: wy, posZ: wz };
  }
  // 半円の上端カール中は、衿もリングに追従（ネックラインの外向き法線方向にフレア）
  if (sp.type === 'semicircle' && Math.abs(sp.topCurve ?? 0) > 1e-4) {
    const cc    = sp.topCurve;
    const theta = Math.min(1, Math.abs(cc)) * Math.PI * 2;
    const rho   = sp.topWidth / theta;
    const sPos  = (xi / segs - 0.5) * sp.topWidth;
    const phi   = sPos / rho;
    const sgn   = Math.sign(cc);
    const ratio = sp.topRatio ?? 1;
    const ex = rho * Math.sin(phi), ez = sgn * rho * (1 - Math.cos(phi)) * ratio;   // 上端（ピン行）の点（楕円）
    const rl = Math.hypot(ratio * Math.sin(phi), Math.cos(phi)) || 1;               // 楕円の外向き法線
    const rx = ratio * Math.sin(phi) / rl, rz = -sgn * Math.cos(phi) / rl;
    // 前細り: 前合わせ(|phi|→π)に近づくほど襟を低く（後ろ高・前無しの襟）
    const hscale = 1 - (sp.collarTaper ?? 0) * Math.min(1, Math.abs(phi) / Math.PI);
    const H0 = Math.max(1e-4, sp.collarHeight ?? 0.2);
    const sArc = tc * H0 * hscale;   // プロファイル弧長
    // スプライン編集モード: プロファイル＝制御点のCatmull-Rom（角度/折り返しは無効）
    if (sp.collarSpline && Array.isArray(sp.collarProfile) && sp.collarProfile.length >= 2) {
      const pt = catmullChain([[0, 0], ...sp.collarProfile], tc);
      const spreadS = pt[0] * hscale;
      return {
        posX: -(ex + rx * spreadS),
        posY: sp.height * 0.5 + pt[1] * hscale,
        posZ: -(ez + rz * spreadS),
      };
    }
    // 折り返し: 付け根の倒し角(collarAngle)から始まり、等曲率で外へ湾曲するプロファイル
    const f   = sp.collarFold ?? 0;
    const th0 = Math.PI / 2 - (sp.collarAngle ?? 0) * Math.PI / 180;   // 開始接線角（π/2=直立）
    let rProf, yProf;
    if (f > 1e-4) {
      const kap = f * Math.PI / H0;   // 全長で f×180° 折れる曲率
      rProf = (Math.sin(th0) - Math.sin(th0 - kap * sArc)) / kap;
      yProf = (Math.cos(th0 - kap * sArc) - Math.cos(th0)) / kap;
    } else {
      rProf = sArc * Math.cos(th0);
      yProf = sArc * Math.sin(th0);
    }
    const spread = (sp.collarFlare ?? 0) * tc * Math.min(rho, sp.topWidth * 0.5) * hscale + rProf;
    let px = ex + rx * spread, py = sp.height * 0.5 + yProf, pz = ez + rz * spread;
    const tr0 = Array.isArray(sp.topRows) ? sp.topRows[0] : null;
    if (tr0 && (tr0[0] || tr0[1] || tr0[2] || tr0[3] || tr0[6])) {
      const czC = sgn * rho * ratio;   // リング中心（パラメータ空間）
      const rr = applyTopRot(
        [px, py - sp.height * 0.5, pz - czC],
        -(tr0[0] || 0) * Math.PI / 180, (tr0[1] || 0) * Math.PI / 180, -(tr0[2] || 0) * Math.PI / 180,
      );
      px = rr[0];
      py = sp.height * 0.5 + rr[1] + (tr0[3] || 0);
      pz = czC + rr[2] + (tr0[6] || 0);
    }
    return { posX: -px, posY: py, posZ: -pz };
  }
  const nx  = (xi / segs) * 2 - 1;              // -1(左端) 〜 +1(右端)
  // マント上端の X と同じ基準（t=0 時点）
  const baseX = (xi / segs - 0.5) * sp.topWidth;
  // ラッパ状の広がり: tc が大きいほど外側へ
  const posX  = baseX * (1 + (sp.collarFlare ?? 0) * tc);
  // Y: ピン行から上方へ延伸
  const posY  = sp.height * 0.5 + (sp.collarHeight ?? 0.2) * tc;
  // Z: ピン行の topCurve オフセットから始まり衿上端の collarCurve へ遷移
  const pinZ  = sp.topCurve * (1 - nx * nx);
  const topZ  = (sp.collarCurve ?? 0) * (1 - nx * nx);
  const posZ  = pinZ + (topZ - pinZ) * tc;
  return { posX: -posX, posY, posZ: -posZ };   // 本体と同じ180°回転
}

// Catmull-Rom チェーン補間（u∈0..1 を等分パラメータで走査）
function catmullChain(pts, u) {
  const n = pts.length - 1;
  const f = Math.min(0.9999, Math.max(0, u)) * n;
  const i = Math.floor(f), t = f - i;
  const get = (k) => pts[Math.max(0, Math.min(pts.length - 1, k))];
  const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
  const out = [0, 0];
  for (let a = 0; a < 2; a++) {
    out[a] = 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t
      + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t
      + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t * t * t);
  }
  return out;
}

// XYZ順のオイラー回転（上端の傾き用）
function applyTopRot(p, rx, ry, rz) {
  let x = p[0], y = p[1], z = p[2], c, sn;
  c = Math.cos(rx); sn = Math.sin(rx);
  const y1 = y * c - z * sn, z1 = y * sn + z * c;
  y = y1; z = z1;
  c = Math.cos(ry); sn = Math.sin(ry);
  const x2 = x * c + z * sn, z2 = -x * sn + z * c;
  x = x2; z = z2;
  c = Math.cos(rz); sn = Math.sin(rz);
  const x3 = x * c - y * sn, y3 = x * sn + y * c;
  return [x3, y3, z];
}

// 上端の中心（パラメータ空間）: 上面スプライン=重心 / カール=リング中心 / 直線=原点
function topCenterParam(sp) {
  if (sp.topShapeOn && Array.isArray(sp.topShape) && sp.topShape.length >= 3) {
    const l = getTopLUT(sp);
    return [-l.cx, -l.cz];
  }
  const c = sp.topCurve ?? 0;
  if (Math.abs(c) > 1e-4) {
    return [0, Math.sign(c) * (sp.topWidth / (Math.min(1, Math.abs(c)) * Math.PI * 2)) * (sp.topRatio ?? 1)];
  }
  return [0, 0];
}
// 段iの実効曲率/縦横比（第2・第3段で未設定(null)なら上の段を継承。段1=topCurve/topRatio）
function rowCurveAt(sp, i) {
  let c = sp.topCurve ?? 0, r = sp.topRatio ?? 1;
  const rows = sp.topRows;
  if (Array.isArray(rows)) {
    for (let k = 1; k <= i && k < 3; k++) {
      const tr = rows[k];
      if (tr && tr[4] != null) c = tr[4];
      if (tr && tr[5] != null) r = tr[5];
    }
  }
  return [c, r];
}

// 上端3段のトランスフォーム（回転XYZ＋上下）。段0-2=そのまま、以深は段3の効果を裾へフェード
function applyTopRowXform(sp, segs, yi, px, py, pz) {
  const rows = sp.topRows;
  if (!Array.isArray(rows)) return [px, py, pz];
  const idx = yi <= 2 ? yi : 2;
  const w = yi <= 2 ? 1 : Math.max(0, 1 - (yi - 2) / Math.max(1, segs - 2));
  const tr = rows[idx];
  if (!tr || (!tr[0] && !tr[1] && !tr[2] && !tr[3] && !tr[6]) || w <= 0) return [px, py, pz];
  const C = topCenterParam(sp);
  const H2 = sp.height * 0.5;
  const rr = applyTopRot(
    [px - C[0], py - H2, pz - C[1]],
    -(tr[0] || 0) * Math.PI / 180, (tr[1] || 0) * Math.PI / 180, -(tr[2] || 0) * Math.PI / 180,
  );
  const tx = C[0] + rr[0], ty = H2 + rr[1] + (tr[3] || 0), tz = C[1] + rr[2] + (tr[6] || 0);
  return [px + (tx - px) * w, py + (ty - py) * w, pz + (tz - pz) * w];
}

// ── 上面形状（襟ぐり）LUT: 右半分の制御点→左右対称の閉曲線→弧長均等の256点＋外向き法線 ──
let _topLutKey = null, _topLut = null;
function getTopLUT(sp) {
  const key = JSON.stringify(sp.topShape);
  if (key === _topLutKey && _topLut) return _topLut;
  const right = sp.topShape;
  const C = [...right];
  for (let i = right.length - 2; i >= 1; i--) C.push([-right[i][0], right[i][1]]);   // 左半分=ミラー
  const N = C.length;
  const cat = (u) => {   // 閉曲線Catmull-Rom
    const f = ((u % 1) + 1) % 1 * N;
    const i = Math.floor(f), t = f - i;
    const g = (k) => C[((k % N) + N) % N];
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    const o = [0, 0];
    for (let a = 0; a < 2; a++) {
      o[a] = 0.5 * ((2 * p1[a]) + (-p0[a] + p2[a]) * t
        + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t * t
        + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t * t * t);
    }
    return o;
  };
  // 密サンプル→弧長累積→256点で均等リサンプル
  const M = 512, raw = [], arc = [0];
  for (let k = 0; k <= M; k++) raw.push(cat(k / M));
  for (let k = 1; k <= M; k++) arc.push(arc[k - 1] + Math.hypot(raw[k][0] - raw[k - 1][0], raw[k][1] - raw[k - 1][1]));
  const L = arc[M] || 1;
  const R = 256, pts = new Float32Array(R * 2);
  let j = 0;
  for (let k = 0; k < R; k++) {
    const d = (k / R) * L;
    while (j < M - 1 && arc[j + 1] < d) j++;
    const t = (d - arc[j]) / Math.max(1e-9, arc[j + 1] - arc[j]);
    pts[k * 2]     = raw[j][0] + (raw[j + 1][0] - raw[j][0]) * t;
    pts[k * 2 + 1] = raw[j][1] + (raw[j + 1][1] - raw[j][1]) * t;
  }
  let area = 0;   // 符号付き面積→外向き法線の回転方向
  let cx = 0, cz = 0;
  for (let k = 0; k < R; k++) {
    const k2 = (k + 1) % R;
    area += pts[k * 2] * pts[k2 * 2 + 1] - pts[k2 * 2] * pts[k * 2 + 1];
    cx += pts[k * 2]; cz += pts[k * 2 + 1];
  }
  _topLut = { pts, R, outSign: area > 0 ? 1 : -1, cx: cx / R, cz: cz / R };
  _topLutKey = key;
  return _topLut;
}
function lutPoint(lut, u) {
  const f = ((u % 1) + 1) % 1 * lut.R;
  const i = Math.floor(f) % lut.R, t = f - Math.floor(f);
  const i2 = (i + 1) % lut.R;
  return [
    lut.pts[i * 2] + (lut.pts[i2 * 2] - lut.pts[i * 2]) * t,
    lut.pts[i * 2 + 1] + (lut.pts[i2 * 2 + 1] - lut.pts[i * 2 + 1]) * t,
  ];
}
function lutNormal(lut, u) {
  const f = ((u % 1) + 1) % 1 * lut.R;
  const i = Math.floor(f) % lut.R;
  const a = (i - 1 + lut.R) % lut.R, b = (i + 1) % lut.R;
  const dx = lut.pts[b * 2] - lut.pts[a * 2], dz = lut.pts[b * 2 + 1] - lut.pts[a * 2 + 1];
  const l = Math.hypot(dx, dz) || 1;
  return lut.outSign > 0 ? [dz / l, -dx / l] : [-dz / l, dx / l];
}

function buildVerletGeometry(segs, sp) {
  const verletVertices      = [];
  const verletSprings       = [];
  const verletVertexColumns = [];

  const addVertex = (x, y, z, isFixed) => {
    const id = verletVertices.length;
    const v  = { id, position: new THREE.Vector3(x, y, z), isFixed, springIds: [] };
    verletVertices.push(v);
    return v;
  };
  const addSpring = (v0, v1) => {
    const id = verletSprings.length;
    v0.springIds.push(id);
    v1.springIds.push(id);
    verletSprings.push({ id, vertex0: v0, vertex1: v1 });
  };

  // ── 円形（スカート）: 極座標グリッド。穴は楕円化可・穴の円周(最内リング)が固定点。
  //    分割数はセルが中間半径でほぼ正方形になるよう角度方向を自動算出（放射方向と密度を揃える）。
  //    スリット=列複製のゼロ幅切れ目。描画は1:1直接メッシュ＋近傍法線 ──
  if (sp.type === 'circle') {
    const R   = Math.max(0.05, sp.topWidth) / 2;
    const rxH = Math.min(Math.max(0.01, (sp.holeD ?? 0.3) / 2), R * 0.95);
    const rzH = Math.min(Math.max(0.01, rxH * (sp.holeRatio ?? 1)), R * 0.95);
    // 半径方向 nr=segs/2、角度方向 na=中間楕円の周長/セル寸（正方形セル狙い）
    const cMid  = Math.PI * ((rxH + R) / 2 + (rzH + R) / 2);
    const span  = Math.max(0.02, R - Math.min(rxH, rzH));
    const nr    = Math.max(6, Math.round(segs * 0.5));
    const cell  = span / nr;
    const na    = Math.max(16, Math.min(240, Math.round(cMid / cell)));
    const slitN = Math.max(0, Math.min(6, Math.round(sp.slitN ?? 0)));
    const cutY  = Math.max(1, Math.round(nr * (1 - Math.min(0.9, Math.max(0, sp.slitDepth ?? 0.5)))));
    const slitCols = new Set();
    for (let i = 0; i < slitN; i++) {
      slitCols.add(((Math.round((i / slitN + (sp.slitRot ?? 0) / 360) * na) % na) + na) % na);
    }
    const mkV = (x, y, fixed) => {   // リングごとに楕円→外周円へ補間
      const ang = (x / na) * Math.PI * 2;
      const t = y / nr;
      const rx = rxH + (R - rxH) * t, rz = rzH + (R - rzH) * t;
      return addVertex(-Math.cos(ang) * rx, sp.height * 0.5, -Math.sin(ang) * rz, fixed);   // 本体と同じ180°回転
    };
    const ringCols = [];         // リング順の列シーケンス
    const cutPair  = new Set();  // ringCols[i-1]→[i] 間が切れ目（スリット）
    const rightCol = new Set();  // スリット右列（縦スプリングは複製部のみ）
    for (let x = 0; x < na; x++) {
      if (!slitCols.has(x)) {
        const col = [];
        for (let y = 0; y <= nr; y++) col.push(mkV(x, y, y === 0));
        ringCols.push(col);
      } else {
        const shared = [];
        for (let y = 0; y < cutY; y++) shared.push(mkV(x, y, y === 0));
        const left = shared.slice(), right = shared.slice();
        for (let y = cutY; y <= nr; y++) { left.push(mkV(x, y, false)); right.push(mkV(x, y, false)); }
        ringCols.push(left);
        cutPair.add(ringCols.length);
        rightCol.add(ringCols.length);
        ringCols.push(right);
      }
    }
    ringCols.push(ringCols[0]);   // 閉環（同一頂点＝継ぎ目なし）
    // 縦スプリング（右列は複製部のみ＝共有部の二重張り防止）
    for (let i = 0; i < ringCols.length - 1; i++) {
      const col = ringCols[i];
      for (let y = rightCol.has(i) ? cutY : 1; y <= nr; y++) addSpring(col[y], col[y - 1]);
    }
    // 横・斜めスプリング（切れ目ペアはスキップ）
    for (let i = 1; i < ringCols.length; i++) {
      if (cutPair.has(i)) continue;
      const a = ringCols[i - 1], b = ringCols[i];
      for (let y = 0; y <= nr; y++) {
        addSpring(b[y], a[y]);
        if (y > 0)  addSpring(b[y], a[y - 1]);
        if (y < nr) addSpring(b[y], a[y + 1]);
      }
    }
    // 直接レンダリング（1:1三角形。スリットはゼロ幅で始まり動きで開く）
    const renderIndex = [];
    for (let i = 1; i < ringCols.length; i++) {
      const a = ringCols[i - 1], b = ringCols[i];
      if (cutPair.has(i)) {
        if (cutY >= 1) renderIndex.push(a[cutY - 1].id, b[cutY].id, a[cutY].id);   // スリット頂点部の楔
        continue;
      }
      for (let y = 0; y < nr; y++) {   // 表(front)=円盤の上面＝垂れたときの外側
        renderIndex.push(a[y].id, b[y].id, b[y + 1].id);
        renderIndex.push(a[y].id, b[y + 1].id, a[y + 1].id);
      }
    }
    // 滑らか法線用の近傍ID（L,R,U,D）。境界・スリット断面は自分自身＝片側差分になる
    const n = verletVertices.length;
    const renderMap = new Uint32Array(n);
    const nbIds = new Uint32Array(n * 4);
    for (let i = 0; i < n; i++) {
      renderMap[i] = i;
      nbIds[i*4] = i; nbIds[i*4+1] = i; nbIds[i*4+2] = i; nbIds[i*4+3] = i;
    }
    const setNb = (v, slot, nbV) => { if (nbV.id !== v.id) nbIds[v.id * 4 + slot] = nbV.id; };
    for (let i = 0; i < ringCols.length - 1; i++) {
      const col  = ringCols[i];
      const prev = ringCols[i === 0 ? ringCols.length - 2 : i - 1];
      const next = ringCols[i + 1];
      const cutPrev = cutPair.has(i);
      const cutNext = cutPair.has(i + 1);
      for (let y = 0; y <= nr; y++) {
        const v = col[y];
        if (!(cutPrev && y >= cutY)) setNb(v, 0, prev[y]);
        if (!(cutNext && y >= cutY)) setNb(v, 1, next[y]);
        if (y > 0)  setNb(v, 2, col[y - 1]);
        if (y < nr) setNb(v, 3, col[y + 1]);
      }
    }
    return {
      verletVertices, verletSprings, verletVertexColumns: ringCols, collarColumns: [], collarSegs: 0,
      directRender: { renderMap, renderIndex, nbIds },
    };
  }

  // ピン位置を均等配置で決定（pinCount 本、両端を含む）
  const pinSet = new Set();
  const pc = Math.max(2, sp.pinCount);
  for (let k = 0; k < pc; k++) {
    const xi = Math.round(k / (pc - 1) * segs);
    pinSet.add(Math.min(xi, segs));
  }

  for (let x = 0; x <= segs; x++) {
    const col = [];
    for (let y = 0; y <= segs; y++) {
      const { posX, posY, posZ } = calcVertexPos(x, y, segs, sp);
      const isFixed = pinSet.has(x) && (y === 0
        || (y === 1 && !!sp.topRowPin?.[0])
        || (y === 2 && !!sp.topRowPin?.[1]));
      col.push(addVertex(posX, posY, posZ, isFixed));
    }
    verletVertexColumns.push(col);
  }

  for (let x = 0; x <= segs; x++) {
    for (let y = 0; y <= segs; y++) {
      const v0 = verletVertexColumns[x][y];
      if (x > 0)              addSpring(v0, verletVertexColumns[x-1][y]);
      if (y > 0)              addSpring(v0, verletVertexColumns[x][y-1]);
      if (x > 0 && y > 0)    addSpring(v0, verletVertexColumns[x-1][y-1]);
      if (x > 0 && y < segs) addSpring(v0, verletVertexColumns[x-1][y+1]);
    }
  }

  // ---- 衿 ----
  const collarColumns = [];
  let   collarSegs    = 0;

  if (sp.collar && (sp.collarHeight ?? 0) > 0 && sp.type !== 'circle') {
    collarSegs = 8; // 折り返し/スプラインプロファイルを滑らかに出す分割数

    for (let x = 0; x <= segs; x++) {
      const col = [verletVertexColumns[x][0]]; // ピン行の頂点を共有（cy=0）
      for (let cy = 1; cy <= collarSegs; cy++) {
        const { posX, posY, posZ } = calcCollarPos(x, cy, collarSegs, segs, sp);
        col.push(addVertex(posX, posY, posZ, true)); // 衿は固定（静的メッシュ）
      }
      collarColumns.push(col);
    }

    // スプリング（縦・横・斜め）
    for (let x = 0; x <= segs; x++) {
      for (let cy = 0; cy < collarSegs; cy++) {
        // 縦
        addSpring(collarColumns[x][cy], collarColumns[x][cy + 1]);
        if (x < segs) {
          // 横（cy=0 はメイングリッドで追加済みのためスキップ）
          if (cy + 1 > 0) addSpring(collarColumns[x][cy + 1], collarColumns[x + 1][cy + 1]);
          // 斜め（全 cy で新規）
          addSpring(collarColumns[x][cy],     collarColumns[x + 1][cy + 1]);
          addSpring(collarColumns[x + 1][cy], collarColumns[x][cy + 1]);
        }
      }
    }
  }

  return { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs };
}

function createInstance(segs, offsetX) {
  const custom = customCloth;
  const built = custom ? buildCustomVerlet(custom) : buildVerletGeometry(segs, shapeParams);
  const { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs } = built;
  // 直接レンダリング記述子（FBX取込 or 円形スカート）。無ければ従来のquadセル描画
  const direct = custom
    ? { map: custom.renderMap, idx: custom.renderIndex, uv: custom.renderUv, tex: custom.tex, nb: null }
    : (built.directRender ? { map: built.directRender.renderMap, idx: built.directRender.renderIndex, uv: null, tex: null, nb: built.directRender.nbIds || null } : null);

  // ---- Vertex buffers ----
  const vertexCount     = verletVertices.length;
  const springListArray = [];
  const vertexPosArr    = new Float32Array(vertexCount * 3);
  const vertexParamsArr = new Uint32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    const v = verletVertices[i];
    vertexPosArr[i*3]   = v.position.x;
    vertexPosArr[i*3+1] = v.position.y;
    vertexPosArr[i*3+2] = v.position.z;
    vertexParamsArr[i*3] = v.isFixed ? 1 : 0;
    // スプリング情報は固定頂点にも書く（ピン編集で後から解除しても正しく揺れる）
    vertexParamsArr[i*3+1] = v.springIds.length;
    vertexParamsArr[i*3+2] = springListArray.length;
    springListArray.push(...v.springIds);
  }

  const vertexPositionBuffer = instancedArray(vertexPosArr, 'vec3').setPBO(true);
  const vertexForceBuffer    = instancedArray(vertexCount, 'vec3');
  const vertexParamsBuffer   = instancedArray(vertexParamsArr, 'uvec3');
  const springListBuffer     = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true);

  // ---- Spring buffers ----
  const springCount      = verletSprings.length;
  const springVertIdArr  = new Uint32Array(springCount * 2);
  const springRestLenArr = new Float32Array(springCount);

  for (let i = 0; i < springCount; i++) {
    const s = verletSprings[i];
    springVertIdArr[i*2]   = s.vertex0.id;
    springVertIdArr[i*2+1] = s.vertex1.id;
    springRestLenArr[i]    = s.vertex0.position.distanceTo(s.vertex1.position);
  }

  const springVertexIdBuffer   = instancedArray(springVertIdArr, 'uvec2').setPBO(true);
  const springRestLengthBuffer = instancedArray(springRestLenArr, 'float');
  const springForceBuffer      = instancedArray(springCount * 3, 'vec3').setPBO(true);

  // ---- Per-instance uniforms ----
  const spherePositionUniform  = uniform(new THREE.Vector3(0, 0, 0));
  const grabbedIndexUniform    = uniform(GRAB_NONE);  // float: -1 = no grab
  const grabbedTargetUniform   = uniform(new THREE.Vector3(0, 0, 0)); // local-space target

  // ---- Compute shaders ----
  const computeSpringForces = Fn(() => {
    const vertexIds  = springVertexIdBuffer.element(instanceIndex);
    const restLength = springRestLengthBuffer.element(instanceIndex);
    const v0pos      = vertexPositionBuffer.element(vertexIds.x);
    const v1pos      = vertexPositionBuffer.element(vertexIds.y);
    const delta      = v1pos.sub(v0pos).toVar();
    const dist       = delta.length().max(0.000001).toVar();
    const force      = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist);
    springForceBuffer.element(instanceIndex).assign(force);
  })().compute(springCount).setName('Spring Forces');

  const computeVertexForces = Fn(() => {
    const vparams       = vertexParamsBuffer.element(instanceIndex).toVar();
    const isFixed       = vparams.x;
    const springCnt     = vparams.y;
    const springPointer = vparams.z;

    // 固定頂点はスキップ（固定頂点はグラブも不可）
    If(isFixed, () => { Return(); });

    // ---- グラブ オーバーライド ----
    // float(instanceIndex) と float(grabbedIndexUniform) を比較
    If(float(instanceIndex).equal(float(grabbedIndexUniform)), () => {
      // 速度をゼロにしてターゲット位置へ瞬時移動
      const grabForce = vertexForceBuffer.element(instanceIndex).toVar('grabForce');
      grabForce.mulAssign(0);
      vertexForceBuffer.element(instanceIndex).assign(grabForce);
      vertexPositionBuffer.element(instanceIndex).assign(grabbedTargetUniform);
      Return();
    });

    const position = vertexPositionBuffer.element(instanceIndex).toVar('vertexPosition');
    const force    = vertexForceBuffer.element(instanceIndex).toVar('vertexForce');

    force.mulAssign(dampeningUniform);

    const ptrStart = springPointer.toVar('ptrStart');
    const ptrEnd   = ptrStart.add(springCnt).toVar('ptrEnd');

    Loop({ start: ptrStart, end: ptrEnd, type: 'uint', condition: '<' }, ({ i }) => {
      const springId      = springListBuffer.element(i).toVar('springId');
      const springForce   = springForceBuffer.element(springId);
      const springVertIds = springVertexIdBuffer.element(springId);
      const factor        = select(springVertIds.x.equal(instanceIndex), 1.0, -1.0);
      force.addAssign(springForce.mul(factor));
    });

    force.y.subAssign(0.00005);

    const noise     = triNoise3D(position, 1, time).sub(0.2).mul(0.0001);
    const windForce = noise.mul(windUniform);
    force.z.subAssign(windForce);

    const deltaSphere = position.add(force).sub(spherePositionUniform);
    const dist        = deltaSphere.length();
    const sphereForce = float(sphereRadius).sub(dist).max(0).mul(deltaSphere).div(dist).mul(sphereVisibleUniform);
    force.addAssign(sphereForce);

    vertexForceBuffer.element(instanceIndex).assign(force);
    vertexPositionBuffer.element(instanceIndex).addAssign(force);
  })().compute(vertexCount).setName('Vertex Forces');

  // ---- Wireframe ----
  const vertexWireMat = new THREE.SpriteNodeMaterial();
  vertexWireMat.positionNode = vertexPositionBuffer.element(instanceIndex);
  const vertexWireframeObject = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), vertexWireMat);
  vertexWireframeObject.frustumCulled = false;
  vertexWireframeObject.count = verletVertices.length;
  vertexWireframeObject.position.x = offsetX;
  scene.add(vertexWireframeObject);

  const springMat = new THREE.LineBasicNodeMaterial();
  springMat.positionNode = Fn(() => {
    const vertexIds = springVertexIdBuffer.element(instanceIndex);
    const vertexId  = select(attribute('vertexIndex').equal(0), vertexIds.x, vertexIds.y);
    return vertexPositionBuffer.element(vertexId);
  })();
  const springGeo = new THREE.InstancedBufferGeometry();
  springGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3, false));
  springGeo.setAttribute('vertexIndex', new THREE.BufferAttribute(new Uint32Array([0, 1]), 1, false));
  springGeo.instanceCount = verletSprings.length;
  const springWireframeObject = new THREE.Line(springGeo, springMat);
  springWireframeObject.frustumCulled = false;
  springWireframeObject.position.x = offsetX;
  scene.add(springWireframeObject);

  // ---- Cloth mesh ----
  let clothGeo, clothMat, clothMesh;
  if (direct) {
    // 直接メッシュ: 描画頂点→物理頂点をvertexIdで参照。法線は位置の導関数からフラット生成＝任意形状/スリット対応
    clothGeo = new THREE.BufferGeometry();
    clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(direct.map.length * 3), 3, false));
    clothGeo.setAttribute('vertexId', new THREE.BufferAttribute(direct.map, 1, false));
    if (direct.uv) clothGeo.setAttribute('uv', new THREE.BufferAttribute(direct.uv, 2, false));
    if (direct.nb) clothGeo.setAttribute('nbIds', new THREE.BufferAttribute(direct.nb, 4, false));
    clothGeo.setIndex(direct.idx);
    clothMat = new THREE.MeshPhysicalNodeMaterial({
      side:           THREE.DoubleSide,
      transparent:    matParams.opacity < 1.0,
      opacity:        matParams.opacity,
      roughness:      matParams.roughness,
      sheen:          matParams.sheen,
      sheenRoughness: matParams.sheenRoughness,
      sheenColor:     new THREE.Color(matParams.sheenColor),
    });
    clothMat.colorNode    = direct.tex ? texture(direct.tex, uv()) : select(frontFacing, frontColorUniform, backColorUniform);
    clothMat.positionNode = vertexPositionBuffer.element(attribute('vertexId'));
    if (direct.nb) {
      // 近傍頂点（L,R,U,D）の位置差から頂点法線→補間＝滑らかシェーディング（quadパスと同じ質感）
      const nb = attribute('nbIds');
      const pL = vertexPositionBuffer.element(nb.x);
      const pR = vertexPositionBuffer.element(nb.y);
      const pU = vertexPositionBuffer.element(nb.z);
      const pD = vertexPositionBuffer.element(nb.w);
      clothMat.normalNode = transformNormalToView(cross(pR.sub(pL), pD.sub(pU)).normalize()).toVarying();
    } else {
      clothMat.normalNode = cross(dFdx(positionView), dFdy(positionView)).normalize();   // FBX等の任意メッシュ＝フラット
    }
  } else {
  const mantleCells     = segs * segs;
  const collarCells     = collarSegs > 0 ? segs * collarSegs : 0;
  const meshVertexCount = mantleCells + collarCells;
  clothGeo = new THREE.BufferGeometry();
  const verletVertIdArr = new Uint32Array(meshVertexCount * 4);
  const indices         = [];
  const getMantleIndex  = (x, y)  => y * segs + x;
  const getCollarIndex  = (x, cy) => mantleCells + cy * segs + x;

  // マント本体セル
  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const idx = getMantleIndex(x, y);
      verletVertIdArr[idx*4]   = verletVertexColumns[x][y].id;
      verletVertIdArr[idx*4+1] = verletVertexColumns[x+1][y].id;
      verletVertIdArr[idx*4+2] = verletVertexColumns[x][y+1].id;
      verletVertIdArr[idx*4+3] = verletVertexColumns[x+1][y+1].id;
      if (x > 0 && y > 0) {
        indices.push(getMantleIndex(x,y), getMantleIndex(x-1,y), getMantleIndex(x-1,y-1));
        indices.push(getMantleIndex(x,y), getMantleIndex(x-1,y-1), getMantleIndex(x,y-1));
      }
    }
  }

  // 衿セル
  for (let x = 0; x < segs; x++) {
    for (let cy = 0; cy < collarSegs; cy++) {
      const idx = getCollarIndex(x, cy);
      verletVertIdArr[idx*4]   = collarColumns[x][cy].id;
      verletVertIdArr[idx*4+1] = collarColumns[x+1][cy].id;
      verletVertIdArr[idx*4+2] = collarColumns[x][cy+1].id;
      verletVertIdArr[idx*4+3] = collarColumns[x+1][cy+1].id;
      if (x > 0) {
        if (cy > 0) {
          // 衿内部の三角形（ワインディング逆）
          indices.push(getCollarIndex(x-1,cy-1), getCollarIndex(x-1,cy), getCollarIndex(x,cy));
          indices.push(getCollarIndex(x,cy-1), getCollarIndex(x-1,cy-1), getCollarIndex(x,cy));
        } else {
          // ピン行境界（ワインディング逆）
          indices.push(getMantleIndex(x-1,0), getCollarIndex(x-1,0), getCollarIndex(x,0));
          indices.push(getMantleIndex(x,0), getMantleIndex(x-1,0), getCollarIndex(x,0));
        }
      }
    }
  }

  clothGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(meshVertexCount * 3), 3, false));
  clothGeo.setAttribute('vertexIds', new THREE.BufferAttribute(verletVertIdArr, 4, false));
  clothGeo.setIndex(indices);

  clothMat = new THREE.MeshPhysicalNodeMaterial({
    side:           THREE.DoubleSide,
    transparent:    matParams.opacity < 1.0,
    opacity:        matParams.opacity,
    roughness:      matParams.roughness,
    sheen:          matParams.sheen,
    sheenRoughness: matParams.sheenRoughness,
    sheenColor:     new THREE.Color(matParams.sheenColor),
  });
  clothMat.colorNode = select(frontFacing, frontColorUniform, backColorUniform);
  clothMat.positionNode = Fn(({ material }) => {
    const vertexIds = attribute('vertexIds');
    const v0 = vertexPositionBuffer.element(vertexIds.x).toVar();
    const v1 = vertexPositionBuffer.element(vertexIds.y).toVar();
    const v2 = vertexPositionBuffer.element(vertexIds.z).toVar();
    const v3 = vertexPositionBuffer.element(vertexIds.w).toVar();
    const top     = v0.add(v1);
    const right   = v1.add(v3);
    const bottom  = v2.add(v3);
    const left    = v0.add(v2);
    const tangent   = right.sub(left).normalize();
    const bitangent = bottom.sub(top).normalize();
    const normal    = cross(tangent, bitangent);
    material.normalNode = transformNormalToView(normal).toVarying();
    return v0.add(v1).add(v2).add(v3).mul(0.25);
  })();

  }
  clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.frustumCulled = false;
  clothMesh.position.x = offsetX;
  scene.add(clothMesh);

  // ---- Sphere ----
  const sphereGeo  = new THREE.IcosahedronGeometry(sphereRadius * 0.95, 4);
  const sphereMat2 = new THREE.MeshStandardNodeMaterial();
  const sphereMesh  = new THREE.Mesh(sphereGeo, sphereMat2);
  sphereMesh.position.x = offsetX;
  scene.add(sphereMesh);

  return {
    offsetX,
    spherePositionUniform,
    grabbedIndexUniform,
    grabbedTargetUniform,
    vertexPositionBuffer,
    vertexParamsBuffer,
    vertexParamsCPU:     vertexParamsArr,   // 固定フラグ参照用
    vertexCount,
    cpuPositions:        vertexPosArr.slice(), // GPU→CPU スナップショット（初期値）
    computeSpringForces,
    computeVertexForces,
    clothMesh,
    clothMat,
    vertexWireframeObject,
    springWireframeObject,
    sphereMesh,
  };
}

function teardownInstance(inst) {
  scene.remove(inst.clothMesh);
  inst.clothMesh.geometry.dispose();
  scene.remove(inst.vertexWireframeObject);
  inst.vertexWireframeObject.geometry.dispose();
  scene.remove(inst.springWireframeObject);
  inst.springWireframeObject.geometry.dispose();
  scene.remove(inst.sphereMesh);
  inst.sphereMesh.geometry.dispose();
}

function clearGrabState() {
  if (grab.active && grab.instanceIdx >= 0 && instances[grab.instanceIdx]) {
    instances[grab.instanceIdx].grabbedIndexUniform.value = GRAB_NONE;
  }
  grab.active      = false;
  grab.pendingDown = false;
  grab.instanceIdx = -1;
  grab.vertexIdx   = -1;
  if (grab.highlightMesh) grab.highlightMesh.visible = false;
  if (controls) controls.enabled = true;
}

let lastCamCount = -1;   // 前回カメラを合わせたインスタンス数
function setInstanceCount(n, segs) {
  clearGrabState();
  grab.snapshots.length = 0;

  for (const inst of instances) teardownInstance(inst);
  instances.length = 0;
  timeSinceLastStep = 0;
  timestamp         = 0;

  for (let i = 0; i < n; i++) {
    const offsetX = (i - (n - 1) / 2) * CLOTH_SPACING;
    instances.push(createInstance(segs, offsetX));
    grab.snapshots.push(null);
  }

  applyVisibility();

  // カメラをインスタンス数に合わせてズームアウト（数が変わった時だけ＝形状/材質の調整で視点がリセットされない）
  if (n !== lastCamCount) {
    lastCamCount = n;
    const spread    = (n - 1) * CLOTH_SPACING;
    const idealDist = Math.max(2.5, 1.8 + spread * 0.65);
    camera.position.set(-idealDist * 0.9, -0.1, -idealDist * 0.9);
    controls.maxDistance = Math.max(4, idealDist * 2.5);
    controls.target.set(0, -0.1, 0);
    controls.update();
  }
  refreshPinMarkers();
}

function applyVisibility() {
  for (const inst of instances) {
    inst.clothMesh.visible             = !params.wireframe;
    inst.vertexWireframeObject.visible = params.wireframe;
    inst.springWireframeObject.visible = params.wireframe;
    inst.sphereMesh.visible            = params.sphere;
  }
}

// ============================================================
// FBX取込（外部マントモデル）
// ============================================================
/** customCloth → verlet 構造（createInstance が両対応で使う） */
function buildCustomVerlet(cc) {
  const n = cc.positions.length / 3;
  const verletVertices = [];
  for (let i = 0; i < n; i++) {
    verletVertices.push({
      id: i,
      position: new THREE.Vector3(cc.positions[i*3], cc.positions[i*3+1], cc.positions[i*3+2]),
      isFixed: cc.pins.has(i),
      springIds: [],
    });
  }
  const verletSprings = [];
  for (let i = 0; i < cc.springs.length; i += 2) {
    const v0 = verletVertices[cc.springs[i]], v1 = verletVertices[cc.springs[i+1]];
    const id = verletSprings.length;
    v0.springIds.push(id);
    v1.springIds.push(id);
    verletSprings.push({ id, vertex0: v0, vertex1: v1 });
  }
  return { verletVertices, verletSprings, verletVertexColumns: null, collarColumns: [], collarSegs: 0 };
}

/** FBXファイル → メッシュ収集・頂点溶接・スプリング生成（エッジ＋ベンド） */
async function importFbx(file, targetH) {
  const url = URL.createObjectURL(file);
  let obj;
  try { obj = await new FBXLoader().loadAsync(url); }
  finally { URL.revokeObjectURL(url); }
  obj.updateMatrixWorld(true);
  const rp = [], ruv = [], rindex = [];
  let base = 0, tex = null;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const pa = g.getAttribute('position'), ua = g.getAttribute('uv');
    for (let i = 0; i < pa.count; i++) {
      rp.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      ruv.push(ua ? ua.getX(i) : 0, ua ? ua.getY(i) : 0);
    }
    const idx = g.index ? Array.from(g.index.array) : [...Array(pa.count).keys()];
    for (const i of idx) rindex.push(base + i);
    base += pa.count;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!tex && m && m.map) tex = m.map;
  });
  if (!rindex.length) throw new Error('FBX内に三角形メッシュが見つかりません');
  if (tex) {   // 外部ファイル参照のテクスチャは単体取込では解決できず真っ黒になる→実際に画像が来た場合だけ使う
    await new Promise((r) => setTimeout(r, 800));
    if (!tex.image || !(tex.image.width > 0)) {
      console.warn('FBXのテクスチャが読み込めない（外部ファイル参照）→ 表裏カラーで表示します');
      tex = null;
    }
  }
  // 中心へ寄せて高さ正規化の基準を測る
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < rp.length; i += 3) {
    minX = Math.min(minX, rp[i]);   maxX = Math.max(maxX, rp[i]);
    minY = Math.min(minY, rp[i+1]); maxY = Math.max(maxY, rp[i+1]);
    minZ = Math.min(minZ, rp[i+2]); maxZ = Math.max(maxZ, rp[i+2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const rawH = Math.max(1e-6, maxY - minY);
  // 頂点溶接（座標量子化）: FBXはUV/法線分割で頂点が重複している＝物理頂点は一意化が必須
  const weldMap = new Map();
  const renderMap = new Uint32Array(rp.length / 3);
  const wpos = [];
  const q = 1e4;
  for (let i = 0; i < rp.length / 3; i++) {
    const x = rp[i*3] - cx, y = rp[i*3+1] - cy, z = rp[i*3+2] - cz;
    const key = Math.round(x*q) + '_' + Math.round(y*q) + '_' + Math.round(z*q);
    let id = weldMap.get(key);
    if (id == null) { id = wpos.length / 3; weldMap.set(key, id); wpos.push(x, y, z); }
    renderMap[i] = id;
  }
  // スプリング: 三角形エッジ（重複除去）＋ 隣接三角形の対頂点を結ぶベンドスプリング（曲げ抵抗）
  const edgeMap = new Map();
  for (let i = 0; i < rindex.length; i += 3) {
    const t0 = renderMap[rindex[i]], t1 = renderMap[rindex[i+1]], t2 = renderMap[rindex[i+2]];
    if (t0 === t1 || t1 === t2 || t0 === t2) continue;
    const tri = [t0, t1, t2];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e+1)%3], c = tri[(e+2)%3];
      const k = a < b ? a + '_' + b : b + '_' + a;
      let rec = edgeMap.get(k);
      if (!rec) edgeMap.set(k, rec = { a, b, opps: [] });
      rec.opps.push(c);
    }
  }
  const springs = [];
  for (const rec of edgeMap.values()) {
    springs.push(rec.a, rec.b);
    if (rec.opps.length >= 2 && rec.opps[0] !== rec.opps[1]) springs.push(rec.opps[0], rec.opps[1]);
  }
  customCloth = {
    name: file.name,
    baseHeight: rawH,
    basePositions: new Float32Array(wpos),
    positions: null,
    springs: new Uint32Array(springs),
    renderMap,
    renderIndex: rindex,
    renderUv: new Float32Array(ruv),
    tex,
    pins: new Set(),
  };
  applyFbxHeight(targetH);
  console.log('FBX取込:', file.name, '物理頂点', wpos.length / 3, '/ スプリング', springs.length / 2, '/ 描画頂点', renderMap.length, tex ? '/ テクスチャあり' : '');
}
function applyFbxHeight(targetH) {
  if (!customCloth) return;
  const sc = targetH / customCloth.baseHeight;
  const bp = customCloth.basePositions;
  const out = new Float32Array(bp.length);
  for (let i = 0; i < bp.length; i++) out[i] = bp[i] * sc;
  customCloth.positions = out;
}

/** GPU読み戻しの妥当性チェック（ポーズ直後などでゼロ埋めが返ることがある） */
function readbackValid(a) {
  if (!a || !a.length) return false;
  const n = Math.min(a.length, 600);
  for (let i = 0; i < n; i++) if (a[i] !== 0) return true;
  return false;
}

// ============================================================
// VRM試着（サイズ合わせ用の表示。衝突はしない）
// ============================================================
let refVrm = null;      // { vrm, baseOffsetY }
let refVrmYOff = 0;     // スライダによる上下微調整
let refVrmXOff = 0;     // 左右
let refVrmZOff = 0;     // 前後
function applyRefVrmPos() {
  if (refVrm) refVrm.vrm.scene.position.set(refVrmXOff, refVrm.baseOffsetY + refVrmYOff, refVrmZOff);
}
async function loadRefVrm(file) {
  const loader = new GLTFLoader();
  loader.register((pl) => new VRMLoaderPlugin(pl, { mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(pl, { materialType: MToonNodeMaterial }) }));
  const url = URL.createObjectURL(file);
  let gltf;
  try { gltf = await loader.loadAsync(url); }
  finally { URL.revokeObjectURL(url); }
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('VRMではありません');
  if (refVrm) scene.remove(refVrm.vrm.scene);
  try { VRMUtils.rotateVRM0(vrm); } catch { /* VRM1 */ }
  vrm.scene.updateMatrixWorld(true);
  // 腰(hips)を布の固定リング高さ（上端）へ自動整列
  let hipsY = 0.8;
  const hips = vrm.humanoid?.getNormalizedBoneNode('hips');
  if (hips) {
    const pw = new THREE.Vector3();
    hips.getWorldPosition(pw);
    hipsY = pw.y;
  }
  const baseOffsetY = shapeParams.height * 0.5 - hipsY;
  scene.add(vrm.scene);
  refVrm = { vrm, baseOffsetY };
  applyRefVrmPos();
}

// ============================================================
// ピン編集（任意頂点の固定/解除。FBX・手続き形状の両方で使用可）
// ============================================================
const _pinGeo = new THREE.OctahedronGeometry(0.02);
const _pinMat = new THREE.MeshBasicMaterial({ color: 0xff5060, depthTest: false, transparent: true, opacity: 0.95 });
function refreshPinMarkers() {
  if (!pinGroup) { pinGroup = new THREE.Group(); scene.add(pinGroup); }
  pinGroup.clear();
  for (let ii = 0; ii < instances.length; ii++) {
    const inst = instances[ii];
    const snap = grab.snapshots[ii] ?? inst.cpuPositions;
    for (let vi = 0; vi < inst.vertexCount; vi++) {
      if (inst.vertexParamsCPU[vi * 3] !== 1) continue;
      const m = new THREE.Mesh(_pinGeo, _pinMat);
      m.position.set(snap[vi*3] + inst.offsetX, snap[vi*3+1], snap[vi*3+2]);
      m.renderOrder = 998;
      pinGroup.add(m);
    }
  }
  pinGroup.visible = pinEditMode;
}
function togglePin(instIdx, vertIdx) {
  const was = instances[instIdx].vertexParamsCPU[vertIdx * 3] === 1;
  const now = was ? 0 : 1;
  for (const inst of instances) {   // 全インスタンス同一トポロジ＝同じ頂点をピン
    inst.vertexParamsCPU[vertIdx * 3] = now;
    inst.vertexParamsBuffer.value.needsUpdate = true;
  }
  if (customCloth) { if (now) customCloth.pins.add(vertIdx); else customCloth.pins.delete(vertIdx); }
  refreshPinMarkers();
}
function setPinEdit(on) {
  pinEditMode = on;
  const b = document.getElementById('btn-pin-edit');
  if (b) {
    b.style.background = on ? 'rgba(255,180,60,0.35)' : 'rgba(255,255,255,0.07)';
    b.style.color      = on ? '#fda' : '#ccc';
  }
  refreshPinMarkers();
  const info = document.getElementById('info');
  if (info) info.textContent = on
    ? '📌 ピン編集: 頂点クリックで固定/解除（もう一度📌で終了）'
    : '左クリックで布を掴む | ドラッグで視点回転 | スクロールでズーム';
}
function pinPointerDown(clientX, clientY) {
  if (instances.length === 0) return;
  Promise.all(instances.map(inst =>
    renderer.getArrayBufferAsync(inst.vertexPositionBuffer.value)
      .then(ab => new Float32Array(ab))
      .catch(() => null)
  )).then((bufs) => {
    for (let i = 0; i < instances.length; i++) {
      if (readbackValid(bufs[i])) { grab.snapshots[i] = bufs[i]; instances[i].cpuPositions = bufs[i]; }
    }
    const hit = pickNearestVertex(clientX, clientY, true, 48);
    if (hit) togglePin(hit.instIdx, hit.vertIdx);
  });
}

// ============================================================
// Grab / Picking
// ============================================================

/**
 * スクリーン座標 (clientX, clientY) に最も近い非固定頂点を探す。
 * @returns {{ instIdx, vertIdx, screenDist }} or null
 */
function pickNearestVertex(clientX, clientY, includeFixed = false, thresholdPx = GRAB_THRESHOLD_PX) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  let bestInstIdx  = -1;
  let bestVertIdx  = -1;
  let bestDist     = thresholdPx;

  const projected = new THREE.Vector3();

  for (let ii = 0; ii < instances.length; ii++) {
    const inst     = instances[ii];
    const snapshot = grab.snapshots[ii] ?? inst.cpuPositions;
    const vcnt     = inst.vertexCount;

    for (let vi = 0; vi < vcnt; vi++) {
      // 固定頂点はグラブ対象外（ピン編集時は対象）
      if (!includeFixed && inst.vertexParamsCPU[vi * 3] === 1) continue;

      // ローカル座標 → ワールド座標
      projected.set(
        snapshot[vi * 3    ] + inst.offsetX,
        snapshot[vi * 3 + 1],
        snapshot[vi * 3 + 2],
      );

      // ワールド座標 → NDC → スクリーン座標
      projected.project(camera);
      if (projected.z > 1) continue; // カメラ背後

      const sx = (projected.x *  0.5 + 0.5) * w;
      const sy = (projected.y * -0.5 + 0.5) * h;
      const d  = Math.hypot(sx - clientX, sy - clientY);

      if (d < bestDist) {
        bestDist     = d;
        bestInstIdx  = ii;
        bestVertIdx  = vi;
      }
    }
  }

  if (bestInstIdx === -1) return null;
  return { instIdx: bestInstIdx, vertIdx: bestVertIdx };
}

function buildDragPlane(worldPos) {
  // ドラッグ平面：カメラ→頂点方向を法線とし、頂点を通る平面
  const normal = worldPos.clone().sub(camera.position).normalize();
  grab.dragPlane.setFromNormalAndCoplanarPoint(normal, worldPos);
}

function applyGrabTarget(clientX, clientY) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  grab.raycaster.setFromCamera(
    { x: (clientX / w) * 2 - 1, y: -(clientY / h) * 2 + 1 },
    camera,
  );

  const hitPoint = new THREE.Vector3();
  if (!grab.raycaster.ray.intersectPlane(grab.dragPlane, hitPoint)) return;

  const inst = instances[grab.instanceIdx];
  // ワールド座標 → クロスのローカル座標（offsetX を引く）
  inst.grabbedTargetUniform.value.set(
    hitPoint.x - inst.offsetX,
    hitPoint.y,
    hitPoint.z,
  );

  // ハイライトをワールド座標で追従
  grab.highlightMesh.position.copy(hitPoint);
}

function setupGrabEvents(canvas) {
  // キャプチャフェーズで受け取ることで OrbitControls より先に実行
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (pinEditMode) { pinPointerDown(e.clientX, e.clientY); return; }
    if (!simRunning || grab.active || grab.pendingDown) return;
    if (instances.length === 0) return;

    // クリック時に全インスタンスの最新頂点座標を1回だけ readback
    // → 揺れている布でも見た目どおりに掴める（OrbitControls 判定はその後に確定）
    const { clientX, clientY, pointerId } = e;
    grab.pendingDown = true;

    Promise.all(instances.map(inst =>
      renderer.getArrayBufferAsync(inst.vertexPositionBuffer.value)
        .then(ab => new Float32Array(ab))
        .catch(() => null)
    )).then((bufs) => {
      // readback待ちの間に pointerup された場合は中止
      if (!grab.pendingDown || !simRunning) { grab.pendingDown = false; return; }
      grab.pendingDown = false;

      for (let i = 0; i < instances.length; i++) {
        if (readbackValid(bufs[i])) { grab.snapshots[i] = bufs[i]; instances[i].cpuPositions = bufs[i]; }
      }

      const hit = pickNearestVertex(clientX, clientY);
      if (!hit) return; // 布の近くでないクリックは何もしない（OrbitControls は既にこのpointerを開始済み）

      controls.enabled = false;
      grab.active      = true;
      grab.instanceIdx = hit.instIdx;
      grab.vertexIdx   = hit.vertIdx;

      const inst     = instances[hit.instIdx];
      const snapshot = grab.snapshots[hit.instIdx] ?? inst.cpuPositions;
      const wx = snapshot[hit.vertIdx * 3    ] + inst.offsetX;
      const wy = snapshot[hit.vertIdx * 3 + 1];
      const wz = snapshot[hit.vertIdx * 3 + 2];

      buildDragPlane(new THREE.Vector3(wx, wy, wz));
      inst.grabbedIndexUniform.value = hit.vertIdx;

      // ハイライト表示
      grab.highlightMesh.position.set(wx, wy, wz);
      grab.highlightMesh.visible = true;

      applyGrabTarget(clientX, clientY);

      // キャンバス外でも pointermove/pointerup を受け取る
      canvas.setPointerCapture(pointerId);
      canvas.style.cursor = 'grabbing';
    });
  }, { capture: true });

  canvas.addEventListener('pointermove', (e) => {
    if (!grab.active) return;
    applyGrabTarget(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerup', (e) => {
    grab.pendingDown = false;
    if (!grab.active) return;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    clearGrabState();
    canvas.style.cursor = '';
  });

  canvas.addEventListener('pointercancel', () => {
    grab.pendingDown = false;
    if (!grab.active) return;
    clearGrabState();
    canvas.style.cursor = '';
  });
}

// ============================================================
// UI
// ============================================================
function setupUI() {
  // ---- FBX取込 / ピン編集 ----
  const fbxFile = document.getElementById('fbx-file');
  document.getElementById('btn-fbx').addEventListener('click', () => fbxFile.click());
  fbxFile.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await importFbx(f, parseFloat(document.getElementById('fbx-height').value));
      instanceCount = 1;
      document.getElementById('count').value = '1';
      document.getElementById('count-val').textContent = '1';
      simRunning = false;   // 落下しないよう停止→ピンを打ってから▶再開
      const bs = document.getElementById('btn-sim-stop');
      bs.textContent = '▶ 再開';
      bs.style.color = '#9eb';
      setInstanceCount(1, clothNumSegments);
      setPinEdit(true);
      const info = document.getElementById('info');
      if (info) info.textContent = `FBX取込: ${f.name} — 📌で固定点を打ってから ▶再開`;
    } catch (err) { alert('FBX取込失敗: ' + err.message); console.error(err); }
    fbxFile.value = '';
  });
  const fbxH = document.getElementById('fbx-height');
  fbxH.addEventListener('input', () => {
    document.getElementById('fbx-height-val').textContent = parseFloat(fbxH.value).toFixed(2);
    if (!customCloth) return;
    clearTimeout(fbxH._t);
    fbxH._t = setTimeout(() => {
      applyFbxHeight(parseFloat(fbxH.value));
      setInstanceCount(instanceCount, clothNumSegments);
    }, 300);
  });
  document.getElementById('btn-fbx-clear').addEventListener('click', () => {
    if (!customCloth) return;
    customCloth = null;
    setPinEdit(false);
    setInstanceCount(instanceCount, clothNumSegments);
  });
  // ---- VRM試着 ----
  const vrmFile = document.getElementById('vrm-file');
  document.getElementById('btn-vrm').addEventListener('click', () => vrmFile.click());
  vrmFile.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { await loadRefVrm(f); } catch (err) { alert('VRM読込失敗: ' + err.message); console.error(err); }
    vrmFile.value = '';
  });
  document.getElementById('vrm-visible').addEventListener('change', (e) => {
    if (refVrm) refVrm.vrm.scene.visible = e.target.checked;
  });
  const bindVrmAxis = (id, setV) => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      setV(v);
      document.getElementById(id + '-val').textContent = v.toFixed(2);
      applyRefVrmPos();
    });
  };
  bindVrmAxis('vrm-y', (v) => { refVrmYOff = v; });
  bindVrmAxis('vrm-x', (v) => { refVrmXOff = v; });
  bindVrmAxis('vrm-z', (v) => { refVrmZOff = v; });

  document.getElementById('btn-pin-edit').addEventListener('click', () => setPinEdit(!pinEditMode));
  document.getElementById('btn-pin-clear').addEventListener('click', () => {
    for (const inst of instances) {
      for (let vi = 0; vi < inst.vertexCount; vi++) inst.vertexParamsCPU[vi * 3] = 0;
      inst.vertexParamsBuffer.value.needsUpdate = true;
    }
    if (customCloth) customCloth.pins.clear();
    refreshPinMarkers();
  });

  // Count
  const countSlider = document.getElementById('count');
  const countVal    = document.getElementById('count-val');
  let   countTimer  = null;
  countSlider.addEventListener('input', () => {
    const n = parseInt(countSlider.value, 10);
    countVal.textContent = String(n);
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      instanceCount = n;
      setInstanceCount(n, clothNumSegments);
    }, 400);
  });

  // Stiffness
  const stiffnessSlider = document.getElementById('stiffness');
  const stiffnessVal    = document.getElementById('stiffness-val');
  stiffnessSlider.addEventListener('input', () => {
    const v = parseFloat(stiffnessSlider.value);
    stiffnessVal.textContent = v.toFixed(2);
    stiffnessUniform.value   = v;
  });

  // Wind
  const windSlider = document.getElementById('wind');
  const windVal    = document.getElementById('wind-val');
  windSlider.addEventListener('input', () => {
    params.wind       = parseFloat(windSlider.value);
    windVal.textContent = params.wind.toFixed(1);
  });

  // Wireframe / Sphere
  document.getElementById('wireframe').addEventListener('change', (e) => {
    params.wireframe = e.target.checked;
    applyVisibility();
  });
  document.getElementById('sphere').addEventListener('change', (e) => {
    params.sphere = e.target.checked;
    applyVisibility();
  });

  // Segments
  const segsSlider = document.getElementById('segments');
  const segsVal    = document.getElementById('segments-val');
  let   segsTimer  = null;
  segsSlider.addEventListener('input', () => {
    const v = parseInt(segsSlider.value, 10);
    segsVal.textContent = `${v}×${v}`;
    clearTimeout(segsTimer);
    segsTimer = setTimeout(() => {
      clothNumSegments = v;
      setInstanceCount(instanceCount, v);
    }, 300);
  });

  // Material
  document.getElementById('mat-color-front').addEventListener('input', (e) => {
    matParams.colorFront = e.target.value;
    frontColorUniform.value.set(e.target.value);
  });
  document.getElementById('mat-color-back').addEventListener('input', (e) => {
    matParams.colorBack = e.target.value;
    backColorUniform.value.set(e.target.value);
  });

  const matRoughness     = document.getElementById('mat-roughness');
  const matRoughnessVal  = document.getElementById('mat-roughness-val');
  matRoughness.addEventListener('input', () => {
    const v = parseFloat(matRoughness.value);
    matParams.roughness = v;
    matRoughnessVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.roughness = v;
  });

  const matSheen    = document.getElementById('mat-sheen');
  const matSheenVal = document.getElementById('mat-sheen-val');
  matSheen.addEventListener('input', () => {
    const v = parseFloat(matSheen.value);
    matParams.sheen = v;
    matSheenVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheen = v;
  });

  const matSheenRough    = document.getElementById('mat-sheen-roughness');
  const matSheenRoughVal = document.getElementById('mat-sheen-roughness-val');
  matSheenRough.addEventListener('input', () => {
    const v = parseFloat(matSheenRough.value);
    matParams.sheenRoughness = v;
    matSheenRoughVal.textContent = v.toFixed(2);
    for (const inst of instances) inst.clothMat.sheenRoughness = v;
  });

  const matSheenColor = document.getElementById('mat-sheen-color');
  matSheenColor.addEventListener('input', () => {
    matParams.sheenColor = matSheenColor.value;
    for (const inst of instances) inst.clothMat.sheenColor.set(matSheenColor.value);
  });

  const matOpacity    = document.getElementById('mat-opacity');
  const matOpacityVal = document.getElementById('mat-opacity-val');
  matOpacity.addEventListener('input', () => {
    const v = parseFloat(matOpacity.value);
    matParams.opacity = v;
    matOpacityVal.textContent = v.toFixed(2);
    for (const inst of instances) {
      inst.clothMat.opacity      = v;
      inst.clothMat.transparent  = v < 1.0;
      inst.clothMat.needsUpdate  = true;
    }
  });

  // Shape
  const shapeSelect = document.getElementById('shape-type');
  shapeSelect.addEventListener('change', () => {
    shapeParams.type = shapeSelect.value;
    _updateShapeVisibility();
    setInstanceCount(instanceCount, clothNumSegments);
  });

  const bindShape = (id, valId, key, parse, fmt, isRange = true) => {
    const el = document.getElementById(id);
    const vl = document.getElementById(valId);
    el.addEventListener('input', () => {
      const v = parse(el.value);
      if (vl) vl.textContent = fmt(v);
      shapeParams[key] = v;
      clearTimeout(el._t);
      el._t = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 300);
    });
  };
  bindShape('shape-top-width',    'shape-top-width-val',    'topWidth',    parseFloat, v => v.toFixed(2));
  bindShape('shape-hole',         'shape-hole-val',         'holeD',       parseFloat, v => v.toFixed(2));
  bindShape('shape-hole-ratio',   'shape-hole-ratio-val',   'holeRatio',   parseFloat, v => v.toFixed(2));
  bindShape('shape-slit-n',       'shape-slit-n-val',       'slitN',       parseInt,   v => String(v));
  bindShape('shape-slit-depth',   'shape-slit-depth-val',   'slitDepth',   parseFloat, v => v.toFixed(2));
  bindShape('shape-slit-rot',     'shape-slit-rot-val',     'slitRot',     parseInt,   v => `${v}°`);
  bindShape('shape-bottom-width', 'shape-bottom-width-val', 'bottomWidth', parseFloat, v => v.toFixed(2));
  bindShape('shape-height',       'shape-height-val',       'height',      parseFloat, v => v.toFixed(2));
  bindShape('shape-pin-count',    'shape-pin-count-val',    'pinCount',    parseInt,   v => String(v));
  // 上端曲率/縦横比: 選択中の段に効く（段1=グローバル値、段2/3=topRowsに保存・未設定は継承）
  const rowCurveSliders = [['shape-top-curve', 4, 'topCurve'], ['shape-top-ratio', 5, 'topRatio']];
  for (const [id, k, legacyKey] of rowCurveSliders) {
    const el = document.getElementById(id);
    const vl = document.getElementById(id + '-val');
    el.addEventListener('input', () => {
      ensureTopRows();
      const i = parseInt(document.getElementById('top-row-sel').value, 10);
      const v = parseFloat(el.value);
      if (vl) vl.textContent = v.toFixed(2);
      if (i === 0) shapeParams[legacyKey] = v;
      else shapeParams.topRows[i][k] = v;
      clearTimeout(el._t);
      el._t = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 300);
    });
  }
  // ---- 上端3段（上端/第2/第3）のトランスフォーム編集 ----
  const rowSel = document.getElementById('top-row-sel');
  const rowSliders = [['shape-rot-x', 0, '°'], ['shape-rot-y', 1, '°'], ['shape-rot-z', 2, '°'], ['shape-row-dy', 3, 'm'], ['shape-row-dz', 6, 'm']];
  function ensureTopRows() {
    if (!Array.isArray(shapeParams.topRows)) {
      shapeParams.topRows = [
        [shapeParams.topRotX || 0, shapeParams.topRotY || 0, shapeParams.topRotZ || 0, 0, null, null, 0],
        [0, 0, 0, 0, null, null, 0],
        [0, 0, 0, 0, null, null, 0],
      ];
    }
    for (const tr of shapeParams.topRows) {   // 旧形式の保存データを7要素へ（4-5=null継承, 6=前後0）
      while (tr.length < 4) tr.push(0);
      while (tr.length < 6) tr.push(null);
      while (tr.length < 7) tr.push(0);
    }
    if (!Array.isArray(shapeParams.topRowPin)) shapeParams.topRowPin = [false, false];
  }
  function syncTopRowUI() {
    ensureTopRows();
    const i = parseInt(rowSel.value, 10);
    const tr = shapeParams.topRows[i];
    for (const [id, k, unit] of rowSliders) {
      const el = document.getElementById(id);
      el.value = String(tr[k]);
      document.getElementById(id + '-val').textContent = unit === 'm' ? (+tr[k]).toFixed(2) : `${tr[k]}°`;
    }
    const pinCb = document.getElementById('top-row-pin');
    pinCb.disabled = i === 0;
    pinCb.checked = i === 0 ? true : !!shapeParams.topRowPin[i - 1];
    // 曲率/縦横比スライダを選択段の実効値へ（継承解決込み）
    let ec = shapeParams.topCurve ?? 0, er = shapeParams.topRatio ?? 1;
    for (let k = 1; k <= i && k < 3; k++) {
      const t2 = shapeParams.topRows[k];
      if (t2 && t2[4] != null) ec = t2[4];
      if (t2 && t2[5] != null) er = t2[5];
    }
    document.getElementById('shape-top-curve').value = String(ec);
    document.getElementById('shape-top-curve-val').textContent = (+ec).toFixed(2);
    document.getElementById('shape-top-ratio').value = String(er);
    document.getElementById('shape-top-ratio-val').textContent = (+er).toFixed(2);
  }
  rowSel.addEventListener('change', syncTopRowUI);
  for (const [id, k, unit] of rowSliders) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      ensureTopRows();
      const i = parseInt(rowSel.value, 10);
      const v = parseFloat(el.value);
      shapeParams.topRows[i][k] = v;
      document.getElementById(id + '-val').textContent = unit === 'm' ? v.toFixed(2) : `${v}°`;
      clearTimeout(el._t);
      el._t = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 300);
    });
  }
  document.getElementById('top-row-pin').addEventListener('change', (e) => {
    ensureTopRows();
    const i = parseInt(rowSel.value, 10);
    if (i > 0) {
      shapeParams.topRowPin[i - 1] = e.target.checked;
      setInstanceCount(instanceCount, clothNumSegments);
    }
  });

  // ---- 上面（襟ぐり）形状のスプライン編集（左右対称） ----
  const TS_DEFAULT = [[0, -0.36], [0.15, -0.31], [0.20, -0.18], [0.15, -0.05], [0, 0.0]];
  const tsCv = document.getElementById('top-shape-cv');
  const tsBox = document.getElementById('top-shape-box');
  const tsRange = { x0: -0.32, x1: 0.32, z0: -0.48, z1: 0.14 };   // 表示範囲(m)。上=+z(背中側)
  const tsToPx = (pt) => [
    (pt[0] - tsRange.x0) / (tsRange.x1 - tsRange.x0) * tsCv.width,
    tsCv.height - (pt[1] - tsRange.z0) / (tsRange.z1 - tsRange.z0) * tsCv.height,
  ];
  const tsFromPx = (x, y) => [
    Math.min(tsRange.x1, Math.max(tsRange.x0, tsRange.x0 + x / tsCv.width * (tsRange.x1 - tsRange.x0))),
    Math.min(tsRange.z1, Math.max(tsRange.z0, tsRange.z0 + (tsCv.height - y) / tsCv.height * (tsRange.z1 - tsRange.z0))),
  ];
  function drawTopShape() {
    if (!tsCv) return;
    const ctx = tsCv.getContext('2d');
    ctx.fillStyle = '#12142a';
    ctx.fillRect(0, 0, tsCv.width, tsCv.height);
    const z = tsToPx([0, 0]);
    ctx.strokeStyle = '#2a2a44';
    ctx.beginPath(); ctx.moveTo(z[0], 0); ctx.lineTo(z[0], tsCv.height); ctx.stroke();   // 中心線（対称軸）
    ctx.fillStyle = '#667';
    ctx.font = '10px system-ui';
    ctx.fillText('後', z[0] + 4, 12);
    ctx.fillText('前(合わせ目)', z[0] + 4, tsCv.height - 5);
    const prof = shapeParams.topShape;
    if (!prof) return;
    // 閉曲線（LUT経由＝実際の生成と同一）
    const lut = getTopLUT(shapeParams);
    ctx.strokeStyle = '#7fd0a0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const q = tsToPx(lutPoint(lut, i / 96));
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.lineWidth = 1;
    prof.forEach((pt, i) => {
      const q = tsToPx(pt);
      ctx.fillStyle = (i === 0 || i === prof.length - 1) ? '#a0c0ff' : '#7fe0a8';   // 前後中心=青（x固定）
      ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.fill();
      const m = tsToPx([-pt[0], pt[1]]);   // ミラー側（薄く）
      ctx.fillStyle = 'rgba(127,224,168,0.25)';
      ctx.beginPath(); ctx.arc(m[0], m[1], 4, 0, Math.PI * 2); ctx.fill();
    });
  }
  let tsDrag = -1, tsTimer = null;
  const tsRebuild = () => {
    clearTimeout(tsTimer);
    tsTimer = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 250);
  };
  if (tsCv) {
    tsCv.addEventListener('pointerdown', (e) => {
      if (!shapeParams.topShape) return;
      const r = tsCv.getBoundingClientRect();
      const x = (e.clientX - r.left) * (tsCv.width / r.width), y = (e.clientY - r.top) * (tsCv.height / r.height);
      tsDrag = shapeParams.topShape.findIndex((pt) => {
        const q = tsToPx(pt);
        return Math.hypot(q[0] - x, q[1] - y) < 12;
      });
      if (tsDrag >= 0) tsCv.setPointerCapture(e.pointerId);
    });
    tsCv.addEventListener('pointermove', (e) => {
      if (tsDrag < 0) return;
      const r = tsCv.getBoundingClientRect();
      const pt = tsFromPx((e.clientX - r.left) * (tsCv.width / r.width), (e.clientY - r.top) * (tsCv.height / r.height));
      const prof = shapeParams.topShape;
      const isEnd = tsDrag === 0 || tsDrag === prof.length - 1;
      prof[tsDrag] = isEnd ? [0, pt[1]] : [Math.max(0.01, pt[0]), pt[1]];   // 前後中心はx=0固定
      drawTopShape();
      tsRebuild();
    });
    const tsEnd = () => { tsDrag = -1; };
    tsCv.addEventListener('pointerup', tsEnd);
    tsCv.addEventListener('pointercancel', tsEnd);
    document.getElementById('top-shape-on').addEventListener('change', (e) => {
      shapeParams.topShapeOn = e.target.checked;
      if (shapeParams.topShapeOn && !shapeParams.topShape) shapeParams.topShape = TS_DEFAULT.map((pt) => pt.slice());
      tsBox.style.display = shapeParams.topShapeOn ? 'flex' : 'none';
      drawTopShape();
      setInstanceCount(instanceCount, clothNumSegments);
    });
    document.getElementById('top-shape-reset').addEventListener('click', () => {
      shapeParams.topShape = TS_DEFAULT.map((pt) => pt.slice());
      drawTopShape();
      setInstanceCount(instanceCount, clothNumSegments);
    });
  }
  bindShape('shape-arc-angle',    'shape-arc-angle-val',    'arcAngle',    parseInt,   v => `${v}°`);
  bindShape('shape-hem-jag',      'shape-hem-jag-val',      'hemJag',      parseFloat, v => v.toFixed(2));
  bindShape('shape-hem-teeth',    'shape-hem-teeth-val',    'hemTeeth',    parseInt,   v => String(v));

  // 衿パラメータ
  const collarCheckbox = document.getElementById('collar-enable');
  collarCheckbox.addEventListener('change', () => {
    shapeParams.collar = collarCheckbox.checked;
    _updateCollarVisibility();
    setInstanceCount(instanceCount, clothNumSegments);
  });
  bindShape('collar-height', 'collar-height-val', 'collarHeight', parseFloat, v => v.toFixed(2));
  bindShape('collar-flare',  'collar-flare-val',  'collarFlare',  parseFloat, v => v.toFixed(2));
  bindShape('collar-curve',  'collar-curve-val',  'collarCurve',  parseFloat, v => v.toFixed(2));
  bindShape('collar-fold',   'collar-fold-val',   'collarFold',   parseFloat, v => v.toFixed(2));
  bindShape('collar-angle',  'collar-angle-val',  'collarAngle',  parseInt,   v => `${v}°`);
  bindShape('collar-taper',  'collar-taper-val',  'collarTaper',  parseFloat, v => v.toFixed(2));

  // ---- 衿プロファイルのスプライン編集 ----
  const CP_DEFAULT = [[0.02, 0.12], [0.07, 0.22], [0.16, 0.26], [0.27, 0.2]];
  const cpCv = document.getElementById('collar-spline-cv');
  const cpBox = document.getElementById('collar-spline-box');
  const cpRange = { r0: -0.12, r1: 0.48, y0: -0.18, y1: 0.42 };   // 表示範囲(m)
  const cpToPx = (pt) => [
    (pt[0] - cpRange.r0) / (cpRange.r1 - cpRange.r0) * cpCv.width,
    cpCv.height - (pt[1] - cpRange.y0) / (cpRange.y1 - cpRange.y0) * cpCv.height,
  ];
  const pxToCp = (x, y) => [
    Math.min(cpRange.r1, Math.max(cpRange.r0, cpRange.r0 + x / cpCv.width * (cpRange.r1 - cpRange.r0))),
    Math.min(cpRange.y1, Math.max(cpRange.y0, cpRange.y0 + (cpCv.height - y) / cpCv.height * (cpRange.y1 - cpRange.y0))),
  ];
  function drawCollarSpline() {
    if (!cpCv) return;
    const ctx = cpCv.getContext('2d');
    ctx.fillStyle = '#12142a';
    ctx.fillRect(0, 0, cpCv.width, cpCv.height);
    // 軸（0線）
    ctx.strokeStyle = '#2a2a44';
    const z = cpToPx([0, 0]);
    ctx.beginPath(); ctx.moveTo(0, z[1]); ctx.lineTo(cpCv.width, z[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(z[0], 0); ctx.lineTo(z[0], cpCv.height); ctx.stroke();
    const prof = shapeParams.collarProfile;
    if (!prof) return;
    // カーブ
    const chain = [[0, 0], ...prof];
    ctx.strokeStyle = '#ffb060';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const q = cpToPx(catmullChain(chain, i / 40));
      if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
    // 基点＋制御点
    ctx.fillStyle = '#667';
    ctx.beginPath(); ctx.arc(z[0], z[1], 4, 0, Math.PI * 2); ctx.fill();
    prof.forEach((pt) => {
      const q = cpToPx(pt);
      ctx.fillStyle = '#ffd060';
      ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, Math.PI * 2); ctx.fill();
    });
  }
  let cpDrag = -1, cpTimer = null;
  const cpRebuild = () => {
    clearTimeout(cpTimer);
    cpTimer = setTimeout(() => setInstanceCount(instanceCount, clothNumSegments), 250);
  };
  if (cpCv) {
    cpCv.addEventListener('pointerdown', (e) => {
      if (!shapeParams.collarProfile) return;
      const r = cpCv.getBoundingClientRect();
      const x = (e.clientX - r.left) * (cpCv.width / r.width), y = (e.clientY - r.top) * (cpCv.height / r.height);
      cpDrag = shapeParams.collarProfile.findIndex((pt) => {
        const q = cpToPx(pt);
        return Math.hypot(q[0] - x, q[1] - y) < 12;
      });
      if (cpDrag >= 0) cpCv.setPointerCapture(e.pointerId);
    });
    cpCv.addEventListener('pointermove', (e) => {
      if (cpDrag < 0) return;
      const r = cpCv.getBoundingClientRect();
      shapeParams.collarProfile[cpDrag] = pxToCp((e.clientX - r.left) * (cpCv.width / r.width), (e.clientY - r.top) * (cpCv.height / r.height));
      drawCollarSpline();
      cpRebuild();
    });
    const cpEnd = () => { cpDrag = -1; };
    cpCv.addEventListener('pointerup', cpEnd);
    cpCv.addEventListener('pointercancel', cpEnd);
    document.getElementById('collar-spline').addEventListener('change', (e) => {
      shapeParams.collarSpline = e.target.checked;
      if (shapeParams.collarSpline && !shapeParams.collarProfile) shapeParams.collarProfile = CP_DEFAULT.map((pt) => pt.slice());
      cpBox.style.display = shapeParams.collarSpline ? 'flex' : 'none';
      drawCollarSpline();
      setInstanceCount(instanceCount, clothNumSegments);
    });
    document.getElementById('collar-spline-reset').addEventListener('click', () => {
      shapeParams.collarProfile = CP_DEFAULT.map((pt) => pt.slice());
      drawCollarSpline();
      setInstanceCount(instanceCount, clothNumSegments);
    });
  }

  function _updateCollarVisibility() {
    const show = shapeParams.collar;
    document.getElementById('collar-sliders').style.display = show ? 'flex' : 'none';
  }
  _updateCollarVisibility();

  function _updateShapeVisibility() {
    const isTrap   = shapeParams.type === 'trapezoid';
    const isSemi   = shapeParams.type === 'semicircle';
    const isCircle = shapeParams.type === 'circle';
    document.getElementById('row-bottom-width').style.display =
      (isTrap || isSemi) ? '' : 'none';
    document.getElementById('row-arc-angle').style.display =
      isSemi ? '' : 'none';
    document.getElementById('row-top-ratio').style.display = isSemi ? '' : 'none';
    document.getElementById('row-top-shape').style.display = isSemi ? '' : 'none';
    document.getElementById('row-top-row-sel').style.display = isSemi ? '' : 'none';
    document.getElementById('row-rot-x').style.display = isSemi ? '' : 'none';
    document.getElementById('row-rot-y').style.display = isSemi ? '' : 'none';
    document.getElementById('row-rot-z').style.display = isSemi ? '' : 'none';
    document.getElementById('row-row-dy').style.display = isSemi ? '' : 'none';
    document.getElementById('row-row-dz').style.display = isSemi ? '' : 'none';
    document.getElementById('row-row-pin').style.display = isSemi ? '' : 'none';
    document.getElementById('top-shape-box').style.display = (isSemi && shapeParams.topShapeOn) ? 'flex' : 'none';
    document.getElementById('row-hole').style.display = isCircle ? '' : 'none';
    document.getElementById('row-hole-ratio').style.display = isCircle ? '' : 'none';
    document.getElementById('row-slit-n').style.display = isCircle ? '' : 'none';
    document.getElementById('row-slit-depth').style.display = isCircle ? '' : 'none';
    document.getElementById('row-slit-rot').style.display = isCircle ? '' : 'none';
    document.getElementById('row-pin-count').style.display = isCircle ? 'none' : '';   // 円は穴の円周が固定点
    document.getElementById('shape-top-width-label').textContent = isCircle ? '外径' : '上端幅';
  }
  _updateShapeVisibility();

  // シミュ停止 / リセット
  const btnStop  = document.getElementById('btn-sim-stop');
  const btnReset = document.getElementById('btn-sim-reset');
  btnStop.addEventListener('click', () => {
    simRunning = !simRunning;
    btnStop.textContent  = simRunning ? '⏹ 停止' : '▶ 再開';
    btnStop.style.color  = simRunning ? '#ebb' : '#9eb';
  });
  btnReset.addEventListener('click', () => {
    setInstanceCount(instanceCount, clothNumSegments);
    // 停止状態は維持（simRunning を変えない）
    if (!simRunning) {
      btnStop.textContent = '▶ 再開';
      btnStop.style.color = '#9eb';
    }
  });

  // マント出力
  document.getElementById('btn-export-mantle').addEventListener('click', exportMantle);

  // セクション折りたたみ
  for (const id of ['mat-toggle', 'mesh-toggle', 'shape-toggle', 'collar-toggle', 'fbx-toggle']) {
    const toggle = document.getElementById(id);
    const body   = document.getElementById(id.replace('toggle', 'body'));
    if (toggle && body) {
      toggle.addEventListener('click', () => {
        toggle.classList.toggle('collapsed');
        body.classList.toggle('collapsed');
      });
    }
  }

  // ---- 保存マント(cloth.json)の読み込み（public/cloth/） ----
  // 全コントロールを現在の shapeParams / segments / matParams に同期する
  const setCtl = (id, value, valId, fmt) => {
    const el = document.getElementById(id);
    if (el == null || value == null) return;
    if (el.type === 'checkbox') el.checked = !!value; else el.value = value;
    if (valId) { const v = document.getElementById(valId); if (v) v.textContent = fmt ? fmt(value) : String(value); }
  };
  function syncUIFromState() {
    setCtl('shape-type',        shapeParams.type);
    setCtl('shape-top-width',   shapeParams.topWidth,    'shape-top-width-val',    v => (+v).toFixed(2));
    setCtl('shape-hole',        shapeParams.holeD,       'shape-hole-val',         v => (+v).toFixed(2));
    setCtl('shape-hole-ratio',  shapeParams.holeRatio,   'shape-hole-ratio-val',   v => (+v).toFixed(2));
    setCtl('shape-slit-n',      shapeParams.slitN,       'shape-slit-n-val',       v => String(v));
    setCtl('shape-slit-depth',  shapeParams.slitDepth,   'shape-slit-depth-val',   v => (+v).toFixed(2));
    setCtl('shape-slit-rot',    shapeParams.slitRot,     'shape-slit-rot-val',     v => `${v}°`);
    setCtl('shape-bottom-width',shapeParams.bottomWidth, 'shape-bottom-width-val', v => (+v).toFixed(2));
    setCtl('shape-height',      shapeParams.height,      'shape-height-val',       v => (+v).toFixed(2));
    setCtl('shape-pin-count',   shapeParams.pinCount,    'shape-pin-count-val',    v => String(v));
    setCtl('shape-top-curve',   shapeParams.topCurve,    'shape-top-curve-val',    v => (+v).toFixed(2));
    setCtl('shape-top-ratio',   shapeParams.topRatio,    'shape-top-ratio-val',    v => (+v).toFixed(2));
    setCtl('shape-arc-angle',   shapeParams.arcAngle,    'shape-arc-angle-val',    v => `${v}°`);
    setCtl('shape-hem-jag',     shapeParams.hemJag,      'shape-hem-jag-val',      v => (+v).toFixed(2));
    setCtl('shape-hem-teeth',   shapeParams.hemTeeth,    'shape-hem-teeth-val',    v => String(v));
    setCtl('collar-enable',     shapeParams.collar);
    setCtl('collar-height',     shapeParams.collarHeight,'collar-height-val',      v => (+v).toFixed(2));
    setCtl('collar-flare',      shapeParams.collarFlare, 'collar-flare-val',       v => (+v).toFixed(2));
    setCtl('collar-curve',      shapeParams.collarCurve, 'collar-curve-val',       v => (+v).toFixed(2));
    setCtl('collar-fold',       shapeParams.collarFold,  'collar-fold-val',        v => (+v).toFixed(2));
    setCtl('collar-angle',      shapeParams.collarAngle, 'collar-angle-val',       v => `${v}°`);
    setCtl('collar-taper',      shapeParams.collarTaper, 'collar-taper-val',       v => (+v).toFixed(2));
    setCtl('collar-spline',     shapeParams.collarSpline);
    setCtl('top-shape-on',      shapeParams.topShapeOn);
    syncTopRowUI();
    if (tsBox) tsBox.style.display = (shapeParams.type === 'semicircle' && shapeParams.topShapeOn) ? 'flex' : 'none';
    drawTopShape();
    if (cpBox) cpBox.style.display = shapeParams.collarSpline ? 'flex' : 'none';
    drawCollarSpline();
    setCtl('segments',          clothNumSegments,        'segments-val',           v => `${v}×${v}`);
    setCtl('mat-color-front',   matParams.colorFront);
    setCtl('mat-color-back',    matParams.colorBack);
    setCtl('mat-roughness',     matParams.roughness,     'mat-roughness-val',      v => (+v).toFixed(2));
    setCtl('mat-sheen',         matParams.sheen,         'mat-sheen-val',          v => (+v).toFixed(2));
    setCtl('mat-sheen-roughness',matParams.sheenRoughness,'mat-sheen-roughness-val',v => (+v).toFixed(2));
    setCtl('mat-sheen-color',   matParams.sheenColor);
    setCtl('mat-opacity',       matParams.opacity,       'mat-opacity-val',        v => (+v).toFixed(2));
    _updateShapeVisibility();
    _updateCollarVisibility();
  }
  async function populateClothSelect() {
    const sel = document.getElementById('cloth-select');
    if (!sel) return;
    let files = [];
    try { const r = await fetch('manifest.json'); if (r.ok) files = await r.json(); } catch { /* なし */ }
    sel.innerHTML = '<option value="">-- 選択 --</option>';
    for (const f of files) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f.replace(/\.cloth\.json$/, '');
      sel.appendChild(o);
    }
  }
  async function loadClothJson(name) {
    if (!name) return;
    let j;
    try { const r = await fetch(name); if (!r.ok) return; j = await r.json(); } catch { return; }
    if (j.shapeParams) Object.assign(shapeParams, j.shapeParams);
    if (j.segments) clothNumSegments = j.segments;
    if (j.material) {
      Object.assign(matParams, j.material);
      if (frontColorUniform && matParams.colorFront) frontColorUniform.value.set(matParams.colorFront);
      if (backColorUniform && matParams.colorBack) backColorUniform.value.set(matParams.colorBack);
    }
    syncUIFromState();
    setInstanceCount(instanceCount, clothNumSegments);   // 形状/メッシュ/マテリアルを反映して再生成
  }
  const btnLoadCloth = document.getElementById('btn-load-cloth');
  if (btnLoadCloth) btnLoadCloth.addEventListener('click', () => loadClothJson(document.getElementById('cloth-select').value));
  populateClothSelect();
}

// ============================================================
// Mantle export
// ============================================================
function exportMantle() {
  if (!customCloth && shapeParams.type === 'circle') {   // 円形スカート: 直接メッシュ構造で出力
    const { verletVertices, verletSprings, directRender } = buildVerletGeometry(clothNumSegments, shapeParams);
    const positions = [], pinnedIndices = [];
    verletVertices.forEach((v, i) => {
      positions.push(v.position.x, v.position.y, v.position.z);
      if (v.isFixed) pinnedIndices.push(i);
    });
    const springs = [];
    for (const sp2 of verletSprings) springs.push(sp2.vertex0.id, sp2.vertex1.id);
    const data = {
      version: 1,
      shapeParams: { ...shapeParams },
      segments: clothNumSegments,
      vertexCount: verletVertices.length,
      positions, springs,
      indices: directRender.renderIndex,
      pinnedIndices,
      material: {
        colorFront: matParams.colorFront, colorBack: matParams.colorBack,
        roughness: matParams.roughness, sheen: matParams.sheen,
        sheenRoughness: matParams.sheenRoughness, sheenColor: matParams.sheenColor,
        opacity: matParams.opacity,
      },
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'circle_skirt.cloth.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  if (customCloth) {   // FBX取込マント: 溶接済み頂点/スプリング/三角形＋ピンを出力（quadVertexIds無し）
    const cc = customCloth;
    const data = {
      version: 1,
      vertexCount: cc.positions.length / 3,
      positions: Array.from(cc.positions),
      springs: Array.from(cc.springs),
      indices: Array.from(cc.renderIndex, (i) => cc.renderMap[i]),
      pinnedIndices: [...cc.pins].sort((a, b) => a - b),
      material: {
        colorFront: matParams.colorFront, colorBack: matParams.colorBack,
        roughness: matParams.roughness, sheen: matParams.sheen,
        sheenRoughness: matParams.sheenRoughness, sheenColor: matParams.sheenColor,
        opacity: matParams.opacity,
      },
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (cc.name || 'fbx_mantle').replace(/\.fbx$/i, '') + '.cloth.json';
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  const segs = clothNumSegments;
  const { verletVertices, verletSprings, verletVertexColumns, collarColumns, collarSegs } = buildVerletGeometry(segs, shapeParams);

  const vertexCount   = verletVertices.length;
  const positions     = [];
  const pinnedIndices = [];

  for (let i = 0; i < vertexCount; i++) {
    const v = verletVertices[i];
    positions.push(v.position.x, v.position.y, v.position.z);
    if (v.isFixed) pinnedIndices.push(i);
  }

  const springs = [];
  for (const s of verletSprings) springs.push(s.vertex0.id, s.vertex1.id);

  // グリッドからトライアングルインデックスを生成
  const indices = [];
  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const v00 = verletVertexColumns[x][y].id;
      const v10 = verletVertexColumns[x + 1][y].id;
      const v01 = verletVertexColumns[x][y + 1].id;
      const v11 = verletVertexColumns[x + 1][y + 1].id;
      indices.push(v00, v10, v01);
      indices.push(v10, v11, v01);
    }
  }
  // 衿のトライアングルインデックス（ワインディング逆）
  for (let x = 0; x < segs; x++) {
    for (let cy = 0; cy < collarSegs; cy++) {
      const v00 = collarColumns[x][cy].id;
      const v10 = collarColumns[x + 1][cy].id;
      const v01 = collarColumns[x][cy + 1].id;
      const v11 = collarColumns[x + 1][cy + 1].id;
      indices.push(v01, v10, v00);
      indices.push(v01, v11, v10);
    }
  }

  // Quad レンダーメッシュ（/cloth の createInstance と同一構造）
  const mantleCells       = segs * segs;
  const collarCells       = collarSegs > 0 ? segs * collarSegs : 0;
  const renderVertexCount = mantleCells + collarCells;
  const quadVertexIds     = new Array(renderVertexCount * 4);
  const renderIndices     = [];
  const getMantleRIdx = (x, y)  => y * segs + x;
  const getCollarRIdx = (x, cy) => mantleCells + cy * segs + x;

  for (let x = 0; x < segs; x++) {
    for (let y = 0; y < segs; y++) {
      const idx = getMantleRIdx(x, y);
      quadVertexIds[idx*4]   = verletVertexColumns[x][y].id;
      quadVertexIds[idx*4+1] = verletVertexColumns[x+1][y].id;
      quadVertexIds[idx*4+2] = verletVertexColumns[x][y+1].id;
      quadVertexIds[idx*4+3] = verletVertexColumns[x+1][y+1].id;
      if (x > 0 && y > 0) {
        renderIndices.push(getMantleRIdx(x,y), getMantleRIdx(x-1,y), getMantleRIdx(x-1,y-1));
        renderIndices.push(getMantleRIdx(x,y), getMantleRIdx(x-1,y-1), getMantleRIdx(x,y-1));
      }
    }
  }
  if (collarSegs > 0) {
    for (let x = 0; x < segs; x++) {
      for (let cy = 0; cy < collarSegs; cy++) {
        const idx = getCollarRIdx(x, cy);
        quadVertexIds[idx*4]   = collarColumns[x][cy].id;
        quadVertexIds[idx*4+1] = collarColumns[x+1][cy].id;
        quadVertexIds[idx*4+2] = collarColumns[x][cy+1].id;
        quadVertexIds[idx*4+3] = collarColumns[x+1][cy+1].id;
        if (x > 0) {
          if (cy > 0) {
            renderIndices.push(getCollarRIdx(x-1,cy-1), getCollarRIdx(x-1,cy), getCollarRIdx(x,cy));
            renderIndices.push(getCollarRIdx(x,cy-1), getCollarRIdx(x-1,cy-1), getCollarRIdx(x,cy));
          } else {
            renderIndices.push(getMantleRIdx(x-1,0), getCollarRIdx(x-1,0), getCollarRIdx(x,0));
            renderIndices.push(getMantleRIdx(x,0), getMantleRIdx(x-1,0), getCollarRIdx(x,0));
          }
        }
      }
    }
  }

  const data = {
    version:      1,
    shapeParams:  { ...shapeParams },
    segments:     segs,
    vertexCount,
    positions,
    springs,
    pinnedIndices,
    indices,
    renderVertexCount,
    quadVertexIds,
    renderIndices,
    material: {
      colorFront:     matParams.colorFront,
      colorBack:      matParams.colorBack,
      roughness:      matParams.roughness,
      sheen:          matParams.sheen,
      sheenRoughness: matParams.sheenRoughness,
      sheenColor:     matParams.sheenColor,
      opacity:        matParams.opacity,
    },
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'mantle.cloth.json';
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// Render loop
// ============================================================
function updateSpheres() {
  const n = instances.length;
  for (let i = 0; i < n; i++) {
    const inst   = instances[i];
    const phase  = i * (Math.PI / Math.max(n, 1));
    const localX = Math.sin(timestamp * 2.1 + phase) * 0.1;
    const localZ = Math.sin(timestamp * 0.8 + phase);
    inst.spherePositionUniform.value.set(localX, 0, localZ);
    inst.sphereMesh.position.set(inst.offsetX + localX, 0, localZ);
  }
}

function updateFPS() {
  fpsFrameCount++;
  const now     = performance.now();
  const elapsed = now - fpsLastTime;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount / (elapsed / 1000));
    fpsFrameCount = 0;
    fpsLastTime   = now;
    document.getElementById('fps-counter').textContent = `${fps} FPS`;
  }
}

/**
 * GPU バッファ → CPU スナップショットの非同期リードバック（ピッキング用）
 * グラブ中はスキップして競合を防ぐ
 */
async function render() {
  timer.update();
  updateFPS();

  sphereVisibleUniform.value = params.sphere ? 1 : 0;
  windUniform.value          = params.wind;

  const deltaTime   = Math.min(timer.getDelta(), 1 / 60);
  const stepsPerSec = 360;
  const timePerStep = 1 / stepsPerSec;

  if (refVrm) refVrm.vrm.update(deltaTime);
  if (simRunning) {
    timeSinceLastStep += deltaTime;
    while (timeSinceLastStep >= timePerStep) {
      timestamp         += timePerStep;
      timeSinceLastStep -= timePerStep;
      updateSpheres();
      for (const inst of instances) {
        renderer.compute(inst.computeSpringForces);
        renderer.compute(inst.computeVertexForces);
      }
    }
  }

  renderer.render(scene, camera);
}

// ============================================================
// Init
// ============================================================
async function init() {
  const app     = document.getElementById('app');
  const loading = document.getElementById('loading');

  const hasWebGPU = !!navigator.gpu;

  renderer = new THREE.WebGPURenderer({
    antialias: true,
    requiredLimits: { maxStorageBuffersInVertexStage: 1 },
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping         = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  app.appendChild(renderer.domElement);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(-1.6, -0.1, -1.6);

  // ---- グラブ ハイライト (グラブ中に掴んでいる頂点を表示) ----
  grab.highlightMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.028, 10, 10),
    new THREE.MeshBasicMaterial({
      color:       0xffee00,
      depthTest:   false,
      transparent: true,
      opacity:     0.9,
    }),
  );
  grab.highlightMesh.visible     = false;
  grab.highlightMesh.renderOrder = 999;
  scene.add(grab.highlightMesh);

  // ---- OrbitControls（グラブイベントより後に登録して優先度を下げる）----
  controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 0.5;
  controls.maxDistance = 30;
  controls.target.set(0, -0.1, 0);
  controls.update();

  // 共有ユニフォーム初期化
  stiffnessUniform     = uniform(0.2);
  dampeningUniform     = uniform(0.99);
  windUniform          = uniform(1.0);
  sphereVisibleUniform = uniform(1.0);
  frontColorUniform    = uniform(new THREE.Color(matParams.colorFront));
  backColorUniform     = uniform(new THREE.Color(matParams.colorBack));

  // HDR
  try {
    const hdrLoader  = new UltraHDRLoader();
    const hdrTexture = await hdrLoader.loadAsync(
      'https://threejs.org/examples/textures/equirectangular/royal_esplanade_2k.hdr.jpg',
    );
    hdrTexture.mapping         = THREE.EquirectangularReflectionMapping;
    scene.background           = hdrTexture;
    scene.backgroundBlurriness = 0.5;
    scene.environment          = hdrTexture;
    // VRM試着(MToon)用のライト。MToonはIBLでは照らされないため（布のPBRへの影響は軽微）
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const vd = new THREE.DirectionalLight(0xfff4e6, 1.1);
    vd.position.set(-1.5, 2.5, -1.5);
    scene.add(vd);
  } catch {
    scene.background = new THREE.Color(0x1a1a2e);
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dLight = new THREE.DirectionalLight(0xffffff, 2);
    dLight.position.set(1, 2, 1);
    scene.add(dLight);
  }

  setInstanceCount(1, clothNumSegments);
  setupUI();
  setupGrabEvents(renderer.domElement);

  if (!hasWebGPU) {
    // WebGL2フォールバック: セグメント変更でクラッシュするため無効化
    const segsSlider = document.getElementById('segments');
    const countSlider = document.getElementById('count');
    if (segsSlider) { segsSlider.disabled = true; segsSlider.title = 'WebGPU必須'; }
    if (countSlider) { countSlider.disabled = true; countSlider.title = 'WebGPU必須'; }
    const warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;bottom:36px;left:50%;transform:translateX(-50%);background:rgba(180,120,0,0.85);color:#fff;padding:6px 14px;border-radius:4px;font-size:12px;pointer-events:none;z-index:10;white-space:nowrap;';
    warn.textContent = '⚠ WebGL2モード: Count/Segment変更不可 (WebGPU推奨)';
    document.body.appendChild(warn);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  loading.classList.add('hidden');
  setTimeout(() => { loading.style.display = 'none'; }, 500);

  renderer.setAnimationLoop(render);
  window.__cloth = { get instances() { return instances; }, get camera() { return camera; }, get grab() { return grab; }, get pinEditMode() { return pinEditMode; } };   // デバッグ/自動テスト用
}

init().catch((err) => {
  console.error(err);
  const msg    = document.getElementById('error-msg');
  const detail = document.getElementById('error-detail');
  detail.textContent = String(err);
  msg.classList.add('visible');
  document.getElementById('loading').style.display = 'none';
});
