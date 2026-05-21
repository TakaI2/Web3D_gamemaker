/**
 * Mixamo ボーン名 → VRM HumanBoneName マッピング
 * Mixamo は "mixamorig:" or "mixamorig2:" プレフィックスを持つ場合がある
 */
export const MIXAMO_TO_VRM: Record<string, string> = {
  Hips:           'hips',
  Spine:          'spine',
  Spine1:         'chest',
  Spine2:         'upperChest',
  Neck:           'neck',
  Head:           'head',

  LeftEye:        'leftEye',
  RightEye:       'rightEye',

  LeftShoulder:   'leftShoulder',
  LeftArm:        'leftUpperArm',
  LeftForeArm:    'leftLowerArm',
  LeftHand:       'leftHand',

  RightShoulder:  'rightShoulder',
  RightArm:       'rightUpperArm',
  RightForeArm:   'rightLowerArm',
  RightHand:      'rightHand',

  LeftUpLeg:      'leftUpperLeg',
  LeftLeg:        'leftLowerLeg',
  LeftFoot:       'leftFoot',
  LeftToeBase:    'leftToes',

  RightUpLeg:     'rightUpperLeg',
  RightLeg:       'rightLowerLeg',
  RightFoot:      'rightFoot',
  RightToeBase:   'rightToes',

  // 左指
  LeftHandThumb1:  'leftThumbMetacarpal',
  LeftHandThumb2:  'leftThumbProximal',
  LeftHandThumb3:  'leftThumbDistal',
  LeftHandIndex1:  'leftIndexProximal',
  LeftHandIndex2:  'leftIndexIntermediate',
  LeftHandIndex3:  'leftIndexDistal',
  LeftHandMiddle1: 'leftMiddleProximal',
  LeftHandMiddle2: 'leftMiddleIntermediate',
  LeftHandMiddle3: 'leftMiddleDistal',
  LeftHandRing1:   'leftRingProximal',
  LeftHandRing2:   'leftRingIntermediate',
  LeftHandRing3:   'leftRingDistal',
  LeftHandPinky1:  'leftLittleProximal',
  LeftHandPinky2:  'leftLittleIntermediate',
  LeftHandPinky3:  'leftLittleDistal',

  // 右指
  RightHandThumb1:  'rightThumbMetacarpal',
  RightHandThumb2:  'rightThumbProximal',
  RightHandThumb3:  'rightThumbDistal',
  RightHandIndex1:  'rightIndexProximal',
  RightHandIndex2:  'rightIndexIntermediate',
  RightHandIndex3:  'rightIndexDistal',
  RightHandMiddle1: 'rightMiddleProximal',
  RightHandMiddle2: 'rightMiddleIntermediate',
  RightHandMiddle3: 'rightMiddleDistal',
  RightHandRing1:   'rightRingProximal',
  RightHandRing2:   'rightRingIntermediate',
  RightHandRing3:   'rightRingDistal',
  RightHandPinky1:  'rightLittleProximal',
  RightHandPinky2:  'rightLittleIntermediate',
  RightHandPinky3:  'rightLittleDistal',
};

const PREFIXES = ['mixamorig:', 'mixamorig2:', 'mixamorig9:', 'mixamorig', 'mixamorig2', 'mixamorig9'];

/** Mixamo ボーン名（プレフィックス有無を問わず）→ VRM HumanBoneName。未知の場合は null */
export function mixamoBoneToVrm(mixamoName: string): string | null {
  // プレフィックスを除去
  let bare = mixamoName;
  for (const pfx of PREFIXES) {
    if (mixamoName.startsWith(pfx)) {
      bare = mixamoName.slice(pfx.length);
      break;
    }
  }
  return MIXAMO_TO_VRM[bare] ?? null;
}
