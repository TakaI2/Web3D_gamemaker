<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { appModeStore } from '../stores/appModeStore';
  import { createFpsPlayer } from '../fps/FpsPlayer';
  import { createFpsSpheres } from '../fps/FpsSpheres';
  import { createFpsWorld } from '../fps/FpsWorld';
  import { FPS_CONSTANTS as C } from '../fps/FpsConstants';
  import type { FpsInput } from '../fps/FpsPlayer';

  export let onBack: (() => void) | undefined = undefined;

  let canvas: HTMLCanvasElement;
  let loading = true;
  let loadProgress = 0;
  let pointerLocked = false;
  let mounted = false;

  const input: FpsInput = {
    forward: false, backward: false, left: false, right: false, jump: false,
  };
  let mouseDownTime = 0;

  // Three.js オブジェクト（onMount 後に初期化）
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let clock: THREE.Clock | null = null;

  onMount(() => {
    mounted = true;
    init();
  });

  onDestroy(() => {
    mounted = false;
    cleanup();
  });

  function init() {
    // レンダラー
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    // シーン
    scene = new THREE.Scene();
    scene.background = new THREE.Color(C.FOG_COLOR);
    scene.fog = new THREE.Fog(C.FOG_COLOR, C.FOG_NEAR, C.FOG_FAR);

    // カメラ
    camera = new THREE.PerspectiveCamera(
      C.CAMERA_FOV,
      canvas.clientWidth / canvas.clientHeight,
      C.CAMERA_NEAR,
      C.CAMERA_FAR,
    );
    camera.rotation.order = 'YXZ';

    // 照明
    const hemiLight = new THREE.HemisphereLight(0x8dc1de, 0x00668d, 1.5);
    hemiLight.position.set(2, 1, 1);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
    dirLight.position.set(5, 25, -1);
    dirLight.castShadow = true;
    dirLight.shadow.camera.near = 0.01;
    dirLight.shadow.camera.far = 500;
    dirLight.shadow.camera.right = 30;
    dirLight.shadow.camera.left = -30;
    dirLight.shadow.camera.top = 30;
    dirLight.shadow.camera.bottom = -30;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    dirLight.shadow.radius = 4;
    dirLight.shadow.bias = -0.00006;
    scene.add(dirLight);

    clock = new THREE.Clock();

    const player = createFpsPlayer();
    const spheres = createFpsSpheres(scene);
    const world = createFpsWorld();

    // イベントリスナー
    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    input.forward  = true; break;
        case 'KeyS': case 'ArrowDown':  input.backward = true; break;
        case 'KeyA': case 'ArrowLeft':  input.left     = true; break;
        case 'KeyD': case 'ArrowRight': input.right    = true; break;
        case 'Space': input.jump = true; e.preventDefault(); break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp':    input.forward  = false; break;
        case 'KeyS': case 'ArrowDown':  input.backward = false; break;
        case 'KeyA': case 'ArrowLeft':  input.left     = false; break;
        case 'KeyD': case 'ArrowRight': input.right    = false; break;
        case 'Space': input.jump = false; break;
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!pointerLocked) return;
      camera!.rotation.y -= e.movementX * 0.002;
      camera!.rotation.x -= e.movementY * 0.002;
      camera!.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera!.rotation.x));
    };
    const onMouseDown = () => {
      if (!pointerLocked) return;
      mouseDownTime = Date.now();
    };
    const onMouseUp = () => {
      if (!pointerLocked || mouseDownTime === 0) return;
      spheres.throwBall(camera!, player.velocity, mouseDownTime);
      mouseDownTime = 0;
    };
    const onPointerLockChange = () => {
      pointerLocked = document.pointerLockElement === canvas;
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', () => canvas.requestPointerLock());

    // リサイズ
    const resizeObserver = new ResizeObserver(() => {
      if (!renderer || !camera) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(canvas);

    // マップロード
    const base = import.meta.env.BASE_URL ?? '/';
    world.load(scene, `${base}models/gltf/collision-world.glb`, (p) => {
      loadProgress = Math.round(p * 100);
    }).then(() => {
      loading = false;
    }).catch((err: unknown) => {
      console.error('FPS map load failed:', err);
      loading = false;
    });

    // レンダーループ
    renderer.setAnimationLoop(() => {
      if (!mounted || !renderer || !scene || !camera || !clock) return;
      const delta = Math.min(0.05, clock.getDelta());

      if (pointerLocked && !loading) {
        player.update(delta, world.octree, camera, input);
        spheres.update(delta, world.octree, player.collider);
        input.jump = false;
      }

      // カメラ位置をカプセル上端に同期
      camera.position.copy(player.collider.end);

      renderer.render(scene, camera);
    });

    // cleanup 関数を登録
    (canvas as HTMLCanvasElement & { _fpsDismount?: () => void })._fpsDismount = () => {
      renderer!.setAnimationLoop(null);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      resizeObserver.disconnect();
      if (scene) spheres.dispose(scene);
      if (scene) world.dispose(scene);
      renderer!.dispose();
    };
  }

  function cleanup() {
    const fn = (canvas as HTMLCanvasElement & { _fpsDismount?: () => void })?._fpsDismount;
    if (fn) fn();
  }

  function goBack() {
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    if (onBack) {
      onBack();
    } else {
      appModeStore.toEditor();
    }
  }
</script>

<div class="fps-wrapper">
  <canvas bind:this={canvas} class="fps-canvas"></canvas>

  <!-- 戻るボタン（常時表示） -->
  <button class="back-btn" on:click={goBack}>← エディタ</button>

  <!-- ローディング -->
  {#if loading}
    <div class="loading-overlay">
      <div class="loading-text">マップ読み込み中... {loadProgress}%</div>
      <div class="loading-bar"><div class="loading-fill" style="width:{loadProgress}%"></div></div>
    </div>
  {:else if !pointerLocked}
    <!-- PointerLock 未取得（ポーズ） -->
    <div class="pause-overlay">
      <div class="pause-box">
        <p class="pause-title">クリックで開始</p>
        <p class="pause-hint">WASD: 移動 &nbsp; Space: ジャンプ &nbsp; マウス: 視点 &nbsp; クリック: 投擲</p>
      </div>
    </div>
  {:else}
    <!-- 照準 -->
    <div class="crosshair">
      <div class="ch-h"></div>
      <div class="ch-v"></div>
    </div>
  {/if}
</div>

<style>
  .fps-wrapper {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }
  .fps-canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .back-btn {
    position: absolute;
    top: 12px;
    left: 12px;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.3);
    color: #fff;
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
    z-index: 10;
  }
  .back-btn:hover { background: rgba(0,0,0,0.75); }

  .loading-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.7);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #fff;
    gap: 16px;
    z-index: 20;
  }
  .loading-text { font-size: 18px; }
  .loading-bar {
    width: 300px;
    height: 6px;
    background: rgba(255,255,255,0.2);
    border-radius: 3px;
    overflow: hidden;
  }
  .loading-fill {
    height: 100%;
    background: #4af;
    border-radius: 3px;
    transition: width 0.2s;
  }

  .pause-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.45);
    z-index: 10;
    pointer-events: none;
  }
  .pause-box {
    background: rgba(0,0,0,0.7);
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 8px;
    padding: 24px 40px;
    text-align: center;
    color: #fff;
  }
  .pause-title { font-size: 22px; margin: 0 0 8px; }
  .pause-hint { font-size: 13px; color: #aaa; margin: 0; }

  .crosshair {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 10;
  }
  .ch-h {
    width: 16px;
    height: 2px;
    background: rgba(255,255,255,0.8);
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
  .ch-v {
    width: 2px;
    height: 16px;
    background: rgba(255,255,255,0.8);
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }
</style>
