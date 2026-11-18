import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright-core';

const [executable, single, kitDirectory] = process.argv.slice(2);
if (!executable || !single || !kitDirectory) {
  throw new Error('Usage: node scripts/benchmark-release.mjs installed.exe near-limit.stl kit-folder');
}
const kit = (await fs.readdir(kitDirectory)).filter((name) => name.endsWith('.stl')).sort().map((name) => path.join(kitDirectory, name));

function frameSummary(samples) {
  const data = [...samples].sort((a, b) => a - b);
  return { count: data.length, p95Ms: Math.round(10 * data[Math.floor(data.length * 0.95)]) / 10 };
}

async function sizeOf(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? await sizeOf(file) : (await fs.stat(file)).size;
  }
  return bytes;
}

async function measure(label, sources) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pp-release-benchmark-'));
  const pdf = path.join(temp, 'painting-guide.pdf');
  const profile = path.join(temp, 'profile');
  const app = await electron.launch({
    executablePath: path.resolve(executable),
    args: ['--user-data-dir=' + profile, '--disable-background-networking'],
  });
  const browserPid = await app.evaluate(() => process.pid);
  const peak = new Map();
  let combinedPeakMiB = 0;
  let workerPeakMiB = 0;
  let workerMiB = 0;
  let unfinished = '';
  const workerCommand = `
    $p = ${browserPid}
    while (Get-Process -Id $p -ErrorAction SilentlyContinue) {
      $sample = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $p + " AND Name='paint_pallet_worker.exe'") -ErrorAction SilentlyContinue
      if ($sample) { (Get-Process -Id $sample.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 }
      Start-Sleep -Milliseconds 450
    }
  `;
  const encodedCommand = Buffer.from(workerCommand, 'utf16le').toString('base64');
  const pollWorker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  pollWorker.stdout.on('data', (chunk) => {
    const lines = (unfinished + String(chunk)).split(/\r?\n/);
    unfinished = lines.pop();
    for (const line of lines) {
      const amount = Number(line.trim()) / (1024 ** 2);
      if (!Number.isFinite(amount)) continue;
      workerMiB = amount;
      workerPeakMiB = Math.max(workerPeakMiB, amount);
    }
  });

  let sampling = false;
  const monitor = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void app.evaluate(({ app }) => app.getAppMetrics().map((metric) => [metric.type, metric.memory.workingSetSize / 1024]))
      .then((entries) => {
        const samples = new Map();
        for (const [type, rss] of entries) samples.set(type, (samples.get(type) ?? 0) + rss);
        for (const [type, rss] of samples) peak.set(type, Math.max(peak.get(type) ?? 0, rss));
        combinedPeakMiB = Math.max(combinedPeakMiB, workerMiB + [...samples.values()].reduce((total, rss) => total + rss, 0));
      }).catch(() => {}).finally(() => { sampling = false; });
  }, 250);

  try {
    await app.context().setOffline(true);
    const page = await app.firstWindow();
    if (await page.evaluate(() => navigator.onLine)) throw new Error('Offline renderer check did not take effect');
    page.setDefaultTimeout(180000);
    await app.evaluate(({ dialog }, config) => {
      dialog.showOpenDialog = async (_window, options) => ({
        canceled: false, filePaths: options.title.includes('kit parts') ? config.sources.slice(1) : config.sources.slice(0, 1),
      });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: config.pdf });
    }, { pdf, sources });

    const button = (name) => page.getByRole('button', { name, exact: true });
    const canvas = page.locator('#viewport-region canvas');
    const originalDetail = canvas.locator('xpath=self::*[@data-surface-detail="original"]');
    const frameStart = () => page.evaluate(() => {
      window.frameMeasurements = [];
      let before = performance.now();
      function tick(now) {
        window.frameMeasurements.push(now - before);
        before = now;
        window.measurementFrame = requestAnimationFrame(tick);
      }
      window.measurementFrame = requestAnimationFrame(tick);
    });
    const frameStop = () => page.evaluate(() => {
      cancelAnimationFrame(window.measurementFrame);
      return window.frameMeasurements;
    });
    const stage = performance.now();
    await frameStart();
    await button('Open model').click();
    await page.getByText(path.basename(sources[0]), { exact: true }).waitFor();
    if (sources.length > 1) {
      await button('Add kit parts').click();
      await page.getByText(new RegExp('^' + sources.length + ' parts')).waitFor();
    }
    console.error(label + ' loaded');
    const importMs = performance.now() - stage;
    const importFrames = frameSummary(await frameStop());

    const box = await canvas.boundingBox();
    if (!box) throw new Error('3D canvas unavailable');
    const click = (x, y) => page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    const offsets = [[0.50,0.50],[0.40,0.46],[0.60,0.46],[0.48,0.37],[0.49,0.63],[0.35,0.55],
      [0.66,0.54],[0.44,0.56],[0.56,0.54],[0.49,0.30],[0.49,0.70],[0.31,0.48],[0.69,0.48]];
    async function findSurface(predicate) {
      for (const attempt of [1, 2, 3]) {
        for (const [x, y] of offsets) {
          await click(x, y);
          await page.waitForTimeout(45 + attempt * 8);
          if (await predicate()) return;
        }
      }
      throw new Error('Could not select an original surface');
    }

    if (sources.length > 1) {
      const picker = page.getByLabel('Inspect part');
      const ids = await picker.locator('option').evaluateAll((options) => options.map((option) => option.value));
      for (const id of ids.slice(1)) {
        await picker.selectOption(id);
        await button('Attach current pose').click();
        await button('Mark joint on parent').click();
        await button('Front view').click();
        await button('Fit selected part').click();
        await originalDetail.waitFor();
        await findSurface(() => button('Preview fit').isEnabled());
        await button('Preview fit').click();
        await button('Confirm attachment').click();
      }
      await button('Isolate part').click();
    }

    await frameStart();
    await page.mouse.move(box.x + box.width * 0.40, box.y + box.height * 0.50);
    await page.mouse.down();
    for (let i = 0; i < 24; i++) {
      await page.mouse.move(box.x + box.width * (0.42 + i * 0.007), box.y + box.height * (0.48 + i * 0.001));
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    const orbitFrames = frameSummary(await frameStop());
    await originalDetail.waitFor();
    await button('Front view').click();
    if (sources.length > 1) await button('Fit selected part').click();
    await button('Add region').click();
    await page.getByLabel('Region name').fill('Benchmark surface');
    await button('Brush').click();
    const painted = page.getByLabel('Painted faces');
    await findSurface(async () => Number((await painted.textContent()).match(/[\d,]+/)[0].replaceAll(',', '')) > 0);
    const maskStart = performance.now();
    await button('Preview lighting').click();
    await button('Apply lighting').click();
    console.error(label + ' painted and lit');
    const maskMs = performance.now() - maskStart;

    if (sources.length > 1) await button('Show assembly').click();
    const exportStart = performance.now();
    await page.locator('.project-menu summary').click();
    await button('Painting guide').click();
    await button('Export PDF').click();
    await page.getByText('Painting guide saved.').waitFor();
    console.error(label + ' exported');
    const exportMs = performance.now() - exportStart;
    await button('Close').click();

    const cache = path.join(profile, 'mesh-cache');
    const cacheBytes = await sizeOf(cache);
    const jobsBefore = (await fs.readdir(cache)).sort();
    await button('Open model').click();
    await button('Cancel import').first().click();
    await page.getByText(/Canceled|Import canceled/i).waitFor();
    const jobsAfter = (await fs.readdir(cache)).sort();
    if (JSON.stringify(jobsBefore) !== JSON.stringify(jobsAfter)) throw new Error('Canceled import left cache entries');

    if (workerPeakMiB === 0) throw new Error('The native worker memory monitor produced no samples');
    const sizes = await Promise.all(sources.map((file) => fs.stat(file).then((stat) => stat.size)));
    console.log(JSON.stringify({
      label, offline: true, parts: sources.length, sourceBytes: sizes.reduce((sum, bytes) => sum + bytes, 0),
      importMs: Math.round(importMs), importFrames, orbitFrames, maskMs: Math.round(maskMs), exportMs: Math.round(exportMs),
      peakWorkingSetMiB: Object.fromEntries([...peak].map(([name, rss]) => [name, Math.round(rss)])),
      workerPeakMiB: Math.round(workerPeakMiB), combinedPeakMiB: Math.round(combinedPeakMiB),
      geometryCacheBytes: cacheBytes, pdfBytes: (await fs.stat(pdf)).size, cancelClean: true, pdf,
    }));
  } finally {
    clearInterval(monitor);
    pollWorker.kill();
    await app.close();
  }
}

await measure('single near 2 GiB', [path.resolve(single)]);
await measure('multipart near 2 GiB', kit);
