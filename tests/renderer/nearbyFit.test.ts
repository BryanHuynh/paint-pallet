import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_POSE } from '../../src/shared/kit';
import { solveNearbyFit } from '../../src/renderer/kit/nearbyFit';

const corners = [
  [-1, -1, -1], [1, -1, -1], [0.8, 1, -1], [-0.7, 1, -1],
  [-0.7, -0.8, 1], [0.8, -0.7, 1], [0.6, 0.8, 1], [-0.8, 0.6, 1],
];
const faces = [
  [4, 5, 6, 7], [3, 2, 1, 0], [0, 4, 7, 3], [5, 1, 2, 6], [7, 6, 2, 3], [0, 1, 5, 4],
].flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);
const child = Float32Array.from(faces.flatMap((face) => face.flatMap((id) => corners[id])));
const parent = Float32Array.from(faces.flatMap(([a, b, c]) => [a, c, b].flatMap((id) => corners[id])));

describe('nearby mating surfaces', () => {
  it('returns an irregular socket fit from a shifted pose', () => {
    const fit = solveNearbyFit({
      child, parent, current: { ...IDENTITY_PART_POSE, translation: [0.09, -0.08, 0.05] },
      authored: IDENTITY_PART_POSE, radius: 0.3,
    });
    expect(fit?.support).toBeGreaterThan(15);
    expect(fit?.pose.translation.every((position) => Math.abs(position) < 0.01)).toBe(true);
  });

  it('finds a small rigid correction without a matching authored pose', () => {
    const fit = solveNearbyFit({
      child, parent, current: { ...IDENTITY_PART_POSE, translation: [0.10, -0.02, 0.05], rotation: [0, 0.05, 0, Math.sqrt(1 - 0.05 ** 2)] },
      authored: { ...IDENTITY_PART_POSE, translation: [2, 0, 0] }, radius: 0.35,
    });
    expect(fit?.support).toBeGreaterThan(15);
    expect(fit?.pose.translation.every((position) => Math.abs(position) < 0.014)).toBe(true);
  });

  it('rejects a distant fit and the unconstrained slide of a planar match', () => {
    expect(solveNearbyFit({
      child, parent, current: { ...IDENTITY_PART_POSE, translation: [8, 0, 0] },
      authored: IDENTITY_PART_POSE, radius: 0.3,
    })).toBeNull();
    expect(solveNearbyFit({
      child: child.subarray(0, 18), parent: parent.subarray(0, 18),
      current: IDENTITY_PART_POSE, authored: IDENTITY_PART_POSE, radius: 0.3,
    })).toBeNull();
  });
});
