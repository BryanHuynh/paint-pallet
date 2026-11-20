import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const built = ['.vite/build/index.cjs', 'native/build/paint_pallet_worker.exe']
  .every((file) => existsSync(path.join(root, file)));

it.skipIf(!built)('teaches the real practice model, recipe, paint, lighting, and save workflow', { timeout: 45000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-tutorial-'));
  try {
    const destination = path.join(temp, 'Field Robot.paintproject');
    const guide = path.join(temp, 'Field Robot guide.pdf');
    const app = await electron.launch({ args: [root, '--user-data-dir=' + path.join(temp, 'profile')], cwd: root });
    try {
      await app.evaluate(({ dialog }, { destination, guide }) => {
        dialog.showSaveDialog = async (windowOrOptions: Electron.BaseWindow | Electron.SaveDialogOptions,
          options?: Electron.SaveDialogOptions) => ({
          canceled: false,
          filePath: (options ?? windowOrOptions as Electron.SaveDialogOptions).defaultPath?.endsWith('.pdf') ? guide : destination,
        });
        dialog.showMessageBoxSync = () => 1;
      }, { destination, guide });
      const page = await app.firstWindow();
      const illustration = page.getByRole('img', { name: /painted field robot/i });
      await expect.poll(() => illustration.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Start tutorial' }).click();
      const tutorial = page.getByRole('region', { name: 'Model painting tutorial' });
      const next = tutorial.getByRole('button', { name: 'Next' });
      expect(await tutorial.getByRole('button', { name: 'Back' }).isDisabled()).toBe(true);
      await tutorial.getByRole('button', { name: 'Use practice model' }).click();
      await page.getByText('Field Robot.stl', { exact: true }).waitFor();

      await next.click();
      await page.getByRole('button', { name: 'Add recipe', exact: true }).click();
      await page.getByLabel('Recipe name').fill('Robot shell');
      await next.click();
      await page.getByRole('heading', { name: 'Paint the shadow coat' }).waitFor();
      const recipe = page.getByRole('combobox', { name: 'Recipe', exact: true });
      expect(await recipe.locator('option:checked').textContent()).toBe('Robot shell');
      await page.getByRole('button', { name: 'Front view' }).click();
      await page.getByRole('button', { name: 'Fill', exact: true }).click();
      const canvas = page.locator('canvas[data-surface-detail="original"]');
      const viewport = await canvas.boundingBox();
      if (!viewport) throw new Error('Practice viewport is missing.');
      await canvas.click({ position: { x: viewport.width / 2, y: viewport.height / 2 } });
      await expect.poll(async () => (await page.getByLabel('Painted faces').innerText()).trim())
        .toMatch(/^[1-9][\d,]* painted faces$/);

      await next.click();
      const lighting = page.getByRole('region', { name: 'Lighting', exact: true });
      await lighting.getByRole('button', { name: 'Preview lighting' }).click();
      await lighting.getByRole('button', { name: 'Apply lighting', exact: true }).click();
      await next.click();
      await tutorial.getByRole('button', { name: 'Open Project menu' }).click();
      await page.getByRole('button', { name: 'Save project', exact: true }).click();
      await page.getByText('Saved Field Robot.paintproject', { exact: true }).waitFor();
      expect((await fs.stat(destination)).size).toBeGreaterThan(0);
      await tutorial.getByRole('button', { name: 'Open Project menu' }).click();
      await page.getByRole('button', { name: 'Painting guide', exact: true }).click();
      const guideDialog = page.getByRole('dialog', { name: 'Painting guide' });
      await guideDialog.getByRole('button', { name: 'Export PDF' }).click();
      await expect.poll(async () => (await fs.readFile(guide).catch(() => Buffer.alloc(0))).subarray(0, 4).toString()).toBe('%PDF');
      await guideDialog.getByRole('button', { name: 'Close' }).click();
      await tutorial.getByRole('button', { name: 'Finish', exact: true }).click();
      await tutorial.waitFor({ state: 'hidden' });
      const restart = page.getByRole('button', { name: 'Tutorial', exact: true });
      expect(await restart.evaluate((button) => document.activeElement === button)).toBe(true);
      await restart.click();
      await tutorial.getByRole('heading', { name: 'Open a model', exact: true }).waitFor();
      expect(await tutorial.getByRole('button', { name: 'Use practice model' }).count()).toBe(0);
      await tutorial.getByRole('button', { name: 'Exit tutorial' }).click();
      await tutorial.waitFor({ state: 'hidden' });
    } finally {
      await app.close();
    }
  } finally {
    if (/^pp-tutorial-[a-zA-Z0-9]+$/.test(path.relative(os.tmpdir(), temp))) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});
