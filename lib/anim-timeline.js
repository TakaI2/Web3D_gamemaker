// lib/anim-timeline.js — ポーズキー＋表情トラックのアニメーションタイムライン（anim-editor / furn-anim-editor 共用）。
// フレーム目盛り・ヘッド/キードラッグ・ホイールズーム・中ボタンパン・時間挿入・右端ドラッグ延長・
// グリップで高さリサイズ・表情キー（ライブプレビュー）・VRMA書き出し/クリップ取り込み。
// 依存: els(DOM要素群)・getVrm()（正規化ボーンへ書き込む）・pose-kit の buildVrmaBlob。
import * as THREE from 'https://esm.sh/three@0.184.0';
import { buildVrmaBlob } from './pose-kit.js';

export const FPS = 30;
const TL_RULER = 18, TL_PAD = 6, HEADER_W = 76, ROW_H = 22;

// els: { canvas, grip, info, play, dur, loop, bsSel?, bsVal?, bsValTxt? }
export function createAnimTimeline({ els, getVrm, getHipsRestY, setStatus = () => {}, onPoseEdited = () => {} }) {
  const tl = { keys: [], t: 0, dur: 4, playing: false, loop: true, selKey: -1, bs: new Map(), selBs: null, selRange: null };
  const tlv = { pxf: 6, scroll: 0, userZoom: false, h: 64 };
  const nb = (name) => getVrm()?.humanoid?.getNormalizedBoneNode(name);
  const durF = () => Math.max(1, Math.round(tl.dur * FPS));
  const f2x = (f) => HEADER_W + TL_PAD + f * tlv.pxf - tlv.scroll;
  const x2f = (x) => (x + tlv.scroll - HEADER_W - TL_PAD) / tlv.pxf;
  const tlRows = () => ['__pose__', ...tl.bs.keys()];
  // 範囲選択（Shift+ドラッグ）: {t0,t1,r0,r1}＝時間×行の矩形
  const inRange = (ri, t) => tl.selRange && ri >= tl.selRange.r0 && ri <= tl.selRange.r1 && t >= tl.selRange.t0 - 1e-4 && t <= tl.selRange.t1 + 1e-4;
  function rangeCount() {
    if (!tl.selRange) return 0;
    let n = 0;
    tlRows().forEach((row, ri) => {
      if (row === '__pose__') n += tl.keys.filter((k) => inRange(ri, k.t)).length;
      else n += (tl.bs.get(row) || []).filter((k) => inRange(ri, k.t)).length;
    });
    return n;
  }
  const bsNames = () => getVrm()?.expressionManager ? getVrm().expressionManager.expressions.map((e) => e.expressionName) : [];

  function setDur(sec) {
    tl.dur = Math.max(0.5, Number(sec.toFixed(2)));
    if (els.dur) els.dur.value = String(tl.dur);
  }
  // ── ポーズのキャプチャ/適用 ──
  function capturePose() {
    const vrm = getVrm();
    const pose = {};
    for (const name of Object.keys(vrm.humanoid.humanBones)) {
      const b = nb(name);
      if (b) { const q = b.quaternion; pose[name] = [q.x, q.y, q.z, q.w]; }
    }
    const hp = nb('hips').position;
    return { pose, hips: [hp.x, hp.y, hp.z] };
  }
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  function applyPoseAt(t) {
    const vrm = getVrm();
    if (!vrm) return;
    if (tl.keys.length) {
      const ks = tl.keys;
      let i = 0;
      while (i < ks.length && ks[i].t <= t) i++;
      const k0 = ks[Math.max(0, i - 1)], k1 = ks[Math.min(ks.length - 1, i)];
      const span = k1.t - k0.t;
      const f = span > 1e-5 ? THREE.MathUtils.clamp((t - k0.t) / span, 0, 1) : 0;
      for (const name of Object.keys(k0.pose)) {
        const b = nb(name);
        if (!b || !k1.pose[name]) continue;
        _qa.fromArray(k0.pose[name]);
        _qb.fromArray(k1.pose[name]);
        b.quaternion.copy(_qa.slerp(_qb, f));
      }
      nb('hips').position.set(
        k0.hips[0] + (k1.hips[0] - k0.hips[0]) * f,
        k0.hips[1] + (k1.hips[1] - k0.hips[1]) * f,
        k0.hips[2] + (k1.hips[2] - k0.hips[2]) * f,
      );
    }
    if (vrm.expressionManager) {
      for (const [name, arr] of tl.bs) {
        if (!arr.length) continue;
        let i = 0;
        while (i < arr.length && arr[i].t <= t) i++;
        const k0 = arr[Math.max(0, i - 1)], k1 = arr[Math.min(arr.length - 1, i)];
        const span = k1.t - k0.t;
        const f = span > 1e-5 ? THREE.MathUtils.clamp((t - k0.t) / span, 0, 1) : 0;
        vrm.expressionManager.setValue(name, k0.v + (k1.v - k0.v) * f);
      }
    }
  }
  // ── キー操作 ──
  function addKey() {
    if (!getVrm()) return;
    const t = Number(tl.t.toFixed(2));
    const snap = capturePose();
    const near = tl.keys.findIndex((k) => Math.abs(k.t - t) < 0.05);
    if (near >= 0) { tl.keys[near] = { t: tl.keys[near].t, ...snap }; tl.selKey = near; }
    else {
      tl.keys.push({ t, ...snap });
      tl.keys.sort((a, b) => a.t - b.t);
      tl.selKey = tl.keys.findIndex((k) => k.t === t);
    }
    tl.selBs = null;
    draw();
    setStatus(`キー ${near >= 0 ? '更新' : '追加'}: ${t.toFixed(2)}s（計${tl.keys.length}個）`);
  }
  function delKey() {
    if (tl.selRange) {   // 範囲選択の一括削除（ポーズ/表情キーとも）
      let n = 0;
      tlRows().forEach((row, ri) => {
        if (row === '__pose__') {
          const before = tl.keys.length;
          tl.keys = tl.keys.filter((k) => !inRange(ri, k.t));
          n += before - tl.keys.length;
        } else {
          const arr = tl.bs.get(row);
          if (!arr) return;
          const left = arr.filter((k) => !inRange(ri, k.t));
          n += arr.length - left.length;
          if (left.length) tl.bs.set(row, left);
          else tl.bs.delete(row);
        }
      });
      tl.selRange = null;
      tl.selKey = -1;
      tl.selBs = null;
      draw();
      setStatus(`範囲内のキー ${n}個を削除しました`);
      return;
    }
    if (tl.selBs) {
      const arr = tl.bs.get(tl.selBs.name);
      if (arr) {
        arr.splice(tl.selBs.i, 1);
        if (!arr.length) tl.bs.delete(tl.selBs.name);
      }
      tl.selBs = null;
      draw();
      return;
    }
    if (tl.selKey < 0 || !tl.keys[tl.selKey]) return;
    tl.keys.splice(tl.selKey, 1);
    tl.selKey = -1;
    draw();
  }
  function insertTime(sec = 0.5) {
    for (const k of tl.keys) if (k.t >= tl.t - 1e-4) k.t = Number((k.t + sec).toFixed(3));
    for (const arr of tl.bs.values()) for (const k of arr) if (k.t >= tl.t - 1e-4) k.t = Number((k.t + sec).toFixed(3));
    setDur(tl.dur + sec);
    draw();
    setStatus(`${tl.t.toFixed(2)}s 以降に ${sec}s 挿入しました`);
  }
  // ── 表情キー ──
  function addBsKey() {
    const name = els.bsSel?.value;
    if (!name || !getVrm()) return;
    const v = parseFloat(els.bsVal.value);
    const t = Number(tl.t.toFixed(3));
    if (!tl.bs.has(name)) tl.bs.set(name, []);
    const arr = tl.bs.get(name);
    const near = arr.findIndex((k) => Math.abs(k.t - t) < 0.05);
    if (near >= 0) arr[near].v = v;
    else { arr.push({ t, v }); arr.sort((a, b) => a.t - b.t); }
    tl.selBs = { name, i: arr.findIndex((k) => Math.abs(k.t - t) < 0.05) };
    tl.selKey = -1;
    draw();
    setStatus(`表情キー: ${name}=${v.toFixed(2)} @${t.toFixed(2)}s`);
  }
  function refreshBsList() {
    if (!els.bsSel) return;
    els.bsSel.innerHTML = '';
    for (const nm of bsNames()) { const o = document.createElement('option'); o.value = nm; o.textContent = nm; els.bsSel.appendChild(o); }
  }
  // ── 描画 ──
  function drawKeyDiamond(ctx, x, y, sel, color) {
    ctx.fillStyle = sel ? '#ffffff' : color;
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fill();
  }
  function draw() {
    const cv = els.canvas;
    const W = cv.clientWidth || 600;
    const rows = tlRows();
    const H = Math.max(tlv.h, TL_RULER + rows.length * ROW_H + 4);
    cv.style.height = H + 'px';
    if (cv.width !== W) cv.width = W;
    cv.height = H;
    if (!tlv.userZoom) { tlv.pxf = Math.max(0.5, (W - HEADER_W - TL_PAD * 2) / durF()); tlv.scroll = 0; }
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0d0f22';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    const step = Math.max(5, Math.round(55 / tlv.pxf / 5) * 5);
    ctx.strokeStyle = '#20203a';
    ctx.beginPath();
    for (let f = 0; f <= durF(); f += step) {
      const x = f2x(f);
      if (x < HEADER_W - 2 || x > W + 20) continue;
      ctx.moveTo(x, TL_RULER);
      ctx.lineTo(x, H);
      ctx.fillStyle = '#667';
      ctx.fillText(String(f), x, 12);
    }
    ctx.stroke();
    if (tl.selRange) {   // 範囲選択の矩形（キーの下に敷く）
      const rx0 = f2x(Math.round(tl.selRange.t0 * FPS)), rx1 = f2x(Math.round(tl.selRange.t1 * FPS));
      const ry0 = TL_RULER + tl.selRange.r0 * ROW_H, ry1 = TL_RULER + (tl.selRange.r1 + 1) * ROW_H;
      ctx.fillStyle = 'rgba(110,160,255,0.16)';
      ctx.fillRect(rx0, ry0, Math.max(2, rx1 - rx0), ry1 - ry0);
      ctx.strokeStyle = 'rgba(140,180,255,0.7)';
      ctx.strokeRect(rx0 + 0.5, ry0 + 0.5, Math.max(2, rx1 - rx0) - 1, ry1 - ry0 - 1);
    }
    rows.forEach((row, ri) => {
      const y0 = TL_RULER + ri * ROW_H, yc = y0 + ROW_H / 2;
      ctx.strokeStyle = '#1a1e33';
      ctx.beginPath(); ctx.moveTo(HEADER_W, y0 + ROW_H - 0.5); ctx.lineTo(W, y0 + ROW_H - 0.5); ctx.stroke();
      if (row === '__pose__') {
        tl.keys.forEach((k, i) => {
          const x = f2x(Math.round(k.t * FPS));
          if (x > HEADER_W - 8 && x < W + 8) drawKeyDiamond(ctx, x, yc, (i === tl.selKey && !tl.selBs) || inRange(ri, k.t), '#ffd060');
        });
      } else {
        (tl.bs.get(row) || []).forEach((k, i) => {
          const x = f2x(Math.round(k.t * FPS));
          if (x > HEADER_W - 8 && x < W + 8) drawKeyDiamond(ctx, x, yc, (tl.selBs?.name === row && tl.selBs?.i === i) || inRange(ri, k.t), '#5fd0ff');
        });
      }
    });
    ctx.fillStyle = '#12142a';
    ctx.fillRect(0, 0, HEADER_W, H);
    ctx.strokeStyle = '#2a2a44';
    ctx.beginPath(); ctx.moveTo(HEADER_W - 0.5, 0); ctx.lineTo(HEADER_W - 0.5, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, TL_RULER - 0.5); ctx.lineTo(W, TL_RULER - 0.5); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui';
    rows.forEach((row, ri) => {
      ctx.fillStyle = row === '__pose__' ? '#ffd060' : '#5fd0ff';
      ctx.fillText(row === '__pose__' ? 'ポーズ' : row, 6, TL_RULER + ri * ROW_H + ROW_H / 2 + 4);
    });
    const px = f2x(Math.round(tl.t * FPS));
    if (px >= HEADER_W - 1) {
      ctx.strokeStyle = '#ff3333';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = '#ff3333';
      ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8); ctx.closePath(); ctx.fill();
    }
    const nBs = [...tl.bs.values()].reduce((s, a) => s + a.length, 0);
    if (els.info) els.info.textContent = `${Math.round(tl.t * FPS)}f / ${durF()}f（ポーズ${tl.keys.length} 表情${nBs}）`;
  }
  function seek(t, apply = true) {
    tl.t = THREE.MathUtils.clamp(t, 0, tl.dur);
    if (apply) applyPoseAt(tl.t);
    draw();
  }
  // ── 入力イベント ──
  function setupEvents() {
    const cv = els.canvas;
    let drag = null;
    const local = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const dragExtend = (x) => {
      let f = Math.round(x2f(x));
      if (f < 0) f = 0;
      if (f > durF()) setDur(f / FPS);
      return f;
    };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      const [x, y] = local(e);
      if (e.button === 1) { drag = { kind: 'pan', panX: x, panScroll: tlv.scroll }; e.preventDefault(); return; }
      if (e.shiftKey && e.button === 0 && x > HEADER_W && y > TL_RULER) {   // Shift+ドラッグ=範囲選択
        tl.selKey = -1;
        tl.selBs = null;
        tl.selRange = null;
        drag = { kind: 'range', x0: x, y0: y };
        draw();
        return;
      }
      tl.selRange = null;
      const rows = tlRows();
      const ri = Math.floor((y - TL_RULER) / ROW_H);
      const row = rows[ri];
      if (y > TL_RULER && row && x > HEADER_W) {
        if (row === '__pose__') {
          const ki = tl.keys.findIndex((k) => Math.abs(f2x(Math.round(k.t * FPS)) - x) < 8);
          if (ki >= 0) {
            tl.selKey = ki; tl.selBs = null;
            drag = { kind: 'key', key: tl.keys[ki] };
            seek(tl.keys[ki].t);
            return;
          }
        } else {
          const arr = tl.bs.get(row);
          const ki = arr.findIndex((k) => Math.abs(f2x(Math.round(k.t * FPS)) - x) < 8);
          if (ki >= 0) {
            tl.selBs = { name: row, i: ki }; tl.selKey = -1;
            if (els.bsSel) {
              els.bsSel.value = row;
              els.bsVal.value = String(arr[ki].v);
              els.bsValTxt.textContent = arr[ki].v.toFixed(2);
            }
            drag = { kind: 'bskey', arr, key: arr[ki], name: row };
            seek(arr[ki].t);
            return;
          }
        }
      }
      tl.selKey = -1; tl.selBs = null;
      drag = { kind: 'scrub' };
      seek(x2f(x) / FPS);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = local(e);
      if (drag.kind === 'pan') { tlv.scroll = Math.max(0, drag.panScroll - (x - drag.panX)); tlv.userZoom = true; draw(); return; }
      if (drag.kind === 'range') {
        const rows = tlRows();
        const f0 = Math.min(x2f(drag.x0), x2f(x)), f1 = Math.max(x2f(drag.x0), x2f(x));
        tl.selRange = {
          t0: Math.max(0, f0) / FPS, t1: Math.max(0, f1) / FPS,
          r0: Math.max(0, Math.floor((Math.min(drag.y0, y) - TL_RULER) / ROW_H)),
          r1: Math.min(rows.length - 1, Math.floor((Math.max(drag.y0, y) - TL_RULER) / ROW_H)),
        };
        draw();
        return;
      }
      if (drag.kind === 'scrub') { seek(x2f(x) / FPS); return; }
      const f = dragExtend(x);
      drag.key.t = Number((f / FPS).toFixed(3));
      if (drag.kind === 'key') {
        tl.keys.sort((a, b) => a.t - b.t);
        tl.selKey = tl.keys.indexOf(drag.key);
      } else {
        drag.arr.sort((a, b) => a.t - b.t);
        tl.selBs = { name: drag.name, i: drag.arr.indexOf(drag.key) };
      }
      seek(drag.key.t);
    });
    const end = () => {
      if (drag?.kind === 'range' && tl.selRange) {
        const n = rangeCount();
        if (n) setStatus(`範囲選択: キー${n}個（キー削除 / Delete で一括削除）`);
        else { tl.selRange = null; draw(); }
      }
      drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x] = local(e);
      const fAt = x2f(x);
      tlv.userZoom = true;
      tlv.pxf = THREE.MathUtils.clamp(tlv.pxf * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 0.5, 40);
      tlv.scroll = Math.max(0, fAt * tlv.pxf - (x - HEADER_W - TL_PAD));
      draw();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { tlv.userZoom = false; draw(); });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.code === 'Delete' || e.code === 'Backspace') && (tl.selRange || tl.selKey >= 0 || tl.selBs)) delKey();
    });
    if (els.grip) {
      let gripDrag = null;
      els.grip.addEventListener('pointerdown', (e) => { els.grip.setPointerCapture(e.pointerId); gripDrag = { y: e.clientY, h: tlv.h }; });
      els.grip.addEventListener('pointermove', (e) => {
        if (!gripDrag) return;
        tlv.h = THREE.MathUtils.clamp(gripDrag.h + (gripDrag.y - e.clientY), 64, Math.round(window.innerHeight * 0.6));
        draw();
      });
      els.grip.addEventListener('pointerup', () => { gripDrag = null; });
    }
    if (els.bsVal) {
      els.bsVal.addEventListener('input', () => {   // スライダ=ライブプレビュー＋選択キー値編集
        const v = parseFloat(els.bsVal.value);
        els.bsValTxt.textContent = v.toFixed(2);
        const name = els.bsSel.value;
        const vrm = getVrm();
        if (name && vrm?.expressionManager) vrm.expressionManager.setValue(name, v);
        if (tl.selBs && tl.selBs.name === name) {
          const arr = tl.bs.get(name);
          if (arr?.[tl.selBs.i]) { arr[tl.selBs.i].v = v; draw(); }
        }
      });
    }
    if (els.dur) els.dur.addEventListener('change', () => { setDur(parseFloat(els.dur.value) || 4); draw(); });
    if (els.loop) els.loop.addEventListener('change', (e) => { tl.loop = e.target.checked; });
    if (els.play) {
      els.play.addEventListener('click', () => {
        tl.playing = !tl.playing;
        els.play.textContent = tl.playing ? '⏸ 停止' : '▶ 再生';
        if (tl.playing && tl.t >= tl.dur - 0.01) tl.t = 0;
      });
    }
  }
  // ── 再生（毎フレーム呼ぶ）──
  function update(dt) {
    if (!tl.playing) return;
    tl.t += dt;
    if (tl.t >= tl.dur) {
      if (tl.loop) tl.t = 0;
      else { tl.t = tl.dur; tl.playing = false; if (els.play) els.play.textContent = '▶ 再生'; }
    }
    applyPoseAt(tl.t);
    draw();
  }
  // ── VRMA変換 ──
  function buildBlob() {
    let keys = tl.keys;
    if (!keys.length) { setStatus('キーがありません（Kでキー追加）'); return null; }
    if (keys.length === 1) keys = [keys[0], { ...keys[0], t: keys[0].t + 0.5 }];
    const times = new Float32Array(keys.map((k) => k.t));
    const boneNames = Object.keys(keys[0].pose);
    const tracks = boneNames.map((boneName) => {
      const values = new Float32Array(keys.length * 4);
      keys.forEach((k, i) => values.set(k.pose[boneName] || [0, 0, 0, 1], i * 4));
      return { boneName, times, values };
    });
    const hipVals = new Float32Array(keys.length * 3);
    keys.forEach((k, i) => hipVals.set(k.hips, i * 3));
    const blendShapes = [];
    for (const [name, arr] of tl.bs) {
      if (!arr.length) continue;
      blendShapes.push({
        expressionName: name,
        times: new Float32Array(arr.map((k) => k.t)),
        values: new Float32Array(arr.map((k) => k.v)),
      });
    }
    const lastBs = blendShapes.reduce((m, b) => Math.max(m, b.times[b.times.length - 1]), 0);
    return buildVrmaBlob({
      durationSec: Math.max(times[times.length - 1], lastBs), hipsRestY: getHipsRestY(), tracks,
      hipPositionTrack: { times, values: hipVals },
      blendShapes: blendShapes.length ? blendShapes : undefined,
    });
  }
  // クリップ→キー化（8fps均等・上限120）。mixerで順次サンプルしてポーズ/表情を拾う
  function importClip(clip) {
    const vrm = getVrm();
    const mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.clipAction(clip).play();
    const fps = 8, n = Math.min(120, Math.max(2, Math.ceil(clip.duration * fps)));
    tl.keys = [];
    const names = bsNames();
    const bsSamples = new Map(names.map((nm) => [nm, []]));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * clip.duration;
      mixer.setTime(t);
      tl.keys.push({ t: Number(t.toFixed(3)), ...capturePose() });
      for (const nm of names) bsSamples.get(nm).push({ t: Number(t.toFixed(3)), v: vrm.expressionManager?.getValue(nm) ?? 0 });
    }
    tl.bs = new Map();
    for (const [nm, arr] of bsSamples) if (arr.some((k) => k.v > 0.001)) tl.bs.set(nm, arr);
    tl.selBs = null;
    mixer.stopAllAction();
    mixer.uncacheRoot(vrm.scene);
    setDur(Math.max(0.5, Number(clip.duration.toFixed(2))));
    tl.selKey = -1;
    seek(0);
    onPoseEdited();
  }
  setupEvents();
  return { tl, addKey, delKey, insertTime, addBsKey, refreshBsList, seek, draw, update, buildBlob, importClip, setDur };
}
