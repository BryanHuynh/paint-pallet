export const MAX_VISION_REFERENCES = 4;
export const MAX_VISION_IMAGE_DIMENSION = 1024;

export interface VisionRecipeRequest {
  apiKey: string;
  images: string[];
}

interface VisionSwatch {
  hex: string;
  mixNotes: string;
}

export interface VisionRecipe {
  name: string;
  swatches: {
    shadow: VisionSwatch;
    midtone: VisionSwatch;
    highlight: VisionSwatch;
  };
}

export type VisionRecipeResult =
  | { ok: true; recipes: VisionRecipe[] }
  | { ok: false; message: string };
