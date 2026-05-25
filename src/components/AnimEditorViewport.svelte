<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { SceneManager } from '../core/SceneManager';
  import { RenderLoop } from '../core/RenderLoop';
  import { OrbitController } from '../core/OrbitController';
  import { createAnimEditorScene } from '../core/AnimEditorScene';
  import { animEditorStore } from '../stores/animEditorStore';
  import type { VRM } from '@pixiv/three-vrm';
  import type { AnimEditorSceneHandle } from '../core/AnimEditorScene';
  import type { IKTarget } from '../types';

  export let vrm: VRM;
  export let onSceneReady: (scene: AnimEditorSceneHandle) => void = () => {};

  let canvas: HTMLCanvasElement;
  let sceneManager: SceneManager;
  let renderLoop: RenderLoop;
  let orbitController: OrbitController;
  let editorScene: AnimEditorSceneHandle;

  // フレーム進行用
  let playAccum = 0;

  onMount(() => {
    sceneManager = new SceneManager(canvas, { showGrid: true, fov: 30 });
    orbitController = new OrbitController(sceneManager);
    editorScene = createAnimEditorScene(sceneManager, orbitController);
    renderLoop = new RenderLoop(sceneManager);

    editorScene.setVRM(vrm);
    orbitController.fitToObject(vrm.scene);

    renderLoop.addCallback((delta) => {
      const state = $animEditorStore;
      if (state.isPlaying) {
        const fps = state.fps;
        const totalFrames = Math.round(state.durationSec * fps);
        playAccum += delta;
        const framesElapsed = Math.floor(playAccum * fps);
        if (framesElapsed > 0) {
          playAccum -= framesElapsed / fps;
          let nextFrame = state.currentFrame + framesElapsed;
          if (nextFrame >= totalFrames) {
            nextFrame = state.isLooping ? nextFrame % totalFrames : totalFrames;
            if (!state.isLooping) animEditorStore.setPlaying(false);
          }
          animEditorStore.setCurrentFrame(nextFrame);
        }
      }

      editorScene.update(delta);
      editorScene.seekToFrame($animEditorStore.currentFrame);
      orbitController.update();
    });

    renderLoop.start();

    const resizeObserver = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas;
      sceneManager.resize(clientWidth, clientHeight);
    });
    resizeObserver.observe(canvas);

    onSceneReady(editorScene);

    return () => {
      resizeObserver.disconnect();
    };
  });

  onDestroy(() => {
    renderLoop?.stop();
    editorScene?.dispose();
    orbitController?.dispose();
    sceneManager?.dispose();
  });
</script>

<canvas bind:this={canvas} style="width:100%;height:100%;display:block;" />
