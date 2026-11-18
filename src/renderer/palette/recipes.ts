import type { PaintRecipe } from './types';

export function createEmptyRecipe(index: number): PaintRecipe {
  return {
    id: `recipe-${index}`,
    name: `Recipe ${index}`,
    swatches: {
      shadow: { hex: '#2B303A', brand: '', bottleName: '', mixNotes: '' },
      midtone: { hex: '#6B7280', brand: '', bottleName: '', mixNotes: '' },
      highlight: { hex: '#D1D5DB', brand: '', bottleName: '', mixNotes: '' },
    },
  };
}
