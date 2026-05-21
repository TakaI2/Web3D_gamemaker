import * as THREE from 'three';
import { skeletonStore } from '../stores/skeletonStore';

export class SkeletonController {
  private _helper: THREE.SkeletonHelper | null = null;
  private _highlightMesh: THREE.Mesh | null = null;
  private _bones: THREE.Bone[] = [];
  private _selectedBoneIndex: number | null = null;
  private _scene: THREE.Scene;
  private _visible: boolean = false;

  constructor(scene: THREE.Scene) {
    this._scene = scene;
    this._highlightMesh = this._createHighlight();
    this._scene.add(this._highlightMesh);
  }

  private _createHighlight(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(0.025, 8, 8);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffaa00,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 999;
    return mesh;
  }

  setTarget(object: THREE.Object3D | null): void {
    this._removeHelper();
    this._selectedBoneIndex = null;
    if (!object) {
      this._bones = [];
      skeletonStore.setBones([]);
      return;
    }
    this._helper = new THREE.SkeletonHelper(object);
    this._helper.visible = this._visible;
    this._scene.add(this._helper);

    this._bones = this._helper.bones;
    const bones = this._bones.map((bone, index) => ({ index, name: bone.name }));
    skeletonStore.setBones(bones);
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    if (this._helper) this._helper.visible = visible;
    skeletonStore.setVisible(visible);
  }

  selectBone(index: number | null): void {
    this._selectedBoneIndex = index;
    skeletonStore.selectBone(index);
    if (!this._highlightMesh) return;
    if (index === null || !this._bones[index]) {
      this._highlightMesh.visible = false;
      return;
    }
    this._highlightMesh.visible = true;
    this._bones[index].getWorldPosition(this._highlightMesh.position);
  }

  /** レンダーループから毎フレーム呼ぶ — アニメ中もハイライトがボーンに追従する */
  update(): void {
    if (
      this._selectedBoneIndex === null ||
      !this._highlightMesh?.visible ||
      !this._bones[this._selectedBoneIndex]
    ) return;
    this._bones[this._selectedBoneIndex].getWorldPosition(this._highlightMesh.position);
  }

  private _removeHelper(): void {
    if (this._highlightMesh) this._highlightMesh.visible = false;
    if (!this._helper) return;
    this._scene.remove(this._helper);
    this._helper.dispose();
    this._helper = null;
  }

  dispose(): void {
    this._removeHelper();
    if (this._highlightMesh) {
      this._scene.remove(this._highlightMesh);
      (this._highlightMesh.geometry as THREE.SphereGeometry).dispose();
      (this._highlightMesh.material as THREE.MeshBasicMaterial).dispose();
      this._highlightMesh = null;
    }
  }
}
