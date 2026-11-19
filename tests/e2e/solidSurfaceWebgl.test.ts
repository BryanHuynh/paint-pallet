import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(WORKSPACE_ROOT, '.vite/build/index.cjs');
const WORKER_BIN = path.join(WORKSPACE_ROOT, 'native/build/paint_pallet_worker.exe');

/**
 * Generates an upright (+Y) miniature-like binary STL with 7 dense boxes
 * (base, left leg, right leg, torso, left arm, right arm, head) totaling
 * 1,299,600 triangles so it exceeds both preview (180k) and initial batch (16) budgets.
 */
function generateDenseUprightFigureStl(outPath: string): number {
  const boxes = [
    { min: [-45, -90, -30], max: [45, -75, 30], segA: 130, segB: 130 }, // Base
    { min: [-28, -75, -12], max: [-6, -15, 12], segA: 120, segB: 130 }, // Left leg
    { min: [6, -75, -12], max: [28, -15, 12], segA: 120, segB: 130 },  // Right leg
    { min: [-26, -15, -15], max: [26, 45, 15], segA: 130, segB: 130 },  // Torso
    { min: [-48, 0, -10], max: [-28, 40, 10], segA: 110, segB: 120 },   // Left arm
    { min: [28, 0, -10], max: [48, 40, 10], segA: 110, segB: 120 },     // Right arm
    { min: [-16, 48, -16], max: [16, 85, 16], segA: 130, segB: 130 },   // Head
  ];

  let totalTris = 0;
  for (const b of boxes) {
    totalTris += 6 * b.segA * b.segB * 2;
  }

  const buf = Buffer.alloc(84 + totalTris * 50);
  buf.write('Dense Upright Figure Fixture', 0, 'ascii');
  buf.writeUInt32LE(totalTris, 80);

  let off = 84;
  const writeTri = (
    v1: [number, number, number],
    v2: [number, number, number],
    v3: [number, number, number],
    n: [number, number, number],
  ) => {
    buf.writeFloatLE(n[0], off);
    buf.writeFloatLE(n[1], off + 4);
    buf.writeFloatLE(n[2], off + 8);
    buf.writeFloatLE(v1[0], off + 12);
    buf.writeFloatLE(v1[1], off + 16);
    buf.writeFloatLE(v1[2], off + 20);
    buf.writeFloatLE(v2[0], off + 24);
    buf.writeFloatLE(v2[1], off + 28);
    buf.writeFloatLE(v2[2], off + 32);
    buf.writeFloatLE(v3[0], off + 36);
    buf.writeFloatLE(v3[1], off + 40);
    buf.writeFloatLE(v3[2], off + 44);
    buf.writeUInt16LE(0, off + 48);
    off += 50;
  };

  const emitQuadGrid = (
    origin: [number, number, number],
    uVec: [number, number, number],
    vVec: [number, number, number],
    normal: [number, number, number],
    nu: number,
    nv: number,
  ) => {
    for (let i = 0; i < nu; i++) {
      const u0 = i / nu;
      const u1 = (i + 1) / nu;
      for (let j = 0; j < nv; j++) {
        const v0 = j / nv;
        const v1 = (j + 1) / nv;
        const p00: [number, number, number] = [
          origin[0] + uVec[0] * u0 + vVec[0] * v0,
          origin[1] + uVec[1] * u0 + vVec[1] * v0,
          origin[2] + uVec[2] * u0 + vVec[2] * v0,
        ];
        const p10: [number, number, number] = [
          origin[0] + uVec[0] * u1 + vVec[0] * v0,
          origin[1] + uVec[1] * u1 + vVec[1] * v0,
          origin[2] + uVec[2] * u1 + vVec[2] * v0,
        ];
        const p11: [number, number, number] = [
          origin[0] + uVec[0] * u1 + vVec[0] * v1,
          origin[1] + uVec[1] * u1 + vVec[1] * v1,
          origin[2] + uVec[2] * u1 + vVec[2] * v1,
        ];
        const p01: [number, number, number] = [
          origin[0] + uVec[0] * u0 + vVec[0] * v1,
          origin[1] + uVec[1] * u0 + vVec[1] * v1,
          origin[2] + uVec[2] * u0 + vVec[2] * v1,
        ];
        writeTri(p00, p10, p11, normal);
        writeTri(p00, p11, p01, normal);
      }
    }
  };

  for (const b of boxes) {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    emitQuadGrid([x0, y0, z0], [0, dy, 0], [dx, 0, 0], [0, 0, -1], b.segA, b.segB);
    emitQuadGrid([x0, y0, z1], [dx, 0, 0], [0, dy, 0], [0, 0, 1], b.segA, b.segB);
    emitQuadGrid([x0, y0, z0], [dx, 0, 0], [0, 0, dz], [0, -1, 0], b.segA, b.segB);
    emitQuadGrid([x1, y1, z0], [-dx, 0, 0], [0, 0, dz], [0, 1, 0], b.segA, b.segB);
    emitQuadGrid([x0, y1, z0], [0, -dy, 0], [0, 0, dz], [-1, 0, 0], b.segA, b.segB);
    emitQuadGrid([x1, y0, z0], [0, dy, 0], [0, 0, dz], [1, 0, 0], b.segA, b.segB);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return totalTris;
}

interface BandCoverage {
  name: string;
  fillRatio: number;
  maxGapPx: number;
  filledInSpan: number;
}

async function measureCanvasBands(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
  canvasPng: Buffer,
): Promise<{
  totalModelPixels: number;
  bands: BandCoverage[];
  head: [number, number];
  base: [number, number];
}> {
  return electronApp.evaluate(({ nativeImage }, pngBase64) => {
    const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
    const { width: w, height: h } = img.getSize();
    const bmp = img.toBitmap();

    const bgB = bmp[(2 * w + 2) * 4 + 0];
    const bgG = bmp[(2 * w + 2) * 4 + 1];
    const bgR = bmp[(2 * w + 2) * 4 + 2];

    const isModelPixel = (x: number, y: number) => {
      const idx = (y * w + x) * 4;
      return (
        Math.abs(bmp[idx] - bgB) +
        Math.abs(bmp[idx + 1] - bgG) +
        Math.abs(bmp[idx + 2] - bgR)
      ) > 25;
    };

    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    let totalModelPixels = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (isModelPixel(x, y)) {
          totalModelPixels++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    const bandNames = ['head', 'torso', 'legs', 'base'];
    const bandHeight = Math.max(1, Math.floor((maxY - minY + 1) / 4));
    const bands: BandCoverage[] = [];
    for (let b = 0; b < 4; b++) {
      const yStart = minY + b * bandHeight;
      const yEnd = b === 3 ? maxY : yStart + bandHeight - 1;
      let spanPixels = 0;
      let filledInSpan = 0;
      let maxGapInRows = 0;
      for (let y = yStart; y <= yEnd; y++) {
        let rowMin = -1;
        let rowMax = -1;
        for (let x = minX; x <= maxX; x++) {
          if (isModelPixel(x, y)) {
            if (rowMin === -1) rowMin = x;
            rowMax = x;
          }
        }
        if (rowMin !== -1 && rowMax > rowMin) {
          let curGap = 0;
          for (let x = rowMin; x <= rowMax; x++) {
            spanPixels++;
            if (isModelPixel(x, y)) {
              filledInSpan++;
              curGap = 0;
            } else {
              curGap++;
              if (curGap > maxGapInRows) maxGapInRows = curGap;
            }
          }
        }
      }
      bands.push({
        name: bandNames[b],
        fillRatio: spanPixels > 0 ? +(filledInSpan / spanPixels).toFixed(3) : 0,
        maxGapPx: maxGapInRows,
        filledInSpan,
      });
    }

    function interiorAt(fraction: number): [number, number] {
      const row = minY + Math.floor((maxY - minY) * fraction);
      let best = { start: minX, length: 0 };
      let start = minX;
      for (let x = minX; x <= maxX + 1; x++) {
        if (x <= maxX && isModelPixel(x, row)) continue;
        if (x - start > best.length) best = { start, length: x - start };
        start = x + 1;
      }
      if (!best.length) throw new Error(`No rendered surface at row ${row}`);
      return [best.start + Math.floor(best.length / 2), row];
    }

    return { totalModelPixels, bands, head: interiorAt(0.12), base: interiorAt(0.90) };
  }, canvasPng.toString('base64'));
}

describe('End-to-end WebGL solid surface coverage on dense STL', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-e2e-solid-'));

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const hasBuiltApp = fs.existsSync(MAIN_ENTRY) && fs.existsSync(WORKER_BIN);

  it.skipIf(!hasBuiltApp)(
    'renders the settled model across the viewport and supports peripheral picks, fills, and undo',
    { timeout: 60000 },
    async () => {
      const stlPath = path.join(tmpDir, 'dense_figure.stl');
      const totalTris = generateDenseUprightFigureStl(stlPath);
      expect(totalTris).toBeGreaterThan(180000);

      const electronApp = await electron.launch({
        args: [WORKSPACE_ROOT],
        cwd: WORKSPACE_ROOT,
      });
      const childPid = electronApp.process()?.pid;

      try {
        const page = await electronApp.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForSelector('button:has-text("Open model")', { timeout: 15000 });

        await electronApp.evaluate(async ({ dialog }, targetPath) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [targetPath],
          });
        }, stlPath);

        await page.click('button:has-text("Open model")');

        await page.waitForFunction(
          () => {
            const text = document.body.innerText;
            return !text.includes('Importing STL') && text.includes('Spatial batches');
          },
          undefined,
          { timeout: 30000 },
        );

        // Allow settled detail streaming to complete
        await page.waitForTimeout(2500);

        const canvas = page.locator('canvas').first();
        const settledShot = await canvas.screenshot({ scale: 'css' });
        const settledMetrics = await measureCanvasBands(electronApp, settledShot);

        expect(settledMetrics.totalModelPixels).toBeGreaterThan(50000);
        for (const band of settledMetrics.bands) {
          // A solid surface across head, torso, legs, and base must not have scattered-dot gaps
          expect(band.fillRatio, `band ${band.name} fillRatio`).toBeGreaterThanOrEqual(0.85);
        }

        // Orbit the camera and verify it settles solid and supports picking on head/base
        const box = await canvas.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.48, { steps: 8 });
          await page.mouse.up();
          await page.waitForSelector('canvas[data-surface-detail="original"]', { timeout: 15000 });

          const orbitedShot = await canvas.screenshot({ scale: 'css' });
          const orbitedMetrics = await measureCanvasBands(electronApp, orbitedShot);
          for (const band of orbitedMetrics.bands) {
            expect(band.fillRatio, `orbited band ${band.name} fillRatio`).toBeGreaterThanOrEqual(0.85);
          }

          // Measure pick points on the screenshot so orbital offset and display scaling
          // cannot move a hard-coded point outside the head or base.
          const pickBox = await canvas.boundingBox();
          if (!pickBox) throw Error('Viewport disappeared after orbit');
          await page.mouse.click(pickBox.x + orbitedMetrics.head[0], pickBox.y + orbitedMetrics.head[1]);

          const faceIdLocator = page.locator('[data-testid="picked-face-id"]');
          await faceIdLocator.waitFor({ state: 'visible', timeout: 10000 });
          const headFaceId = Number(await faceIdLocator.innerText());
          expect(Number.isInteger(headFaceId) && headFaceId >= 0).toBe(true);

          // Also click near the base band to verify picking at the opposite extremity
          await page.mouse.click(pickBox.x + orbitedMetrics.base[0], pickBox.y + orbitedMetrics.base[1]);
          await page.waitForFunction(
            (prevId) => {
              const el = document.querySelector('[data-testid="picked-face-id"]');
              return el && el.textContent && Number(el.textContent) !== prevId;
            },
            headFaceId,
            { timeout: 10000 },
          );
          const baseFaceId = Number(await faceIdLocator.innerText());
          expect(Number.isInteger(baseFaceId) && baseFaceId >= 0 && baseFaceId !== headFaceId).toBe(true);

          await page.getByRole('button', { name: 'Add region' }).click();
          await page.getByRole('button', { name: 'Fill', exact: true }).click();
          const paintedFaces = page.getByLabel('Painted faces');
          await page.mouse.click(pickBox.x + orbitedMetrics.head[0], pickBox.y + orbitedMetrics.head[1]);
          await page.waitForFunction(() => {
            const text = document.querySelector('[aria-label="Painted faces"]')?.textContent;
            return text && text !== '0 painted faces';
          });
          const afterHead = await paintedFaces.innerText();
          await page.mouse.click(pickBox.x + orbitedMetrics.base[0], pickBox.y + orbitedMetrics.base[1]);
          await page.waitForFunction((previous) => document.querySelector('[aria-label="Painted faces"]')?.textContent !== previous, afterHead);
          expect(await page.getByRole('button', { name: 'Apply fill' }).count()).toBe(0);
          await page.getByRole('button', { name: 'Undo stroke' }).click();
          expect(await paintedFaces.innerText()).toBe(afterHead);
        }
      } finally {
        await electronApp.close().catch(() => {});
        if (childPid) {
          try {
            process.kill(childPid);
          } catch {
            // already exited
          }
        }
      }
    },
  );
});
