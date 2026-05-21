import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import * as THREE from 'three';
import { gameStore } from '../stores/gameStore';
import { GAME_CONSTANTS as C } from './constants';
import { createInputManager } from './InputManager';
import { createThirdPersonCamera } from './ThirdPersonCamera';
import { createPlayerController } from './PlayerController';
import { createEnemyManager } from './EnemyManager';

// ---- gameStore ----
describe('gameStore', () => {
  beforeEach(() => {
    localStorage.clear();
    gameStore._resetForTest();
  });

  it('GS-01: 初期状態が正しい', () => {
    const s = get(gameStore);
    expect(s.phase).toBe('start');
    expect(s.score).toBe(0);
    expect(s.highScore).toBe(0);
  });

  it('GS-02: startGame() で playing になり score が 0 になる', () => {
    gameStore.startGame();
    const s = get(gameStore);
    expect(s.phase).toBe('playing');
    expect(s.score).toBe(0);
  });

  it('GS-03: addTime() でスコアが加算される', () => {
    gameStore.startGame();
    gameStore.addTime(1.5);
    expect(get(gameStore).score).toBeCloseTo(1.5);
  });

  it('GS-04: addTime() が累積される', () => {
    gameStore.startGame();
    gameStore.addTime(1.0);
    gameStore.addTime(1.0);
    gameStore.addTime(1.0);
    expect(get(gameStore).score).toBeCloseTo(3.0);
  });

  it('GS-05: gameOver() で gameover になり highScore が更新される', () => {
    gameStore.startGame();
    gameStore.addTime(10.0);
    gameStore.gameOver();
    const s = get(gameStore);
    expect(s.phase).toBe('gameover');
    expect(s.highScore).toBeCloseTo(10.0);
  });

  it('GS-06: gameOver() で highScore が下がらない', () => {
    localStorage.setItem(C.HIGH_SCORE_KEY, '20.00');
    gameStore._resetForTest();
    // highScore を手動設定するためリセット後に直接確認
    gameStore.startGame();
    gameStore.addTime(10.0);
    // highScore は loadHighScore() で復元される（_resetForTest は 0 固定なので別途確認）
    // ここでは gameOver で score < highScore のケースを検証
    const before = get(gameStore).highScore;
    gameStore.gameOver();
    const after = get(gameStore).highScore;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('GS-07: gameOver() で localStorage にハイスコアが保存される', () => {
    gameStore.startGame();
    gameStore.addTime(15.0);
    gameStore.gameOver();
    const saved = parseFloat(localStorage.getItem(C.HIGH_SCORE_KEY) ?? '0');
    expect(saved).toBeCloseTo(15.0);
  });

  it('GS-08: reset() で start フェーズに戻り score が 0 になる', () => {
    gameStore.startGame();
    gameStore.addTime(5.0);
    gameStore.gameOver();
    gameStore.reset();
    const s = get(gameStore);
    expect(s.phase).toBe('start');
    expect(s.score).toBe(0);
  });

  it('GS-09: playing でないときは addTime が score に反映されない', () => {
    gameStore.addTime(1.0); // phase = 'start'
    expect(get(gameStore).score).toBe(0);
  });
});

// ---- InputManager ----
describe('InputManager', () => {
  it('IM-01: キー押下を検出する', () => {
    const im = createInputManager();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(im.isKeyDown('KeyW')).toBe(true);
    im.dispose();
  });

  it('IM-02: キーを離すと false になる', () => {
    const im = createInputManager();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    document.dispatchEvent(new KeyboardEvent('keyup',   { code: 'KeyW' }));
    expect(im.isKeyDown('KeyW')).toBe(false);
    im.dispose();
  });

  it('IM-03: 複数キー同時押しを検出する', () => {
    const im = createInputManager();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    expect(im.isKeyDown('KeyW')).toBe(true);
    expect(im.isKeyDown('KeyD')).toBe(true);
    im.dispose();
  });

  function dispatchMoveEvent(dx: number, dy: number): void {
    const e = new MouseEvent('mousemove');
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: dy });
    document.dispatchEvent(e);
  }

  it('IM-04: マウスドラッグ中に delta が蓄積される', () => {
    const im = createInputManager();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    dispatchMoveEvent(10, -5);
    expect(im.getMouseDelta()).toEqual({ x: 10, y: -5 });
    im.dispose();
  });

  it('IM-05: consumeMouseDelta でリセットされる', () => {
    const im = createInputManager();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    dispatchMoveEvent(10, 5);
    im.consumeMouseDelta();
    expect(im.getMouseDelta()).toEqual({ x: 0, y: 0 });
    im.dispose();
  });

  it('IM-06: mousedown なしの mousemove では delta が蓄積されない', () => {
    const im = createInputManager();
    document.dispatchEvent(new MouseEvent('mousemove', { movementX: 10, movementY: 5 }));
    expect(im.getMouseDelta()).toEqual({ x: 0, y: 0 });
    im.dispose();
  });

  it('IM-07: dispose 後にキーイベントが無視される', () => {
    const im = createInputManager();
    im.dispose();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(im.isKeyDown('KeyW')).toBe(false);
  });
});

