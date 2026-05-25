<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import * as THREE from 'three';
  import { appModeStore } from '../stores/appModeStore';
  import { stageEditorStore } from '../stores/stageEditorStore';
  import { createStageEditorScene } from '../stage-editor/StageEditorScene';
  import { createStageEditorGizmo } from '../stage-editor/StageEditorGizmo';
  import { createMesh, syncUpdate, syncRemove } from '../stage-editor/StageEditorMeshSync';
  import { snapToGrid } from '../stage-editor/snapToGrid';
  import StageEditorToolbar from './StageEditorToolbar.svelte';
  import StageEditorShapePanel from './StageEditorShapePanel.svelte';
  import StageEditorPropsPanel from './StageEditorPropsPanel.svelte';
  import type { StageObjectDef } from '../stage-editor/types';

  let canvas: HTMLCanvasElement;

  // Three.js リソース（onMount 後に有効）
  let editorScene: ReturnType<typeof createStageEditorScene> | null = null;
  let gizmo: ReturnType<typeof createStageEditorGizmo> | null = null;
  const meshMap = new Map<string, THREE.Mesh>();

  // マウスドラッグ距離判定用
  let mouseDownPos = { x: 0, y: 0 };

  // NDC 変換
  function toNDC(event: MouseEvent): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  // スナップ済みグリッド位置を返す
  function getSnappedPos(event: MouseEvent): THREE.Vector3 | null {
    if (!editorScene) return null;
    const { raycaster, groundPlane, camera } = editorScene;
    raycaster.setFromCamera(toNDC(event), camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    const snap = get(stageEditorStore).snapSize;
    return new THREE.Vector3(
      snapToGrid(hit.x, snap),
      0,
      snapToGrid(hit.z, snap),
    );
  }

  // store の objects を meshMap と同期
  function syncMeshMap(objects: StageObjectDef[]): void {
    if (!editorScene) return;
    const { scene } = editorScene;
    const currentIds = new Set(meshMap.keys());
    const newIds = new Set(objects.map((o) => o.id));

    // 削除
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        const mesh = meshMap.get(id)!;
        scene.remove(mesh);
        syncRemove(mesh);
        meshMap.delete(id);
        gizmo?.clearSelection();
      }
    }

    // 追加・更新
    for (const def of objects) {
      if (!meshMap.has(def.id)) {
        const mesh = createMesh(def);
        scene.add(mesh);
        meshMap.set(def.id, mesh);
      } else {
        syncUpdate(def, meshMap.get(def.id)!);
      }
    }
  }

  // store 購読: objects が変わるたびに Three.js シーンを同期
  const unsubObjects = stageEditorStore.subscribe((state) => {
    syncMeshMap(state.objects);

    // 選択ハイライト同期
    if (!gizmo) return;
    const selectedId = state.selectedId;
    if (selectedId) {
      const mesh = meshMap.get(selectedId);
      if (mesh) gizmo.setSelection(mesh);
    } else {
      gizmo.clearSelection();
    }
  });

  onMount(() => {
    editorScene = createStageEditorScene(canvas);
    gizmo = createStageEditorGizmo(editorScene.scene);

    // 既存 store データを反映（画面遷移で戻った時）
    syncMeshMap(get(stageEditorStore).objects);

    // ResizeObserver
    const resizeObserver = new ResizeObserver(() => {
      if (!editorScene) return;
      editorScene.resize(canvas.clientWidth, canvas.clientHeight);
    });
    resizeObserver.observe(canvas);

    // イベント
    const onMouseMove = (e: MouseEvent) => {
      const state = get(stageEditorStore);
      if (state.toolMode !== 'place') {
        gizmo?.hideGhost();
        return;
      }
      const pos = getSnappedPos(e);
      if (pos) gizmo?.showGhost(state.activeShape, pos);
    };

    const onMouseDown = (e: MouseEvent) => {
      mouseDownPos = { x: e.clientX, y: e.clientY };
    };

    const onClick = (e: MouseEvent) => {
      const dx = e.clientX - mouseDownPos.x;
      const dy = e.clientY - mouseDownPos.y;
      if (Math.sqrt(dx * dx + dy * dy) > 4) return; // ドラッグは無視

      const state = get(stageEditorStore);

      if (state.toolMode === 'place') {
        const pos = getSnappedPos(e);
        if (!pos) return;
        stageEditorStore.addObject({
          shape: state.activeShape,
          position: [pos.x, pos.y, pos.z],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          material: {
            color: '#888888',
            roughness: 0.7,
            metalness: 0.0,
            textureDataUrl: null,
          },
        });
      } else {
        // Select モード: Raycaster でオブジェクトヒットテスト
        if (!editorScene) return;
        const { raycaster, camera } = editorScene;
        raycaster.setFromCamera(toNDC(e), camera);
        const meshes = [...meshMap.values()];
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length > 0) {
          const hitMesh = hits[0].object as THREE.Mesh;
          const id = hitMesh.userData['stageId'] as string;
          stageEditorStore.setSelected(id);
        } else {
          stageEditorStore.setSelected(null);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { selectedId } = get(stageEditorStore);
        if (selectedId) stageEditorStore.removeObject(selectedId);
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      resizeObserver.disconnect();
    };
  });

  onDestroy(() => {
    unsubObjects();
    gizmo?.dispose();
    for (const mesh of meshMap.values()) {
      editorScene?.scene.remove(mesh);
      syncRemove(mesh);
    }
    meshMap.clear();
    editorScene?.dispose();
    editorScene = null;
    gizmo = null;
  });

  export function getMeshMap(): Map<string, THREE.Mesh> {
    return meshMap;
  }
</script>

<div class="stage-editor">
  <StageEditorToolbar {getMeshMap} />

  <div class="editor-body">
    <StageEditorShapePanel />

    <canvas bind:this={canvas} class="editor-canvas"></canvas>

    <StageEditorPropsPanel />
  </div>
</div>

<style>
  .stage-editor {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #0f0f1a;
    color: #ccc;
    font-size: 13px;
  }
  .editor-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .editor-canvas {
    flex: 1;
    display: block;
    cursor: crosshair;
  }
</style>
