import type { SwatchEntry, ToneSlot } from '../renderer/palette/types';

export const GUIDE_VIEWS = ['Front', 'Back', 'Left', 'Right'] as const;
export const GUIDE_PASSES = ['shadow', 'midtone', 'highlight'] as const;
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
}

export interface GuideExport {
  paper: GuidePaper;
  modelName: string;
  snapshot: string;
  rows: GuideRow[];
  callouts: GuideCallout[];
  images: Record<ToneSlot, string[]>;
}
