import type { ModelSummary, Vec3 } from './workerProtocol';

export interface PartPose {
  translation: Vec3;
  rotation: [number, number, number, number];
}

export interface KitPart {
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

export interface KitPartState {
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
