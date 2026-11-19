import { describe, expect, it } from 'vitest';
import { generateReferenceRecipes } from '../../src/renderer/palette/referenceRecipes';

function colors(width: number, height: number, pick: (x: number, y: number) => number[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pick(x, y), (y * width + x) * 4);
  }
  return { data, width, height } as ImageData;
}

describe('reference recipe generation', () => {
  it('learns editable three-tone color groups across references and suppresses a uniform border', () => {
    const red = colors(20, 20, (x, y) => x >= 3 && x <= 16 && y >= 3 && y <= 16
      ? [173, 48, 50, 255] : [255, 255, 255, 255]);
    const blue = colors(15, 15, () => [45, 84, 138, 255]);
    const recipes = generateReferenceRecipes([red, blue]);

    expect(recipes.map((recipe) => recipe.name).sort()).toEqual(['Blue', 'Red']);
    expect(recipes.find((recipe) => recipe.name === 'Red')?.tones.midtone).toBe('#AD3032');
    for (const { tones } of recipes) expect(new Set(Object.values(tones)).size).toBe(3);
  });

  it('returns no recipes for completely transparent references', () => {
    expect(generateReferenceRecipes([colors(12, 12, () => [80, 90, 100, 0])])).toEqual([]);
  });
});
