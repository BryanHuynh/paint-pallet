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
        regions: [{ id: 'region', name: 'Coat', recipeId: 'coat' }],
        activeRegionId: 'region',
        snapshots: [{ id: 'light', name: 'Light', azimuth: 35, elevation: 50,
          midtone: 35, highlight: 75, applied: false, manual: false }],
        activeSnapshotId: 'light',
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
      tones: [new Uint32Array()],
    }, [child]);

    const app = await electron.launch({ args: [root], cwd: root });
    try {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
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
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
