import type { KitState } from './kit';
import type { GuideCallout } from './paintingGuide';
import type { ModelOrientation, ModelSummary } from './workerProtocol';
import type { PaintRecipe } from '../renderer/palette/types';

export interface ProjectReference {
  id: string;
  name: string;
  mimeType: string;
}

export interface ProjectLightSource {
  id: string;
  name: string;
  azimuth: number;
  elevation: number;
  intensity: number;
}

export interface ProjectLighting {
  sources: ProjectLightSource[];
  activeSourceId: string | null;
  midtone: number;
  highlight: number;
  castShadowsBetweenParts: boolean;
  applied: boolean;
  manual: boolean;
  appliedLightKey?: string;
}

export function lightingConfigurationKey(
  lighting: Pick<ProjectLighting, 'sources' | 'midtone' | 'highlight' | 'castShadowsBetweenParts'>,
  orientation: ModelOrientation,
  layoutKey?: string,
) {
  const sources = lighting.sources.filter(({ intensity }) => intensity > 0)
    .map(({ azimuth, elevation, intensity }) => [azimuth, elevation, intensity])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return JSON.stringify([sources, lighting.midtone, lighting.highlight, orientation.upright, orientation.front,
    layoutKey ?? null, !layoutKey || lighting.castShadowsBetweenParts]);
}

export interface ProjectState {
  orientation: ModelOrientation;
  recipes: PaintRecipe[];
  activeRecipeId: string | null;
  references: ProjectReference[];
  activeReferenceId: string | null;
  lighting: ProjectLighting;
  edgeManualRecipes?: string[];
  guideCallouts?: GuideCallout[];
  kit?: KitState;
}

export interface ProjectManifest extends ProjectState {
  version: 3;
  sourceName: string;
  sourceExtension: '.stl' | '.obj';
}

export interface ProjectContents {
  state: ProjectState;
  referenceBytes: Uint8Array[];
  paint: Uint32Array;
  toneMask: Uint32Array;
  edgeMask?: Uint32Array;
}

export interface ProjectSaveRequest extends ProjectContents {
  modelId: string;
  kitModelIds?: string[];
  saveAs?: boolean;
}

export interface ProjectFile {
  path: string;
  name: string;
}

export interface OpenedProject extends ProjectContents {
  model: ModelSummary;
  kitModels?: ModelSummary[];
  file?: ProjectFile;
}
