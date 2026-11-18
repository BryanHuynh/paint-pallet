import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { IDENTITY_PART_POSE, type KitJoint, type KitPart } from '../../src/shared/kit';
import type { ModelSummary } from '../../src/shared/workerProtocol';
import { canAttach, fitSixFaces, moveKitPart, poseMatrix, type PlanePick } from '../../src/renderer/kit/jointMath';

const peg: [PlanePick, PlanePick, PlanePick] = [
  { point: [0, 0, 1], normal: [0, 0, 1] },
  { point: [2, 0, 0], normal: [1, 0, 0] },
  { point: [0, 3, 0], normal: [0, 1, 0] },
];
const socket: [PlanePick, PlanePick, PlanePick] = [
  { point: [9, 10, 11], normal: [0, 0, -1] },
  { point: [6, 12, 12], normal: [0, -1, 0] },
  { point: [3, 10, 12], normal: [1, 0, 0] },
];

describe('kit joints', () => {
  it('fits corresponding planes with a proper rotation and supports independent clearances', () => {
    const pose = fitSixFaces(peg, socket, IDENTITY_PART_POSE, [0.4, -0.2, 0.1]);
    expect(pose.point).toEqual([3, 12, 11]);
    expect(poseMatrix(pose.pose).determinant()).toBeCloseTo(1);
    const offset = [0.4, -0.2, 0.1];
    for (const [index, source] of peg.entries()) {
      const target = socket[index];
      const normal = new Vector3(...target.normal);
      const transform = poseMatrix(pose.pose);
      expect(new Vector3(...source.normal).transformDirection(transform).dot(normal)).toBeCloseTo(-1);
      const signedGap = new Vector3(...source.point).applyMatrix4(transform).sub(new Vector3(...target.point)).dot(normal);
      expect(signedGap).toBeCloseTo(offset[index]);
    }
  });

  it('rejects repeated planes and mirrored connectors', () => {
    expect(() => fitSixFaces([peg[0], peg[1], peg[1]], socket, IDENTITY_PART_POSE)).toThrow(/adjacent walls/);
    const mirrored = [socket[0], socket[1], { ...socket[2], normal: [-1, 0, 0] }] as typeof socket;
    expect(() => fitSixFaces(peg, mirrored, IDENTITY_PART_POSE)).toThrow(/face directions/);
  });

  it('keeps the anchor fixed, moves all descendants and rejects attachment cycles', () => {
    const part = (id: string, x: number): KitPart => ({
      id, name: id, model: {} as ModelSummary, pose: { ...IDENTITY_PART_POSE, translation: [x, 0, 0] }, hidden: false, staged: false,
    });
    const parts = [part('anchor', 0), part('body', 1), part('coat', 2), part('trim', 4)];
    const joint = (parentId: string, childId: string): KitJoint => ({ parentId, childId, point: [0, 0, 0], method: 'authored' });
    const joints = [joint('anchor', 'body'), joint('body', 'coat'), joint('coat', 'trim')];
    expect(canAttach(parts, joints, 'body', 'trim')).toBe(false);
    expect(canAttach(parts, joints, 'trim', 'anchor')).toBe(true);
    const moved = moveKitPart(parts, joints, 'body', { ...IDENTITY_PART_POSE, translation: [10, 0, 0] });
    expect(moved.map(({ pose }) => pose.translation[0])).toEqual([0, 10, 11, 13]);
    expect(moveKitPart(parts, joints, 'anchor', moved[1].pose)).toBe(parts);
  });
});
