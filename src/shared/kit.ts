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
  placementConfirmed?: true;
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
  placementConfirmed?: true;
}

export interface InstallationPlan {
  order: string[];
  notes: Record<string, string>;
  isolatedViews: string[];
}

export const EMPTY_INSTALLATION: InstallationPlan = { order: [], notes: {}, isolatedViews: [] };

export function syncInstallation(draft: InstallationPlan, parts: readonly KitPart[], joints: readonly KitJoint[]): InstallationPlan {
  const attachedIds = new Set(joints.map((joint) => joint.childId));
  const order = draft.order.filter((id) => attachedIds.has(id));
  for (const joint of joints) if (!order.includes(joint.childId)) order.push(joint.childId);
  const available = new Set(parts.filter((part) => !part.staged).map((part) => part.id));
  return {
    order,
    notes: Object.fromEntries(Object.entries(draft.notes).filter(([id]) => attachedIds.has(id))),
    isolatedViews: draft.isolatedViews.filter((id) => available.has(id)),
  };
}

export interface KitState {
  parts: KitPartState[];
  joints: KitJoint[];
  installation?: InstallationPlan;
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
