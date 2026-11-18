import type { ProjectState } from '../../shared/paintProject';

export interface PreparedPaletteProject {
  apply: () => void;
  dispose: () => void;
}

export interface PaletteProjectHandle {
  exportProject: () => Promise<{
    state: Pick<ProjectState, 'references' | 'activeReferenceId' | 'activeRecipeId'>;
    referenceBytes: Uint8Array[];
  }>;
  prepareProject: (state: ProjectState, bytes: Uint8Array[]) => Promise<PreparedPaletteProject>;
}
