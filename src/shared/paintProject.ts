import type { ModelOrientation, ModelSummary } from './workerProtocol';
import type { PaintRecipe } from '../renderer/palette/types';
import type { ShadowRegion } from '../renderer/paint/shadowPaint';

export interface ProjectReference {
  id: string;
  name: string;
  mimeType: string;
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  azimuth: number;
  elevation: number;
  midtone: number;
  highlight: number;
  applied: boolean;
  manual: boolean;
}

export interface ProjectState {
  orientation: ModelOrientation;
  recipes: PaintRecipe[];
  activeRecipeId: string | null;
  references: ProjectReference[];
  activeReferenceId: string | null;
  regions: ShadowRegion[];
  activeRegionId: string | null;
  snapshots: ProjectSnapshot[];
  activeSnapshotId: string;
}

export interface ProjectManifest extends ProjectState {
  version: 1;
  sourceName: string;
  sourceExtension: '.stl' | '.obj';
}

export interface ProjectContents {
  state: ProjectState;
  referenceBytes: Uint8Array[];
  paint: Uint32Array;
  tones: Uint32Array[];
}

export interface ProjectSaveRequest extends ProjectContents {
  modelId: string;
}

export interface OpenedProject extends ProjectContents {
  model: ModelSummary;
}