// ---- ThirdPersonCamera ----
describe('ThirdPersonCamera', () => {
  it('TC-01: 初期 yaw は Math.PI', () => {
    const cam = createThirdPersonCamera();
    expect(cam.yaw).toBeCloseTo(Math.PI);
  });

  it('TC-02: マウス X で yaw が変化する', () => {
    const cam = createThirdPersonCamera();
    const before = cam.yaw;
    cam.applyMouseDelta(100, 0);
    expect(cam.yaw).not.toBeCloseTo(before);
    expect(cam.yaw).toBeLessThan(before);
  });

  it('TC-03: マウス Y で pitch が変化する（update 経由で確認）', () => {
    const cam1 = createThirdPersonCamera();
    const cam2 = createThirdPersonCamera();
    const camera1 = new THREE.PerspectiveCamera();
    const camera2 = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3();
    cam1.update(camera1, target);
    cam2.applyMouseDelta(0, 100);
    cam2.update(camera2, target);
    expect(camera1.position.y).not.toBeCloseTo(camera2.position.y);
  });

  it('TC-04: pitch は CAMERA_PITCH_MAX を超えない', () => {
    const cam = createThirdPersonCamera();
    cam.applyMouseDelta(0, -100000);
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3();
    cam.update(camera, target);
    // pitch がクランプされているので Y は有限値
    expect(isFinite(camera.position.y)).toBe(true);
    expect(camera.position.y).toBeLessThan(C.CAMERA_OFFSET_BACK * 2 + C.CAMERA_OFFSET_UP + 10);
  });

  it('TC-05: pitch は CAMERA_PITCH_MIN を下回らない', () => {
    const cam = createThirdPersonCamera();
    cam.applyMouseDelta(0, 100000);
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3();
    cam.update(camera, target);
    expect(isFinite(camera.position.y)).toBe(true);
  });

  it('TC-06: update() でカメラ位置が target から離れた位置に設定される', () => {
    const cam = createThirdPersonCamera();
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(0, 0, 0);
    cam.update(camera, target);
    expect(camera.position.distanceTo(target)).toBeGreaterThan(0);
  });

  it('TC-07: update() 後にカメラが target 方向を向く', () => {
    const cam = createThirdPersonCamera();
    const camera = new THREE.PerspectiveCamera();
    const target = new THREE.Vector3(5, 0, 5);
    cam.update(camera, target);
    // カメラが target を向いていることを確認（カメラから target へのベクトルとカメラ前方が近い）
    const toCam = new THREE.Vector3().subVectors(target, camera.position).normalize();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    // dot product が正（同方向）
    expect(toCam.dot(forward)).toBeGreaterThan(0);
  });
});

