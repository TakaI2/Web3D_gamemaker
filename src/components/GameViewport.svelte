<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { SceneManager } from '../core/SceneManager';
  import { RenderLoop } from '../core/RenderLoop';
  import { AnimationManager } from '../core/AnimationManager';
  import type { VRMLoader } from '../core/VRMLoader';
  import { createGameSceneSetup } from '../game/GameSceneSetup';
  import { createInputManager } from '../game/InputManager';
  import { createThirdPersonCamera } from '../game/ThirdPersonCamera';
  import { createPlayerController } from '../game/PlayerController';
  import { createEnemyManager } from '../game/EnemyManager';
  import { GAME_CONSTANTS as C } from '../game/constants';
  import { xrStore } from '../stores/xrStore';
  import { gameStore } from '../stores/gameStore';
  import * as THREE from 'three';

  export let vrmLoader: VRMLoader | null;

  let canvas: HTMLCanvasElement;

  onMount(() => {
    const sceneManager = new SceneManager(canvas, {
      fov: C.CAMERA_FOV,
      far: C.CAMERA_FAR,
      showGrid: false,
    });

    const renderLoop = new RenderLoop(sceneManager);
    const gameSceneSetup = createGameSceneSetup();
    const inputManager = createInputManager();
    const thirdPersonCamera = createThirdPersonCamera();
    const playerController = createPlayerController();
    const enemyManager = createEnemyManager();
    const animationManager = new AnimationManager();

    gameSceneSetup.setup(sceneManager.scene);

    // VRM をゲームシーンに追加
    const currentVrm = vrmLoader?.current ?? null;
    if (currentVrm) {
      sceneManager.scene.add(currentVrm.scene);
      playerController.setVRM(currentVrm);
      animationManager.setVRM(currentVrm);
    } else {
      // プレースホルダー（カプセル）
      const geo = new THREE.CapsuleGeometry(0.3, 1.0, 4, 8);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
      const placeholder = new THREE.Mesh(geo, mat);
      sceneManager.scene.add(placeholder);
      playerController.setPlaceholder(placeholder);
    }

    const playerStartPos = playerController.position.clone();

    const gameUpdate = (delta: number): void => {
      const phase = get(gameStore).phase;
      if (phase !== 'playing') return;

      // マウス入力をカメラに反映
      const { x: dx, y: dy } = inputManager.getMouseDelta();
      if (dx !== 0 || dy !== 0) thirdPersonCamera.applyMouseDelta(dx, dy);
      inputManager.consumeMouseDelta();

      // XR 中はスティック入力で移動（左スティック）
      const xrActive = get(xrStore).isActive;
      if (xrActive) {
        const session = sceneManager.renderer.xr.getSession();
        if (session) {
          for (const source of session.inputSources) {
            if (source.handedness === 'left' && source.gamepad) {
              const axes = source.gamepad.axes;
              const stickX = axes[2] ?? 0;
              const stickZ = axes[3] ?? 0;
              // スティック入力を疑似的なキー状態で渡す（threshold: 0.2）
              const threshold = 0.2;
              const fakeInput = {
                isKeyDown: (key: string) => {
                  if (key === 'KeyW') return stickZ < -threshold;
                  if (key === 'KeyS') return stickZ >  threshold;
                  if (key === 'KeyA') return stickX < -threshold;
                  if (key === 'KeyD') return stickX >  threshold;
                  return false;
                },
                getMouseDelta: () => ({ x: 0, y: 0 }),
                consumeMouseDelta: () => {},
                dispose: () => {},
              };
              playerController.update(delta, thirdPersonCamera.yaw, fakeInput);
            }
          }
        }
      } else {
        playerController.update(delta, thirdPersonCamera.yaw, inputManager);
      }

      // エネミー更新・接触判定
      const result = enemyManager.update(delta, playerController.position);
      if (result === 'gameover') {
        gameStore.gameOver();
        return;
      }

      // スコア加算
      gameStore.addTime(delta);

      // VRM アニメーション更新
      animationManager.update(delta);
      if (currentVrm) currentVrm.update(delta);

      // カメラ更新（XR 中はスキップ）
      if (!xrActive) {
        thirdPersonCamera.update(sceneManager.camera, playerController.position);
      }
    };

    renderLoop.addCallback(gameUpdate);
    renderLoop.start();

    // ゲーム開始時にエネミーをスポーンさせる（PLAYING になったら）
    const unsubGame = gameStore.subscribe((state) => {
      if (state.phase === 'playing') {
        // エネミーをリセット・再スポーン
        enemyManager.dispose(sceneManager.scene);
        enemyManager.spawn(sceneManager.scene, playerStartPos);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      sceneManager.resize(canvas.clientWidth, canvas.clientHeight);
    });
    resizeObserver.observe(canvas);

    onDestroy(() => {
      unsubGame();
      resizeObserver.disconnect();
      renderLoop.stop();

      // VRM をゲームシーンから外す（破棄しない）
      if (currentVrm) sceneManager.scene.remove(currentVrm.scene);

      enemyManager.dispose(sceneManager.scene);
      gameSceneSetup.dispose();
      inputManager.dispose();
      playerController.dispose();
      animationManager.update(0);
      sceneManager.dispose();
    });
  });
</script>

<canvas bind:this={canvas} style="width:100%;height:100%;display:block;" />
