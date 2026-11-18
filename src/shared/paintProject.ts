import type { KitState } from './kit';
import type { GuideCallout } from './paintingGuide';
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
  appliedLightKey?: string;
  edgeManualRegions?: string[];
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
  guideCallouts?: GuideCallout[];
  kit?: KitState;
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
  edges?: Uint32Array[];
}

export interface ProjectSaveRequest extends ProjectContents {
  modelId: string;
  kitModelIds?: string[];
}

export interface OpenedProject extends ProjectContents {
  model: ModelSummary;
  kitModels?: ModelSummary[];
}
