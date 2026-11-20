import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { expect, it } from 'vitest';
import { writeBinaryStl } from '../fixtures/stlFixture';

const root = path.resolve(__dirname, '../..');
const built = ['.vite/build/index.cjs', 'native/build/paint_pallet_worker.exe']
  .every((file) => existsSync(path.join(root, file)));

it.skipIf(!built)('saves in place, saves a copy, and reopens recent projects', { timeout: 45000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-e2e-files-'));
  try {
    const model = path.join(temp, 'model.stl');
    const original = path.join(temp, 'Original.paintproject');
    const copy = path.join(temp, 'Copy.paintproject');
    const recovery = path.join(temp, 'Recovery.paintproject');
    const profile = path.join(temp, 'profile');
    writeBinaryStl(model, [{ v1: [-1, -1, 0], v2: [1, -1, 0], v3: [0, 1, 0] }]);

    const app = await electron.launch({ args: [root, '--user-data-dir=' + profile], cwd: root });
    try {
      await app.evaluate(({ dialog }, { model, destinations }) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [model] });
        dialog.showSaveDialog = async () => {
          const filePath = destinations.shift();
          if (!filePath) throw new Error('Unexpected Save dialog');
          return { canceled: false, filePath };
        };
        const replacement = { response: 2, count: 0 };
        Object.assign(globalThis, { replacement });
        dialog.showMessageBox = async () => {
          replacement.count++;
          return { response: replacement.response, checkboxChecked: false };
        };
        dialog.showMessageBoxSync = () => 1;
      }, { model, destinations: [original, copy, recovery] });
      const replacementState = (response?: number) => app.evaluate((_, choice) => {
        const { replacement } = globalThis as typeof globalThis & { replacement: { response: number; count: number } };
        if (choice !== undefined) replacement.response = choice;
        return replacement.count;
      }, response);
      const page = await app.firstWindow();
      await page.getByRole('button', { name: 'Open model', exact: true }).click();
      await page.getByRole('combobox', { name: 'Recipe', exact: true }).waitFor();
      const name = page.getByLabel('Recipe name');
      const showPalette = () => page.getByRole('tab', { name: 'Palette' }).click();
      await showPalette();
      await name.fill('First draft');
      await page.keyboard.press('Control+s');
      await page.getByText('Saved Original.paintproject', { exact: true }).waitFor();
      expect(existsSync(original)).toBe(true);
      const first = await fs.readFile(original);

      await name.fill('Saved in place');
      await page.keyboard.press('Control+s');
      await page.getByText('Saved Original.paintproject', { exact: true }).waitFor();
      expect(await fs.readFile(original)).not.toEqual(first);
      expect(existsSync(copy)).toBe(false);
      await name.fill('Different in the copy');
      await page.keyboard.press('Control+Shift+s');
      await page.getByText('Saved Copy.paintproject', { exact: true }).waitFor();
      expect(existsSync(copy)).toBe(true);

      await page.locator('.project-menu summary').click();
      await page.getByRole('button', { name: 'Original.paintproject', exact: true }).click();
      await page.getByText('Opened Original.paintproject', { exact: true }).waitFor();
      await showPalette();
      expect(await name.inputValue()).toBe('Saved in place');
      expect(JSON.parse(await fs.readFile(path.join(profile, 'recent-projects.json'), 'utf8'))).toEqual([original, copy]);

      await name.fill('Unsaved change');
      await page.locator('.project-menu summary').click();
      await page.getByRole('button', { name: 'Copy.paintproject', exact: true }).click();
      await expect.poll(() => replacementState()).toBe(1);
      expect(await name.inputValue()).toBe('Unsaved change');

      await replacementState(0);
      if (await page.locator('.project-menu').getAttribute('open') === null) {
        await page.locator('.project-menu summary').click();
      }
      await page.getByRole('button', { name: 'Copy.paintproject', exact: true }).click();
      await page.getByText('Opened Copy.paintproject', { exact: true }).waitFor();
      await page.locator('.project-menu summary').click();
      await page.getByRole('button', { name: 'Original.paintproject', exact: true }).click();
      await page.getByText('Opened Original.paintproject', { exact: true }).waitFor();
      await showPalette();
      expect(await name.inputValue()).toBe('Unsaved change');

      await name.fill('Discarded on drop');
      await page.getByRole('tab', { name: 'Model' }).click();
      await replacementState(1);
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'drop-source';
        document.body.append(input);
      });
      await page.locator('#drop-source').setInputFiles(copy);
      await page.evaluate(() => {
        const file = (document.getElementById('drop-source') as HTMLInputElement).files![0];
        const data = new DataTransfer();
        data.items.add(file);
        document.getElementById('viewport-region')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
      });
      await page.getByText('Opened Copy.paintproject', { exact: true }).waitFor();
      await showPalette();
      expect(await name.inputValue()).toBe('Different in the copy');

      const externalContent = Buffer.from('externally changed project');
      await fs.writeFile(copy, externalContent);
      await name.fill('Recovered edit');
      await page.keyboard.press('Control+s');
      await page.getByRole('tab', { name: 'Model' }).click();
      await page.getByRole('alert').filter({ hasText: /changed or was moved/ }).waitFor();
      expect(await fs.readFile(copy)).toEqual(externalContent);
      await page.keyboard.press('Control+Shift+s');
      await page.getByText('Saved Recovery.paintproject', { exact: true }).waitFor();
      expect(existsSync(recovery)).toBe(true);
    } finally {
      await app.close();
    }
  } finally {
    if (/^pp-e2e-files-[a-zA-Z0-9]+$/.test(path.relative(os.tmpdir(), temp))) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
});