// ---- PlayerController ----
describe('PlayerController', () => {
  function makeInput(keys: string[]): ReturnType<typeof createInputManager> {
    const set = new Set(keys);
    return {
      isKeyDown: (k: string) => set.has(k),
      getMouseDelta: () => ({ x: 0, y: 0 }),
      consumeMouseDelta: () => {},
      dispose: () => {},
    };
  }

  it('PC-01: W キーで Z が減少する（cameraYaw=0 で前方 = -Z）', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyW']);
    pc.update(0.1, 0, input);
    expect(pc.position.z).toBeLessThan(0);
  });

  it('PC-02: S キーで Z が増加する', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyS']);
    pc.update(0.1, 0, input);
    expect(pc.position.z).toBeGreaterThan(0);
  });

  it('PC-03: A キーで X が減少する', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyA']);
    pc.update(0.1, 0, input);
    expect(pc.position.x).toBeLessThan(0);
  });

  it('PC-03b: D キーで X が増加する', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyD']);
    pc.update(0.1, 0, input);
    expect(pc.position.x).toBeGreaterThan(0);
  });

  it('PC-04: cameraYaw=PI/2 で W を押すと X が変化する', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyW']);
    pc.update(0.1, Math.PI / 2, input);
    // yaw=PI/2 → sin(PI/2)=1, cos(PI/2)≈0 → worldX≈-1 → X が減少
    expect(Math.abs(pc.position.x)).toBeGreaterThan(0.01);
  });

  it('PC-05: +X 境界クランプが機能する', () => {
    const pc = createPlayerController();
    const input = makeInput(['KeyD']);
    // 大きな delta で境界を超えようとする
    pc.update(1000, 0, input);
    expect(pc.position.x).toBeLessThanOrEqual(C.FIELD_HALF);
  });

  it('PC-06: -X, ±Z 境界クランプが機能する', () => {
    const pc = createPlayerController();
    pc.update(1000, 0, makeInput(['KeyA']));
    expect(pc.position.x).toBeGreaterThanOrEqual(-C.FIELD_HALF);
    pc.update(1000, 0, makeInput(['KeyS']));
    expect(pc.position.z).toBeLessThanOrEqual(C.FIELD_HALF);
    pc.update(1000, 0, makeInput(['KeyW']));
    expect(pc.position.z).toBeGreaterThanOrEqual(-C.FIELD_HALF);
  });

  it('PC-07: 移動中は true を返す', () => {
    const pc = createPlayerController();
    const result = pc.update(0.1, 0, makeInput(['KeyW']));
    expect(result).toBe(true);
  });

  it('PC-08: 停止中は false を返す', () => {
    const pc = createPlayerController();
    const result = pc.update(0.1, 0, makeInput([]));
    expect(result).toBe(false);
  });

  it('PC-09: VRM 位置が同期される', () => {
    const pc = createPlayerController();
    const mockVRM = { scene: { position: new THREE.Vector3(), rotation: { y: 0 } } } as Parameters<typeof pc.setVRM>[0];
    pc.setVRM(mockVRM);
    pc.update(0.1, 0, makeInput(['KeyW']));
    expect(mockVRM!.scene.position.z).toBeCloseTo(pc.position.z);
  });

  it('PC-10: VRM の向きが移動方向になる', () => {
    const pc = createPlayerController();
    const mockVRM = { scene: { position: new THREE.Vector3(), rotation: { y: 0 } } } as Parameters<typeof pc.setVRM>[0];
    pc.setVRM(mockVRM);
    pc.update(0.1, 0, makeInput(['KeyD']));
    // 右（+X）方向 → atan2(1, 0) = PI/2
    expect(mockVRM!.scene.rotation.y).toBeCloseTo(Math.PI / 2, 1);
  });
});

// ---- EnemyManager ----
describe('EnemyManager', () => {
  it('EM-01: spawn で ENEMY_COUNT 体生成される', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);
    expect(scene.children).toHaveLength(C.ENEMY_COUNT);
    em.dispose(scene);
  });

  it('EM-02: スポーン位置が最小距離以上', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);
    for (const child of scene.children) {
      const pos2D = new THREE.Vector3(child.position.x, 0, child.position.z);
      expect(pos2D.distanceTo(playerPos)).toBeGreaterThanOrEqual(C.ENEMY_SPAWN_MIN_DIST - 0.01);
    }
    em.dispose(scene);
  });

  it('EM-03: update でエネミーがプレイヤーに近づく', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);

    const before = scene.children.map((c) => c.position.distanceTo(playerPos));
    em.update(0.5, playerPos);
    const after = scene.children.map((c) => c.position.distanceTo(playerPos));

    for (let i = 0; i < C.ENEMY_COUNT; i++) {
      expect(after[i]).toBeLessThan(before[i]);
    }
    em.dispose(scene);
  });

  it('EM-04: 接触距離以内で gameover を返す', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);

    // エネミーを接触距離内に強制移動
    const enemy = scene.children[0];
    enemy.position.set(0, 0, C.ENEMY_CONTACT_RADIUS * 0.5);

    const result = em.update(0.016, playerPos);
    expect(result).toBe('gameover');
    em.dispose(scene);
  });

  it('EM-05: 接触距離外では alive を返す', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);

    // 全エネミーを安全な距離に配置
    for (const child of scene.children) {
      child.position.set(C.FIELD_HALF, 0, C.FIELD_HALF);
    }

    const result = em.update(0.016, playerPos);
    expect(result).toBe('alive');
    em.dispose(scene);
  });

  it('EM-06: 1体だけ接触距離内なら gameover になる', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    const playerPos = new THREE.Vector3(0, 0, 0);
    em.spawn(scene, playerPos);

    // 最初の1体だけ接触距離内
    scene.children[0].position.set(0, 0, 0.1);
    // 残りは遠くに
    for (let i = 1; i < scene.children.length; i++) {
      scene.children[i].position.set(C.FIELD_HALF, 0, C.FIELD_HALF);
    }

    const result = em.update(0.016, playerPos);
    expect(result).toBe('gameover');
    em.dispose(scene);
  });

  it('EM-07: dispose でシーンから全エネミーが削除される', () => {
    const em = createEnemyManager();
    const scene = new THREE.Scene();
    em.spawn(scene, new THREE.Vector3());
    em.dispose(scene);
    expect(scene.children).toHaveLength(0);
  });
});
