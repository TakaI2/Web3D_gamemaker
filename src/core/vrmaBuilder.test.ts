import { describe, it, expect } from 'vitest';
import { buildVrmaBlob, buildVrmaBuffer } from './VrmaBuilder';
import type { VrmaBuildOptions } from './VrmaBuilder';

function minimalOptions(): VrmaBuildOptions {
  return {
    durationSec: 1,
    hipsRestY: 0.9,
    tracks: [
      {
        boneName: 'hips',
        times: new Float32Array([0, 0.5, 1.0]),
        values: new Float32Array([0, 0, 0, 1,  0, 0, 0, 1,  0, 0, 0, 1]),
      },
    ],
  };
}

describe('VrmaBuilder', () => {
  it('VB-01: Blob が生成される', () => {
    const blob = buildVrmaBlob(minimalOptions());
    expect(blob.size).toBeGreaterThan(0);
  });

  it('VB-02: GLB マジックバイト "glTF"', () => {
    const buf = buildVrmaBuffer(minimalOptions());
    const view = new DataView(buf);
    // "glTF" = 0x46546C67 (little endian)
    expect(view.getUint32(0, true)).toBe(0x46546c67);
  });

  it('VB-03: ボーン0本でも有効な GLB を生成する', () => {
    const blob = buildVrmaBlob({ durationSec: 1, hipsRestY: 0, tracks: [] });
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('gltf');
  });

  it('VB-04: blendShapes があれば JSON に expressions が含まれる', () => {
    const options: VrmaBuildOptions = {
      ...minimalOptions(),
      blendShapes: [
        {
          expressionName: 'happy',
          times: new Float32Array([0, 1]),
          values: new Float32Array([0, 1]),
        },
      ],
    };
    const buf = buildVrmaBuffer(options);
    const jsonLen = new DataView(buf).getUint32(12, true);
    const jsonBytes = new Uint8Array(buf, 20, jsonLen);
    const jsonText = new TextDecoder().decode(jsonBytes).trimEnd();
    const json = JSON.parse(jsonText);
    expect(json.extensions?.VRMC_vrm_animation?.expressions?.preset?.happy).toBeDefined();
  });

  it('VB-05: 複数ボーンで samplers/channels がボーン数分生成される', () => {
    const options: VrmaBuildOptions = {
      durationSec: 1,
      hipsRestY: 0,
      tracks: [
        { boneName: 'hips',          times: new Float32Array([0]), values: new Float32Array([0,0,0,1]) },
        { boneName: 'leftUpperArm',  times: new Float32Array([0]), values: new Float32Array([0,0,0,1]) },
        { boneName: 'rightUpperArm', times: new Float32Array([0]), values: new Float32Array([0,0,0,1]) },
      ],
    };
    const buf = buildVrmaBuffer(options);
    const jsonLen = new DataView(buf).getUint32(12, true);
    const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)).trimEnd();
    const json = JSON.parse(jsonText);
    expect(json.animations[0].samplers.length).toBe(3);
    expect(json.animations[0].channels.length).toBe(3);
  });

  it('VB-06: hipsRestY が nodes の translation.y に反映される', () => {
    const buf = buildVrmaBuffer({ ...minimalOptions(), hipsRestY: 1.23 });
    const jsonLen = new DataView(buf).getUint32(12, true);
    const jsonText = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)).trimEnd();
    const json = JSON.parse(jsonText);
    const hipsNode = json.nodes.find((n: { name: string }) => n.name === 'hips');
    expect(hipsNode?.translation?.[1]).toBeCloseTo(1.23, 3);
  });

  it('VB-07: GLB バイナリサイズが4バイトアライン', () => {
    const buf = buildVrmaBuffer(minimalOptions());
    expect(buf.byteLength % 4).toBe(0);
  });
});
