export type ToneSlot = 'shadow' | 'midtone' | 'highlight';

export interface SwatchEntry {
  hex: string;
  brand: string;
  bottleName: string;
  mixNotes: string;
}

export interface PaintRecipe {
  id: string;
  name: string;
  swatches: Record<ToneSlot, SwatchEntry>;
}

export interface ReferenceImage {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  element: HTMLImageElement;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToneSuggestions = Record<ToneSlot, string>;
