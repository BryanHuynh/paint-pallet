import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GUIDE_PASSES, GUIDE_VIEWS, type GuideExport } from '../shared/paintingGuide';

function escapeText(value: string) {
  return value.replace(/[&<>"']/g, (character) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  ));
}

const validHex = /^#[a-f0-9]{6}$/i;
const label = (pass: string) => pass[0].toUpperCase() + pass.slice(1);

export function renderGuideDocument(guide: GuideExport) {
  if ((guide.paper !== 'Letter' && guide.paper !== 'A4') ||
      typeof guide.modelName !== 'string' || typeof guide.snapshot !== 'string' ||
      !Array.isArray(guide.rows) || !Array.isArray(guide.callouts) ||
      !GUIDE_PASSES.every((pass) => guide.images[pass]?.length === GUIDE_VIEWS.length &&
        guide.images[pass].every((image) => /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)))) {
    throw new Error('The painting guide is missing printable views.');
  }

  const swatches = guide.rows.map((row, index) => {
    const cells = GUIDE_PASSES.map((pass) => {
      const swatch = row.swatches?.[pass];
      if (!swatch || !validHex.test(swatch.hex)) return '<td>Missing swatch</td>';
      const paint = [swatch.brand, swatch.bottleName].filter(Boolean).join(' ');
      return '<td><div class="hex"><span class="chip" style="background:' + swatch.hex + '"></span>' +
        escapeText(swatch.hex) + '</div>' + (paint ? '<div class="paint">' + escapeText(paint) + '</div>' : '') +
        (swatch.mixNotes ? '<div class="notes">' + escapeText(swatch.mixNotes) + '</div>' : '') + '</td>';
    });
    return '<tr><th scope="row"><span class="number">' + (index + 1) + '</span> ' +
      escapeText(row.name) + '</th>' + cells.join('') + '</tr>';
  });

  const description = '<p class="subtitle">' + escapeText(guide.modelName) + ' · ' +
    escapeText(guide.snapshot) + '</p>';
  const heads = GUIDE_PASSES.map((pass) => '<th scope="col">' + label(pass) + '</th>');
  const reference = '<section><h1>Painting guide</h1>' + description +
    '<h2>Paint recipes by region</h2><table><thead><tr><th scope="col">Region</th>' + heads.join('') +
    '</tr></thead><tbody>' + swatches.join('') + '</tbody></table></section>';

  const sheets = GUIDE_PASSES.map((pass) => {
    const views = GUIDE_VIEWS.map((view, index) => {
      const pins = guide.callouts.flatMap((callout) => {
        const row = guide.rows.findIndex((item) => item.id === callout.regionId);
        if (callout.view !== view || row < 0 || !Number.isFinite(callout.x) || !Number.isFinite(callout.y) ||
            callout.x < 0 || callout.x > 1 || callout.y < 0 || callout.y > 1) return [];
        return '<span class="pin number" style="left:' + (callout.x * 100) + '%;top:' + (callout.y * 100) +
          '%">' + (row + 1) + '</span>';
      });
      return '<figure><figcaption>' + view + '</figcaption><div class="view"><img src="' +
        guide.images[pass][index] + '" alt="">' + pins.join('') + '</div></figure>';
    });
    return '<section class="pass"><h1>' + label(pass) + '</h1>' + description +
      '<p class="legend">Gray shows surfaces outside this pass. Callout numbers match the recipe table.</p>' +
      '<div class="views">' + views.join('') + '</div></section>';
  });

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Painting guide</title>
<style>
  @page { size: ${guide.paper}; margin: 13mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: #26342f; font: 10pt "Segoe UI", Arial, sans-serif; }
  h1 { font-size: 28pt; margin: 0; line-height: 1.12; letter-spacing: -0.6pt; }
  h2 { font-size: 13pt; margin: 12mm 0 3mm; }
  .subtitle { color: #52635b; border-bottom: 1px solid #aab9b0; margin: 2mm 0 0; padding-bottom: 5mm; overflow-wrap: anywhere; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
  thead { background: #edf1ec; }
  th, td { vertical-align: top; padding: 3.2mm 2.5mm; overflow-wrap: anywhere; border-bottom: 1px solid #d7dfda; }
  tr { break-inside: avoid; }
  .hex { display: flex; gap: 2mm; align-items: center; font-weight: 600; }
  .chip { display: inline-block; width: 5mm; height: 5mm; border: 1px solid #74857b; border-radius: 1mm; flex-shrink: 0; }
  .paint { margin-top: 1.5mm; }
  .notes { color: #52635b; margin-top: 0.9mm; white-space: pre-wrap; }
  .pass { break-before: page; }
  .legend { color: #52635b; margin: 3mm 0 4mm; }
  .views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; }
  figure { margin: 0; border: 1px solid #cdd8d0; border-radius: 2mm; overflow: hidden; break-inside: avoid; }
  figcaption { text-align: center; background: #edf1ec; font-weight: 600; padding: 1.5mm 0; }
  .view { position: relative; }
  img { width: 100%; aspect-ratio: 1; display: block; }
  .number { display: inline-flex; min-width: 5mm; height: 5mm; padding: 0 0.9mm; align-items: center; justify-content: center;
    border-radius: 3mm; font-weight: 700; font-size: 8pt; line-height: 1; color: #fff; background: #28463b; }
  .pin { position: absolute; transform: translate(-50%, -50%); border: 1px solid #fff; }
  .pin[style*="left:0%"] { transform: translate(0, -50%); }
  .pin[style*="left:100%"] { transform: translate(-100%, -50%); }
</style>${reference}${sheets.join('')}</html>`;
}

export async function savePaintingGuide(parent: BrowserWindow, guide: GuideExport) {
  const document = renderGuideDocument(guide);
  const target = await dialog.showSaveDialog(parent, {
    title: 'Export painting guide',
    defaultPath: path.parse(guide.modelName).name + '-painting-guide.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (target.canceled || !target.filePath) return false;

  const scratch = path.join(os.tmpdir(), 'paint-pallet-guide-' + crypto.randomUUID() + '.html');
  const pending = path.join(path.dirname(target.filePath), '.' + path.basename(target.filePath) + '.' + crypto.randomUUID() + '.tmp');
  const preview = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await fs.writeFile(scratch, document, { flag: 'wx' });
    await preview.loadFile(scratch);
    const pdf = await preview.webContents.printToPDF({
      pageSize: guide.paper, preferCSSPageSize: true, printBackground: true, generateTaggedPDF: true,
    });
    await fs.writeFile(pending, pdf, { flag: 'wx' });
    await fs.rename(pending, target.filePath);
    return true;
  } finally {
    preview.destroy();
    await Promise.all([fs.unlink(scratch).catch(() => {}), fs.unlink(pending).catch(() => {})]);
  }
}
