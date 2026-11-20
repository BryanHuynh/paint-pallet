import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
import { writeProjectArchive } from '../../src/main/projectArchive';
import { IDENTITY_PART_POSE } from '../../src/shared/kit';
import type { OpenedProject } from '../../src/shared/paintProject';
import type { BatchBinaryData } from '../../src/shared/workerProtocol';
import { writeBinaryStl } from '../fixtures/stlFixture';

const root = path.resolve(__dirname, '../..');
const built = ['.vite/build/index.cjs', 'native/build/paint_pallet_worker.exe']
  .every((file) => existsSync(path.join(root, file)));

it.skipIf(!built).each(['normal', 'over budget', 'preview overlaps'])(
  'keeps paint visible on both kit parts (%s)', {
  timeout: 45000,
}, async (scenario) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-e2e-assembly-paint-'));
  try {
    const anchor = path.join(temp, 'anchor.stl');
    const child = path.join(temp, 'child.stl');
    const project = path.join(temp, 'assembly.paintproject');
    for (const file of [anchor, child]) {
      writeBinaryStl(file, [{ v1: [-1, -1, 0], v2: [1, -1, 0], v3: [0, 1, 0] }]);
    }
    const swatch = (hex: string) => ({ hex, brand: '', bottleName: '', mixNotes: '' });
    await writeProjectArchive(project, anchor, 'anchor.stl', {
      state: {
        orientation: { upright: '+Y', front: '+Z' },
        recipes: [
          { id: 'coat', name: 'Coat', swatches: {
            shadow: swatch('#ee2619'), midtone: swatch('#1956ee'), highlight: swatch('#eeeeee'),
          } },
          { id: 'trim', name: 'Trim', swatches: {
            shadow: swatch('#18e845'), midtone: swatch('#69f783'), highlight: swatch('#a5ffbe'),
          } },
        ],
        activeRecipeId: 'coat',
        references: [], activeReferenceId: null,
        lighting: { sources: [{ id: 'light', name: 'Light', azimuth: 35, elevation: 50, intensity: 100 }],
          activeSourceId: 'light', midtone: 35, highlight: 75, castShadowsBetweenParts: true,
          applied: true, manual: true },
        kit: {
          parts: [
            { id: 'anchor', name: 'Anchor', sourceName: 'anchor.stl', pose: IDENTITY_PART_POSE, hidden: false, staged: false },
            { id: 'child', name: 'Child', sourceName: 'child.stl', hidden: false, staged: false, placementConfirmed: true,
              pose: { ...IDENTITY_PART_POSE, translation: [2.5, 0, 0] } },
          ],
          joints: [],
        },
      },
      referenceBytes: [],
      paint: Uint32Array.of(0, 0, 0, 0, 1, 1, 0, 0),
      toneMask: Uint32Array.of(1, 1, 0, 1),
    }, [child]);

    const app = await electron.launch({ args: [root], cwd: root });
    try {
      await app.evaluate(({ dialog, ipcMain }, { file, scenario }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBoxSync = () => 1;
        if (scenario === 'normal') return;

        // Inject a dense descriptor and a simplified surface in front of the
        // original. This reproduces a partial-detail frame without a huge STL.
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Function> })._invokeHandlers;
        const open = handlers.get('project:open')!;
        const read = handlers.get('worker:read-batch')!;
        const preview = 'test:assembly-preview';
        let original = '';
        ipcMain.removeHandler('project:open');
        ipcMain.handle('project:open', async (event) => {
          const opened = await open(event) as OpenedProject;
          const child = opened.kitModels![0];
          const [batch] = child.batches;
          original = batch.filePath;
          child.previewFilePath = preview;
          child.batches = [
            { ...batch, triangleCount: scenario === 'over budget' ? 7_000_001 : batch.triangleCount },
            { ...batch, batchIndex: 1, triangleCount: 15_000_000 },
          ];
          return opened;
        });
        ipcMain.removeHandler('worker:read-batch');
        ipcMain.handle('worker:read-batch', async (event, requested: string) => {
          const data = await read(event, requested === preview ? original : requested) as BatchBinaryData;
          if (requested === preview) {
            for (let i = 0; i < data.positions.length; i += 3) {
              data.positions[i] *= 1.2;
              data.positions[i + 1] *= 1.2;
              data.positions[i + 2] += 0.5;
            }
          }
          return data;
        });
      }, { file: project, scenario });
      const page = await app.firstWindow();
      await page.locator('.project-menu summary').click();
      await page.getByRole('button', { name: 'Open project', exact: true }).click();
      const part = page.getByLabel('Inspect part');
      await part.waitFor();
      await page.getByRole('button', { name: 'Front view', exact: true }).click();
      const canvas = page.locator('canvas[data-surface-detail="original"]');
      async function paintPixels() {
        const shot = await canvas.screenshot({ scale: 'css' });
        return page.evaluate(async (png) => {
          const image = new Image();
          image.src = 'data:image/png;base64,' + png;
          await image.decode();
          const ctx = new OffscreenCanvas(image.width, image.height).getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const { data } = ctx.getImageData(0, 0, image.width, image.height);
          let red = 0;
          let blue = 0;
          let blueX = 0;
          let blueY = 0;
          let green = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] > 200 && data[i + 1] < 70 && data[i + 2] < 70) red++;
            if (data[i] < 70 && data[i + 1] < 120 && data[i + 2] > 200) {
              blue++;
              blueX += (i / 4) % image.width;
              blueY += Math.floor(i / 4 / image.width);
            }
            if (data[i] < 60 && data[i + 1] > 200 && data[i + 2] < 100) green++;
          }
          return { red: red > 100, blue: blue > 100, green: green > 100,
            blueCenter: blue ? { x: blueX / blue, y: blueY / blue } : null };
        }, shot.toString('base64'));
      }
      const visiblePaint = async () => {
        const { red, blue } = await paintPixels();
        return { red, blue };
      };
      await expect.poll(visiblePaint).toEqual({ red: true, blue: true });
      if (scenario !== 'normal') return;
      await part.selectOption('child');
      await expect.poll(() => part.inputValue()).toBe('child');
      await expect.poll(visiblePaint).toEqual({ red: true, blue: true });
      await page.getByRole('button', { name: 'Isolate part', exact: true }).click();
      await expect.poll(visiblePaint).toEqual({ red: false, blue: true });
      await page.getByRole('button', { name: 'Show assembly', exact: true }).click();
      await expect.poll(visiblePaint).toEqual({ red: true, blue: true });

      await part.selectOption('anchor');
      await expect.poll(() => part.inputValue()).toBe('anchor');
      await expect.poll(visiblePaint).toEqual({ red: true, blue: true });
      const position = (await paintPixels()).blueCenter!;
      const shadow = page.getByRole('region', { name: 'Shadow coat' });
      await shadow.getByLabel('Recipe', { exact: true }).selectOption('trim');
      await shadow.getByRole('button', { name: 'Fill', exact: true }).click();
      await shadow.getByRole('checkbox', { name: 'Repaint existing color' }).check();
      await canvas.click({ position });
      await expect.poll(paintPixels).toMatchObject({ red: true, blue: false, green: true });
      expect(await part.inputValue()).toBe('anchor');
      await shadow.getByRole('button', { name: 'Undo stroke' }).click();
      await expect.poll(paintPixels).toMatchObject({ red: true, blue: true, green: false });

      await shadow.getByRole('checkbox', { name: 'Preview before filling' }).check();
      await canvas.click({ position });
      await shadow.getByText('1 face to fill').waitFor();
      await shadow.getByRole('button', { name: 'Apply fill' }).click();
      await expect.poll(paintPixels).toMatchObject({ red: true, blue: false, green: true });

      await page.getByRole('tab', { name: 'Palette' }).click();
      await expect.poll(() => page.getByRole('button', { name: 'Trim', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await page.getByRole('button', { name: 'Delete recipe' }).isDisabled()).toBe(true);
      await page.getByLabel('Shadow hex').fill('#1956EE');
      await page.getByRole('tab', { name: 'Model' }).click();
      await expect.poll(paintPixels).toMatchObject({ red: true, blue: true, green: false });
    } finally {
      await app.close();
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
