import type { SwatchEntry, ToneSlot } from '../renderer/palette/types';

export const GUIDE_VIEWS = ['Front', 'Back', 'Left', 'Right'] as const;
export const GUIDE_PASSES = ['shadow', 'midtone', 'highlight'] as const;
export type GuidePass = ToneSlot | 'edge';
export type GuideView = typeof GUIDE_VIEWS[number];
export type GuidePaper = 'Letter' | 'A4';

export interface GuideCallout {
  regionId: string;
  view: GuideView;
  x: number;
  y: number;
}

export interface GuideRow {
  id: string;
  name: string;
  swatches: Record<ToneSlot, SwatchEntry> | null;
  edgeSwatch?: SwatchEntry;
}

export type GuideImages = Record<ToneSlot, string[]> & { edge?: string[] };

export interface GuideDetail {
  regionId: string;
  view: GuideView | 'Top' | 'Bottom';
  image: string;
  x: number;
  y: number;
}

export interface InstallationStepView {
  incoming: string;
  parent: string;
  note: string;
  view: GuideView;
  x: number;
  y: number;
}

export interface GuideExport {
  paper: GuidePaper;
  modelName: string;
  snapshot: string;
  rows: GuideRow[];
  callouts: GuideCallout[];
  details?: Partial<Record<GuidePass, GuideDetail[]>>;
  installationViews?: string[];
  images: GuideImages;
  installation?: InstallationStepView[];
  isolatedSheets?: { partName: string; images: GuideImages }[];
}
