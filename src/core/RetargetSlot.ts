import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
} from '@pixiv/three-vrm-animation';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { SlotModelType, SlotState } from '../types';
import type { SceneManager } from './SceneManager';

const SCALE_STEP = 5;

export type RetargetSlot = {
  readonly state: Readable<SlotState>;
  readonly currentObject: THREE.Object3D | null;
  setModelType(type: SlotModelType): void;
  loadModel(file: File): Promise<THREE.Object3D | null>;
  loadModelFromUrl(url: string, name: string): Promise<THREE.Object3D | null>;
  loadAnim(file: File): Promise<void>;
  loadAnimFromUrl(url: string, name: string): Promise<void>;
  play(name: string): void;
  stop(): void;
  setLoop(loop: boolean): void;
  scaleModel(multiply: boolean): void;
  update(delta: number): void;
  unload(): void;
  dispose(): void;
};

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((mat) => {
        for (const key of Object.keys(mat)) {
          const val = (mat as Record<string, unknown>)[key];
          if (val instanceof THREE.Texture) val.dispose();
        }
        mat.dispose();
      });
    }
  });
}

export function createRetargetSlot(sceneManager: SceneManager): RetargetSlot {
  let modelType: SlotModelType = 'vrm';
  let vrm: VRM | null = null;
  let skinnedMesh: THREE.SkinnedMesh | null = null;
  let fbxRoot: THREE.Group | null = null;
  let mixer: THREE.AnimationMixer | null = null;
  const clips = new Map<string, THREE.AnimationClip>();
  let currentAction: THREE.AnimationAction | null = null;
  let isLooping = true;

  // lazy loaders
  let gltfLoader: GLTFLoader | null = null;
  let mmdLoader: MMDLoader | null = null;
  let fbxLoader: FBXLoader | null = null;

  const getGltfLoader = (): GLTFLoader => {
    if (!gltfLoader) {
      gltfLoader = new GLTFLoader();
      gltfLoader.register((p) => new VRMLoaderPlugin(p));
      gltfLoader.register((p) => new VRMAnimationLoaderPlugin(p));
    }
    return gltfLoader;
  };
  const getMmdLoader = (): MMDLoader => {
    if (!mmdLoader) mmdLoader = new MMDLoader();
    return mmdLoader;
  };
  const getFbxLoader = (): FBXLoader => {
    if (!fbxLoader) fbxLoader = new FBXLoader();
    return fbxLoader;
  };

  const initialState: SlotState = {
    modelType: 'vrm', loaded: false, loading: false, error: null,
    animNames: [], currentAnim: null, isPlaying: false, isLooping: true, scale: 1,
  };
  const { subscribe, update: storeUpd } = writable<SlotState>(initialState);
  const upd = (fn: (s: SlotState) => SlotState) => storeUpd(fn);

  function uniqueName(base: string): string {
    if (!clips.has(base)) return base;
    let i = 1;
    while (clips.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  function clearLoaded(): void {
    if (currentAction) { currentAction.stop(); currentAction = null; }
    if (mixer) { mixer.stopAllAction(); mixer = null; }
    clips.clear();
    if (vrm) {
      sceneManager.scene.remove(vrm.scene);
      disposeObject(vrm.scene);
      vrm = null;
    }
    if (skinnedMesh) {
      sceneManager.scene.remove(skinnedMesh);
      disposeObject(skinnedMesh);
      skinnedMesh = null;
    }
    if (fbxRoot) {
      sceneManager.scene.remove(fbxRoot);
      disposeObject(fbxRoot);
      fbxRoot = null;
    }
  }

  const slot: RetargetSlot = {
    state: { subscribe },

    get currentObject(): THREE.Object3D | null {
      return vrm?.scene ?? skinnedMesh ?? fbxRoot ?? null;
    },

    setModelType(type: SlotModelType): void {
      modelType = type;
      upd((s) => ({ ...s, modelType: type }));
    },

    async loadModel(file: File): Promise<THREE.Object3D | null> {
      upd((s) => ({ ...s, loading: true, error: null }));
      const url = URL.createObjectURL(file);
      try {
        clearLoaded();

        if (modelType === 'vrm') {
          const gltf = await getGltfLoader().loadAsync(url);
          const loaded: VRM = gltf.userData.vrm;
          if (!loaded) throw new Error('VRM データが見つかりません');
          vrm = loaded;
          sceneManager.scene.add(vrm.scene);
          mixer = new THREE.AnimationMixer(vrm.scene);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: [], currentAnim: null, isPlaying: false, scale: 1 }));
          return vrm.scene;

        } else if (modelType === 'mmd') {
          const mesh = await getMmdLoader().loadAsync(url) as THREE.SkinnedMesh;
          skinnedMesh = mesh;
          sceneManager.scene.add(mesh);
          mixer = new THREE.AnimationMixer(mesh);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: [], currentAnim: null, isPlaying: false, scale: 1 }));
          return mesh;

        } else {
          const root = await new Promise<THREE.Group>((resolve, reject) => {
            getFbxLoader().load(url, resolve, undefined, reject);
          });
          fbxRoot = root;
          sceneManager.scene.add(root);
          const names: string[] = [];
          root.animations.forEach((clip, i) => {
            const name = clip.name.trim() || `Clip_${i}`;
            clips.set(name, clip);
            names.push(name);
          });
          mixer = new THREE.AnimationMixer(root);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: names, currentAnim: null, isPlaying: false, scale: 1 }));
          return root;
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : '読み込みに失敗しました';
        upd((s) => ({ ...s, loading: false, error }));
        return null;
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    async loadModelFromUrl(url: string, _name: string): Promise<THREE.Object3D | null> {
      upd((s) => ({ ...s, loading: true, error: null }));
      try {
        clearLoaded();
        if (modelType === 'vrm') {
          const gltf = await getGltfLoader().loadAsync(url);
          const loaded: VRM = gltf.userData.vrm;
          if (!loaded) throw new Error('VRM データが見つかりません');
          vrm = loaded;
          sceneManager.scene.add(vrm.scene);
          mixer = new THREE.AnimationMixer(vrm.scene);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: [], currentAnim: null, isPlaying: false, scale: 1 }));
          return vrm.scene;
        } else if (modelType === 'mmd') {
          const mesh = await getMmdLoader().loadAsync(url) as THREE.SkinnedMesh;
          skinnedMesh = mesh;
          sceneManager.scene.add(mesh);
          mixer = new THREE.AnimationMixer(mesh);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: [], currentAnim: null, isPlaying: false, scale: 1 }));
          return mesh;
        } else {
          const root = await new Promise<THREE.Group>((resolve, reject) => {
            getFbxLoader().load(url, resolve, undefined, reject);
          });
          fbxRoot = root;
          sceneManager.scene.add(root);
          const names: string[] = [];
          root.animations.forEach((clip, i) => {
            const cname = clip.name.trim() || `Clip_${i}`;
            clips.set(cname, clip);
            names.push(cname);
          });
          mixer = new THREE.AnimationMixer(root);
          upd((s) => ({ ...s, loaded: true, loading: false, animNames: names, currentAnim: null, isPlaying: false, scale: 1 }));
          return root;
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : '読み込みに失敗しました';
        upd((s) => ({ ...s, loading: false, error }));
        return null;
      }
    },

    async loadAnim(file: File): Promise<void> {
      const url = URL.createObjectURL(file);
      const baseName = file.name.replace(/\.(vrma|vmd)$/i, '');
      try {
        await slot.loadAnimFromUrl(url, baseName);
      } catch { /* loadAnimFromUrl 内で error をストアに書き込み済み */ } finally {
        URL.revokeObjectURL(url);
      }
    },

    async loadAnimFromUrl(url: string, name: string): Promise<void> {
      try {
        if (modelType === 'vrm' && vrm) {
          const gltf = await getGltfLoader().loadAsync(url);
          const vrmAnim = gltf.userData.vrmAnimations?.[0];
          if (!vrmAnim) throw new Error('VRMA データが見つかりません');
          const clip = createVRMAnimationClip(vrmAnim, vrm);
          const uname = uniqueName(name);
          clips.set(uname, clip);
          upd((s) => ({ ...s, animNames: [...s.animNames, uname] }));
        } else if (modelType === 'mmd' && skinnedMesh) {
          const mesh = skinnedMesh;
          const clip = await new Promise<THREE.AnimationClip>((resolve, reject) => {
            getMmdLoader().loadAnimation(
              url, mesh,
              (obj) => resolve(obj as THREE.AnimationClip),
              undefined,
              (e) => reject(e),
            );
          });
          const uname = uniqueName(name);
          clips.set(uname, clip);
          upd((s) => ({ ...s, animNames: [...s.animNames, uname] }));
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : 'アニメーション読み込み失敗';
        upd((s) => ({ ...s, error }));
      }
    },

    play(name: string): void {
      if (!mixer) return;
      const clip = clips.get(name);
      if (!clip) return;
      if (currentAction) currentAction.stop();
      const action = mixer.clipAction(clip);
      action.setLoop(isLooping ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !isLooping;
      action.reset().play();
      currentAction = action;
      upd((s) => ({ ...s, currentAnim: name, isPlaying: true }));
    },

    stop(): void {
      if (currentAction) { currentAction.stop(); currentAction = null; }
      upd((s) => ({ ...s, currentAnim: null, isPlaying: false }));
    },

    setLoop(loop: boolean): void {
      isLooping = loop;
      if (currentAction) {
        currentAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        currentAction.clampWhenFinished = !loop;
      }
      upd((s) => ({ ...s, isLooping: loop }));
    },

    scaleModel(multiply: boolean): void {
      const obj = vrm?.scene ?? skinnedMesh ?? fbxRoot;
      if (!obj) return;
      obj.scale.multiplyScalar(multiply ? SCALE_STEP : 1 / SCALE_STEP);
      const scale = Math.round(obj.scale.x * 10000) / 10000;
      upd((s) => ({ ...s, scale }));
    },

    update(delta: number): void {
      mixer?.update(delta);
      if (vrm) vrm.update(delta);
    },

    unload(): void {
      clearLoaded();
      upd(() => ({ ...initialState, modelType }));
    },

    dispose(): void {
      clearLoaded();
    },
  };

  return slot;
}
