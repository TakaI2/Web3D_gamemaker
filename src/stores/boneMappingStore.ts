import { writable, get } from 'svelte/store';
import { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';
import { skeletonStore } from './skeletonStore';

export type BoneMappingEntry = {
  readonly vrmBoneName: string;
  readonly label: string;
  readonly group: string;
  readonly required: boolean;
  readonly actualBoneName: string | null;
  readonly boneIndex: number | null;
};

type BoneMappingState = {
  readonly entries: BoneMappingEntry[];
};

type BoneDef = { name: string; label: string; required: boolean; group: string };

const BONE_DEFS: BoneDef[] = [
  // 体幹
  { name: 'hips',       label: '腰',     required: true,  group: '体幹' },
  { name: 'spine',      label: '脊椎',   required: true,  group: '体幹' },
  { name: 'chest',      label: '胸',     required: true,  group: '体幹' },
  { name: 'upperChest', label: '上胸',   required: false, group: '体幹' },
  { name: 'neck',       label: '首',     required: true,  group: '体幹' },
  { name: 'head',       label: '頭',     required: true,  group: '体幹' },
  // 顔
  { name: 'leftEye',  label: '左目',   required: false, group: '顔' },
  { name: 'rightEye', label: '右目',   required: false, group: '顔' },
  { name: 'jaw',      label: 'あご',   required: false, group: '顔' },
  // 左腕
  { name: 'leftShoulder',  label: '左肩',   required: false, group: '左腕' },
  { name: 'leftUpperArm',  label: '左上腕', required: true,  group: '左腕' },
  { name: 'leftLowerArm',  label: '左前腕', required: true,  group: '左腕' },
  { name: 'leftHand',      label: '左手首', required: true,  group: '左腕' },
  // 右腕
  { name: 'rightShoulder', label: '右肩',   required: false, group: '右腕' },
  { name: 'rightUpperArm', label: '右上腕', required: true,  group: '右腕' },
  { name: 'rightLowerArm', label: '右前腕', required: true,  group: '右腕' },
  { name: 'rightHand',     label: '右手首', required: true,  group: '右腕' },
  // 左脚
  { name: 'leftUpperLeg', label: '左大腿',   required: true,  group: '左脚' },
  { name: 'leftLowerLeg', label: '左下腿',   required: true,  group: '左脚' },
  { name: 'leftFoot',     label: '左足首',   required: true,  group: '左脚' },
  { name: 'leftToe',      label: '左つま先', required: false, group: '左脚' },
  // 右脚
  { name: 'rightUpperLeg', label: '右大腿',   required: true,  group: '右脚' },
  { name: 'rightLowerLeg', label: '右下腿',   required: true,  group: '右脚' },
  { name: 'rightFoot',     label: '右足首',   required: true,  group: '右脚' },
  { name: 'rightToe',      label: '右つま先', required: false, group: '右脚' },
  // 左指
  { name: 'leftThumbMetacarpal',     label: '左親指MC', required: false, group: '左指' },
  { name: 'leftThumbProximal',       label: '左親指P',  required: false, group: '左指' },
  { name: 'leftThumbDistal',         label: '左親指D',  required: false, group: '左指' },
  { name: 'leftIndexProximal',       label: '左人指P',  required: false, group: '左指' },
  { name: 'leftIndexIntermediate',   label: '左人指I',  required: false, group: '左指' },
  { name: 'leftIndexDistal',         label: '左人指D',  required: false, group: '左指' },
  { name: 'leftMiddleProximal',      label: '左中指P',  required: false, group: '左指' },
  { name: 'leftMiddleIntermediate',  label: '左中指I',  required: false, group: '左指' },
  { name: 'leftMiddleDistal',        label: '左中指D',  required: false, group: '左指' },
  { name: 'leftRingProximal',        label: '左薬指P',  required: false, group: '左指' },
  { name: 'leftRingIntermediate',    label: '左薬指I',  required: false, group: '左指' },
  { name: 'leftRingDistal',          label: '左薬指D',  required: false, group: '左指' },
  { name: 'leftLittleProximal',      label: '左小指P',  required: false, group: '左指' },
  { name: 'leftLittleIntermediate',  label: '左小指I',  required: false, group: '左指' },
  { name: 'leftLittleDistal',        label: '左小指D',  required: false, group: '左指' },
  // 右指
  { name: 'rightThumbMetacarpal',    label: '右親指MC', required: false, group: '右指' },
  { name: 'rightThumbProximal',      label: '右親指P',  required: false, group: '右指' },
  { name: 'rightThumbDistal',        label: '右親指D',  required: false, group: '右指' },
  { name: 'rightIndexProximal',      label: '右人指P',  required: false, group: '右指' },
  { name: 'rightIndexIntermediate',  label: '右人指I',  required: false, group: '右指' },
  { name: 'rightIndexDistal',        label: '右人指D',  required: false, group: '右指' },
  { name: 'rightMiddleProximal',     label: '右中指P',  required: false, group: '右指' },
  { name: 'rightMiddleIntermediate', label: '右中指I',  required: false, group: '右指' },
  { name: 'rightMiddleDistal',       label: '右中指D',  required: false, group: '右指' },
  { name: 'rightRingProximal',       label: '右薬指P',  required: false, group: '右指' },
  { name: 'rightRingIntermediate',   label: '右薬指I',  required: false, group: '右指' },
  { name: 'rightRingDistal',         label: '右薬指D',  required: false, group: '右指' },
  { name: 'rightLittleProximal',     label: '右小指P',  required: false, group: '右指' },
  { name: 'rightLittleIntermediate', label: '右小指I',  required: false, group: '右指' },
  { name: 'rightLittleDistal',       label: '右小指D',  required: false, group: '右指' },
];

const initial: BoneMappingState = { entries: [] };
const { subscribe, set } = writable<BoneMappingState>(initial);

export const boneMappingStore = {
  subscribe,
  load: (vrm: VRM) => {
    const bones = get(skeletonStore).bones;
    const entries: BoneMappingEntry[] = BONE_DEFS.map(({ name, label, required, group }) => {
      const node = vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      if (!node) {
        return { vrmBoneName: name, label, group, required, actualBoneName: null, boneIndex: null };
      }
      const bone = bones.find((b) => b.name === node.name);
      return {
        vrmBoneName: name,
        label,
        group,
        required,
        actualBoneName: node.name,
        boneIndex: bone?.index ?? null,
      };
    });
    set({ entries });
  },
  clear: () => set(initial),
};
