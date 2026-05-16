import type { VRM } from '@pixiv/three-vrm';
import type { VRMSpringBoneJoint } from '@pixiv/three-vrm';

export class SpringBoneController {
  private _vrm: VRM | null = null;
  private _enabled = true;
  // 元のパラメータを保存（reset 用）
  private _originalParams: Map<VRMSpringBoneJoint, { stiffness: number; damping: number }> =
    new Map();

  setVRM(vrm: VRM): void {
    this._vrm = vrm;
    this._originalParams.clear();
    this._saveOriginalParams();
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** hasSpringBone: SpringBoneManager が存在するかどうか */
  get hasSpringBone(): boolean {
    return !!this._vrm?.springBoneManager;
  }

  setStiffness(value: number): void {
    const joints = this._getJoints();
    for (const joint of joints) {
      joint.settings.stiffness = value;
    }
  }

  setDamping(value: number): void {
    const joints = this._getJoints();
    for (const joint of joints) {
      joint.settings.dragForce = value;
    }
  }

  reset(): void {
    const joints = this._getJoints();
    for (const joint of joints) {
      const orig = this._originalParams.get(joint);
      if (orig) {
        joint.settings.stiffness = orig.stiffness;
        joint.settings.dragForce = orig.damping;
      }
    }
  }

  update(delta: number): void {
    if (!this._enabled || !this._vrm?.springBoneManager) return;
    this._vrm.springBoneManager.update(delta);
  }

  private _getJoints(): VRMSpringBoneJoint[] {
    if (!this._vrm?.springBoneManager) return [];
    const joints: VRMSpringBoneJoint[] = [];
    for (const joint of this._vrm.springBoneManager.joints) {
      joints.push(joint);
    }
    return joints;
  }

  private _saveOriginalParams(): void {
    const joints = this._getJoints();
    for (const joint of joints) {
      this._originalParams.set(joint, {
        stiffness: joint.settings.stiffness,
        damping: joint.settings.dragForce,
      });
    }
  }
}
