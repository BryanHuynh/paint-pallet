import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateVisionRecipes } from '../../src/main/visionRecipes';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const REQUEST = { images: [PNG, PNG] };
const RECIPE = {
  name: ' Blue cloth ',
  swatches: {
    shadow: { hex: '#14243a', mixNotes: ' 2 parts navy, 1 part black ' },
    midtone: { hex: '#365a92', mixNotes: '2 parts navy, 1 part ultramarine' },
    highlight: { hex: '#86aada', mixNotes: '2 parts ultramarine, 1 part ivory' },
  },
};

type Runner = NonNullable<Parameters<typeof generateVisionRecipes>[1]>;

function withOutput(output: unknown): Runner {
  return async (directory, args) => {
    await fs.writeFile(path.join(directory, args[args.indexOf('--output-last-message') + 1]), JSON.stringify(output));
  };
}

describe('Codex vision recipes', () => {
  it('attaches each reference, runs Codex in an isolated folder, validates output and cleans up', async () => {
    let dir: string | undefined;
    const run = vi.fn<Runner>(async (directory, args) => {
      dir = directory;
      expect(args).toEqual(expect.arrayContaining(['exec', '--ephemeral', '--ignore-user-config', 'read-only', 'shell_tool']));
      expect(args.filter((arg) => arg === '--image')).toHaveLength(2);
      for (const name of ['reference-1.png', 'reference-2.png']) {
        expect(args).toContain(name);
        expect(await fs.readFile(path.join(directory, name), 'base64')).toBe(PNG.split(',')[1]);
      }
      const schema = JSON.parse(await fs.readFile(path.join(directory, args[args.indexOf('--output-schema') + 1]), 'utf8'));
      expect(schema.required).toEqual(['recipes']);
      await withOutput({ recipes: [RECIPE] })(directory, args);
    });
    expect(await generateVisionRecipes(REQUEST, run)).toMatchObject({
      ok: true, recipes: [{ name: 'Blue cloth', swatches: {
        shadow: { hex: '#14243A', mixNotes: '2 parts navy, 1 part black' },
        midtone: { hex: '#365A92' }, highlight: { hex: '#86AADA' },
      } }],
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(fs.stat(dir!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const oversized = Buffer.from(PNG.split(',')[1], 'base64');
  oversized.writeUInt32BE(1025, 16);
  it.each([
    [], Array(5).fill(PNG), Array(2), ['https://example.com/reference.png'],
    ['data:image/png;base64,AAAA'], ['data:image/png;base64,' + oversized.toString('base64')],
  ].map((images) => ({ images })))('rejects an invalid image list before calling Codex %#', async (request) => {
    const run = vi.fn<Runner>();
    expect(await generateVisionRecipes(request, run)).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'ENOENT' }, 'was not found'],
    [{ code: 1, stderr: 'Error: Not logged in' }, 'Sign in'],
    [{ code: 1, stderr: 'HTTP 429' }, 'usage limit'],
    [{ killed: true }, 'took too long'],
    [{ code: 1, stderr: 'unexpected argument' }, 'Update Codex CLI'],
    [{ code: 1, stderr: 'private diagnostic' }, 'could not analyze'],
  ] as const)('handles CLI failures without exposing diagnostics %#', async (error, message) => {
    const run = vi.fn<Runner>().mockRejectedValue(error);
    const result = await generateVisionRecipes(REQUEST, run);
    expect(result).toEqual({ ok: false, message: expect.stringContaining(message) });
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    await expect(fs.stat(run.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {}, { recipes: [] }, { recipes: Array(7).fill(RECIPE) },
    { recipes: [{ ...RECIPE, swatches: { shadow: RECIPE.swatches.shadow } }] },
    { recipes: [{ ...RECIPE, swatches: { ...RECIPE.swatches, shadow: { hex: 'navy', mixNotes: 'navy' } } }] },
    { recipes: [{ ...RECIPE, swatches: { ...RECIPE.swatches, midtone: RECIPE.swatches.highlight } }] },
  ])('rejects an invalid recipe response %#', async (output) => {
    expect(await generateVisionRecipes(REQUEST, withOutput(output))).toEqual({
      ok: false, message: expect.stringContaining('invalid paint recipes'),
    });
  });
});
