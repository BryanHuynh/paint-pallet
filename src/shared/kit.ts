import type { ModelSummary, Vec3 } from './workerProtocol';

export interface PartPose {
  translation: Vec3;
  rotation: [number, number, number, number];
}

export interface PartAddress {
  faceOffset: number;
  batchOffset: number;
}

export const ANCHOR_ADDRESS: PartAddress = { faceOffset: 0, batchOffset: 0 };

export interface KitPart extends PartAddress {
  id: string;
  name: string;
  model: ModelSummary;
  pose: PartPose;
  hidden: boolean;
  staged: boolean;
}

export const IDENTITY_PART_POSE: PartPose = { translation: [0, 0, 0], rotation: [0, 0, 0, 1] };

export interface KitJoint {
  parentId: string;
  childId: string;
  point: Vec3;
  method: 'authored' | 'six-face' | 'manual' | 'nearby';
}

export interface KitPartState extends Partial<PartAddress> {
  id: string;
  name: string;
  sourceName: string;
  pose: PartPose;
  hidden: boolean;
  staged: boolean;
}

export interface KitState {
  parts: KitPartState[];
  joints: KitJoint[];
}

export function nextPartAddress(parts: readonly KitPart[]): PartAddress {
  let faceOffset = 0;
  let batchOffset = 0;
  for (const part of parts) {
    faceOffset = Math.max(faceOffset, part.faceOffset + part.model.triangleCount);
    for (const batch of part.model.batches) {
      batchOffset = Math.max(batchOffset, part.batchOffset + batch.batchIndex + 1);
    }
  }
  return { faceOffset, batchOffset };
}

export function restoreKitAddresses(models: ModelSummary[], kit: KitState): KitPart[] {
  if (models.length !== kit.parts.length) throw new Error('Kit geometry does not match the saved parts.');
  const restored: KitPart[] = [];
  for (const [index, part] of kit.parts.entries()) {
    const address = nextPartAddress(restored);
    restored.push({ ...part, model: models[index],
      faceOffset: part.faceOffset ?? address.faceOffset, batchOffset: part.batchOffset ?? address.batchOffset });
  }
  return restored;
}
