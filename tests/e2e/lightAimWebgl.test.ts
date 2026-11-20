import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
import { writeProjectArchive } from '../../src/main/projectArchive';
import { IDENTITY_PART_POSE } from '../../src/shared/kit';
import { writeBinaryStl } from '../fixtures/stlFixture';

const root = path.resolve(__dirname, '../..');
const built = ['.vite/build/index.cjs', 'native/build/paint_pallet_worker.exe']
  .every((file) => existsSync(path.join(root, file)));

it.skipIf(!built)('aims the actual kit lighting with the ball and the current view without orbiting on the handle', {
  timeout: 45000,
}, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-e2e-light-'));
  try {
    const anchor = path.join(tmp, 'anchor.stl');
    const child = path.join(tmp, 'child.stl');
    const project = path.join(tmp, 'kit.paintproject');
    const face = { v1: [-1, -1, 0], v2: [1, -1, 0], v3: [0, 1, 0] } as const;
    for (const file of [anchor, child]) {
      writeBinaryStl(file, [{ v1: [...face.v1], v2: [...face.v2], v3: [...face.v3] }]);
    }
    const swatch = (hex: string) => ({ hex, brand: '', bottleName: '', mixNotes: '' });
    await writeProjectArchive(project, anchor, 'anchor.stl', {
      state: {
        // The posed child has normal +X in kit coordinates and +Z in the viewport.
        orientation: { upright: '+Y', front: '+X' },
        recipes: [{ id: 'coat', name: 'Coat', swatches: {
          shadow: swatch('#325487'), midtone: swatch('#b11023'), highlight: swatch('#eed8c3'),
        } }],
        activeRecipeId: 'coat',
        references: [], activeReferenceId: null,
        lighting: { sources: [{ id: 'light', name: 'Light', azimuth: 35, elevation: 50, intensity: 100 }],
          activeSourceId: 'light', midtone: 35, highlight: 75, castShadowsBetweenParts: true,
          applied: false, manual: false },
        kit: {
          parts: [
            { id: 'anchor', name: 'Anchor', sourceName: 'anchor.stl', pose: IDENTITY_PART_POSE, hidden: false, staged: false },
            { id: 'child', name: 'Child', sourceName: 'child.stl', hidden: false, staged: false, placementConfirmed: true,
              pose: { translation: [0, 0, 1.5], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } },
          ],
          joints: [],
        },
      },
      referenceBytes: [],
      paint: Uint32Array.of(0, 0, 0, 0, 1, 1, 0, 0),
      toneMask: new Uint32Array(),
    }, [child]);

    const app = await electron.launch({ args: [root], cwd: root });
    try {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBoxSync = () => 1;
      }, project);
      const page = await app.firstWindow();
      page.setDefaultTimeout(10000);
      await page.locator('.project-menu summary').click();
      await page.getByRole('button', { name: 'Open project', exact: true }).click();
      const part = page.getByLabel('Inspect part');
      await part.selectOption('child');
      await expect.poll(() => part.inputValue()).toBe('child');
      await page.getByRole('button', { name: 'Front view', exact: true }).click();
      await page.getByRole('button', { name: 'Fit selected part', exact: true }).click();
      const aimFromView = page.getByRole('button', { name: 'Aim from current view' });
      await aimFromView.click();

      const handle = page.getByRole('button', { name: 'Light direction handle' });
      await handle.waitFor();
      const viewport = await page.locator('[data-testid="viewport-canvas"] canvas').boundingBox();
      const ball = await handle.boundingBox();
      if (!ball || !viewport) throw new Error('The light handle or viewport is missing.');
      const ballX = ball.x + ball.width / 2;
      const ballY = ball.y + ball.height / 2;
      // The translated child is centered by Fit selected part.
      expect(ballX).toBeCloseTo(viewport.x + viewport.width / 2, 0);
      expect(ballY).toBeCloseTo(viewport.y + viewport.height / 2, 0);
      await page.getByText('1 midtone faces, including 1 highlights.').waitFor();
      await page.getByText('Light angles', { exact: true }).click();
      const angles = async () => [
        Number(await page.getByLabel('Azimuth').inputValue()),
        Number(await page.getByLabel('Elevation').inputValue()),
      ];
      expect(await angles()).toEqual([0, 0]);

      // A click and a cancelled capture must leave the light available to drag.
      await page.mouse.click(ballX, ballY);
      expect(await angles()).toEqual([0, 0]);
      await page.mouse.move(ballX, ballY);
      await page.mouse.down();
      await handle.dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up();
      expect(await angles()).toEqual([0, 0]);

      await page.mouse.move(ballX, ballY);
      await page.mouse.down();
      await page.mouse.move(ballX, ballY - viewport.height * .25, { steps: 8 });
      await page.mouse.wheel(0, 400);
      await page.mouse.up();
      expect(await angles()).toEqual([0, 45]);
      await page.getByText('1 midtone faces, including 0 highlights.').waitFor();

      const histogram = page.getByRole('img', { name: 'Distribution of light exposure on painted faces' });
      await histogram.waitFor();
      const highlightCutoff = page.getByRole('slider', { name: 'Highlight cutoff' });
      async function swatchPixels(rgb: [number, number, number]) {
        const shot = await page.locator('[data-testid="viewport-canvas"] canvas').screenshot({ scale: 'css' });
        return page.evaluate(async ({ png, rgb: [red, green, blue] }) => {
          const image = new Image();
          image.src = 'data:image/png;base64,' + png;
          await image.decode();
          const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!;
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, image.width, image.height);
          let count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] === red && data[i + 1] === green && data[i + 2] === blue) count++;
          }
          return count;
        }, { png: shot.toString('base64'), rgb });
      }
      const highlightPixels = () => swatchPixels([238, 216, 195]);
      const basePaintPixels = () => swatchPixels([50, 84, 135]);
      const showLighting = page.getByRole('checkbox', { name: 'Show lighting' });
      expect(await highlightPixels()).toBe(0);
      await highlightCutoff.scrollIntoViewIfNeeded();
      const track = await highlightCutoff.boundingBox();
      if (!track) throw new Error('Lighting levels track is missing.');
      const trackX = (fraction: number) => track.x + 7 + (track.width - 14) * fraction;
      await page.mouse.move(trackX(0.75), track.y + track.height / 2);
      await page.mouse.down();
      await page.mouse.move(trackX(0.65), track.y + track.height / 2, { steps: 5 });
      await page.mouse.up();
      expect(Number(await highlightCutoff.inputValue())).toBeLessThanOrEqual(66);
      await page.getByText('1 midtone faces, including 1 highlights.').waitFor();
      await expect.poll(highlightPixels).toBeGreaterThan(100);
      expect(await showLighting.isChecked()).toBe(true);
      await showLighting.uncheck();
      await handle.waitFor({ state: 'hidden' });
      await expect.poll(highlightPixels).toBe(0);
      await expect.poll(basePaintPixels).toBeGreaterThan(100);
      await showLighting.check();
      await handle.waitFor();
      await expect.poll(highlightPixels).toBeGreaterThan(100);
      await page.getByLabel('Highlights start percent').fill('75');
      expect(await highlightCutoff.inputValue()).toBe('75');
      await page.getByText('1 midtone faces, including 0 highlights.').waitFor();
      const castShadows = page.getByRole('checkbox', { name: 'Shadows from other parts' });
      expect(await castShadows.isChecked()).toBe(true);
      await castShadows.uncheck();
      await page.getByText('1 midtone faces, including 0 highlights.').waitFor();

      await aimFromView.click();
      await page.getByText('1 midtone faces, including 1 highlights.').waitFor();
      expect(await angles()).toEqual([0, 0]);
      const resetBall = await handle.boundingBox();
      expect(resetBall).toEqual(ball);

      const x = viewport.x + viewport.width * .2;
      const y = viewport.y + viewport.height * .7;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - viewport.height * .13, y, { steps: 8 });
      await page.mouse.up();
      await page.locator('canvas[data-surface-detail="original"]').waitFor();
      expect(await angles()).toEqual([0, 0]);
      await expect.poll(async () => {
        await aimFromView.click();
        return (await angles())[0];
      }).toBeGreaterThan(44);
      await page.getByText('1 midtone faces, including 0 highlights.').waitFor();
      const [azimuth, elevation] = await angles();
      expect(azimuth).toBeLessThan(49);
      expect(elevation).toBe(0);

      const orbitedBall = await handle.boundingBox();
      if (!orbitedBall) throw new Error('The light handle is missing after orbit.');
      const orbitedX = orbitedBall.x + orbitedBall.width / 2;
      const orbitedY = orbitedBall.y + orbitedBall.height / 2;
      await page.mouse.move(orbitedX, orbitedY);
      await page.mouse.down();
      await page.mouse.move(orbitedX + viewport.height * .15, orbitedY, { steps: 5 });
      await page.mouse.up();
      expect((await angles())[0]).toBeCloseTo(azimuth + 27, 0);
      await page.getByText('0 midtone faces, including 0 highlights.').waitFor();

      await handle.focus();
      await page.keyboard.press('ArrowUp');
      expect((await angles())[1]).toBe(3);
      await page.getByRole('button', { name: 'Finish aiming' }).click();
      await handle.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Add light', exact: true }).click();
      await page.getByRole('option', { name: 'Light 2 · 30%' }).waitFor({ state: 'attached' });
      await page.getByLabel('Light name').fill('Fill light');
      await page.getByRole('option', { name: 'Fill light · 30%' }).waitFor({ state: 'attached' });
      await page.getByLabel('Light source', { exact: true }).selectOption('light');
      await page.getByRole('button', { name: 'Front view', exact: true }).click();
      await page.getByRole('button', { name: 'Fit selected part', exact: true }).click();
      await aimFromView.click();
      await expect.poll(highlightPixels).toBeGreaterThan(100);
      await page.getByRole('button', { name: 'Apply lighting', exact: true }).click();
      await showLighting.uncheck();
      await expect.poll(highlightPixels).toBe(0);
      await expect.poll(basePaintPixels).toBeGreaterThan(100);
      await showLighting.check();
      await expect.poll(highlightPixels).toBeGreaterThan(100);
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
