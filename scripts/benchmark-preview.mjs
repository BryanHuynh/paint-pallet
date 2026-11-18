import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

function summarizeFrameTimes(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frameSamples: sorted.length,
    medianFrameMs: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
    p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
  };
}

async function benchmark(executablePath, fixture, label) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-navigation-profile-'));
  const app = await electron.launch({ executablePath, args: [] });
  try {
    const peak = new Map();
    let sampling = false;
    function sampleMemory() {
      if (sampling) return;
      sampling = true;
      void app.evaluate(({ app }) => app.getAppMetrics().map((metric) => ({
        type: metric.type, rss: metric.memory.workingSetSize,
      }))).then((metrics) => {
        const totals = new Map();
        for (const metric of metrics) totals.set(metric.type, (totals.get(metric.type) ?? 0) + metric.rss);
        for (const [type, total] of totals) peak.set(type, Math.max(peak.get(type) ?? 0, total));
      }).catch(() => {}).finally(() => { sampling = false; });
    }

    const page = await app.firstWindow();
    await app.evaluate(({ app, dialog }, { temp, fixture }) => {
      app.setPath('userData', temp);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
    }, { temp, fixture });

    const monitor = setInterval(sampleMemory, 250);
    try {
      const started = performance.now();
      await page.getByRole('button', { name: 'Open model' }).click();
      await page.getByText(path.basename(fixture), { exact: true }).waitFor({ timeout: 180000 });
      const readyMs = Math.round(performance.now() - started);
      const canvas = page.locator('#viewport-region canvas');
      await canvas.locator('xpath=self::*[@data-surface-detail="original"]').waitFor({ timeout: 45000 });
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Viewport did not render.');

      await page.evaluate(() => {
        const frameTimes = [];
        window.navigationFrameTimes = frameTimes;
        let previous = performance.now();
        const onFrame = (now) => {
          frameTimes.push(now - previous);
          previous = now;
          window.navigationFrameMonitor = requestAnimationFrame(onFrame);
        };
        window.navigationFrameMonitor = requestAnimationFrame(onFrame);
      });
      await page.mouse.move(box.x + box.width * 0.38, box.y + box.height * 0.48);
      await page.mouse.down();
      let restoring;
      try {
        await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.47, { steps: 4 });
        await canvas.locator('xpath=self::*[@data-surface-detail="preview"]').waitFor({ timeout: 15000 });
        for (let i = 0; i < 22; i++) {
          await page.mouse.move(box.x + box.width * (0.42 + i * 0.007), box.y + box.height * (0.48 + i * 0.001));
          await page.waitForTimeout(20);
        }
        restoring = performance.now();
      } finally {
        await page.mouse.up();
      }
      const timings = await page.evaluate(() => {
        cancelAnimationFrame(window.navigationFrameMonitor);
        return window.navigationFrameTimes;
      });
      await canvas.locator('xpath=self::*[@data-surface-detail="original"]').waitFor({ timeout: 45000 });
      const restoredMs = Math.round(performance.now() - restoring);
      sampleMemory();
      await page.waitForTimeout(500);

      console.log(JSON.stringify({
        fixture: label,
        bytes: fs.statSync(fixture).size,
        importAndCommitMs: readyMs,
        restoreDetailMs: restoredMs,
        ...summarizeFrameTimes(timings),
        peakAppWorkingSetMiB: Object.fromEntries([...peak].map(([type, value]) => [type, Math.round(value / 1024)])),
      }));
    } finally {
      clearInterval(monitor);
    }
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), temp);
    if (/^pp-navigation-profile-[a-zA-Z0-9]+$/.test(relative)) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

const [exe, reference, generated] = process.argv.slice(2);
if (!exe || !reference || !generated) {
  throw new Error('Usage: node scripts/benchmark-preview.mjs <packaged exe> <reference STL> <near-2 GiB STL>');
}
await benchmark(path.resolve(exe), path.resolve(reference), 'reference');
await benchmark(path.resolve(exe), path.resolve(generated), 'generated near 2 GiB');
