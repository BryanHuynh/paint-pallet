import { useEffect, useMemo, useRef, useState } from 'react';
import { GUIDE_VIEWS, type GuideCallout, type GuideExport, type GuidePaper, type GuideView } from '../../shared/paintingGuide';
import type { ModelOrientation, ModelSummary, PaintPalletApi } from '../../shared/workerProtocol';
import type { ShadowCoverage } from '../paint/shadowPaint';
import type { ToneMask } from '../paint/lightingState';
import type { InstallationPlan, KitJoint, KitPart } from '../../shared/kit';
import { InstallationEditor } from './InstallationEditor';
import { locateJointOnGuide, renderGuideViews } from './renderGuideViews';

interface Props {
  api: PaintPalletApi;
  model: ModelSummary;
  orientation: ModelOrientation;
  coverage: ShadowCoverage;
  tones: ToneMask;
  edges: ShadowCoverage;
  rows: GuideExport['rows'];
  snapshot: string;
  unapplied: boolean;
  callouts: GuideCallout[];
  setCallouts: (callouts: GuideCallout[]) => void;
  close: () => void;
  parts: readonly KitPart[];
  joints: readonly KitJoint[];
  installation: InstallationPlan;
  setInstallation: (plan: InstallationPlan) => void;
}

const pinPosition = (value: number) => Math.min(0.96, Math.max(0.04, value));

export default function PaintingGuideDialog({ api, model, orientation, coverage, tones, edges, rows, snapshot, unapplied, callouts, setCallouts, close, parts, joints, installation, setInstallation }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [focusPasses, setFocusPasses] = useState(true);
  const [paper, setPaper] = useState<GuidePaper>('Letter');
  const [region, setRegion] = useState(rows[0]?.id ?? '');
  const [previews, setPreviews] = useState<string[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const numbers = useMemo(() => new Map(rows.map((row, index) => [row.id, index + 1])), [rows]);
  const missing = rows.filter((row) => !row.swatches || Object.values(row.swatches).some(({ hex }) => !/^#[a-f0-9]{6}$/i.test(hex)));
    const missingEdges = useMemo(() => {
    const painted = new Set<string>();
    for (const batch of edges.values()) {
      for (const hit of batch.values()) painted.add(hit.regionId);
    }
    return rows.filter((row) => painted.has(row.id) && !row.edgeSwatch);
  }, [edges, rows]);
  const warnings = unapplied || missing.length > 0 || missingEdges.length > 0;
  const readBatch = api.readBatch;
  const printParts = useMemo(() => parts.filter((part) => !part.staged), [parts]);

  useEffect(() => {
    dialog.current?.showModal();
    return () => request.current?.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void renderGuideViews({ readBatch, model, parts: printParts, orientation, coverage, tones, rows, preview: true, signal: controller.signal })
      .then((images) => {
        if (!controller.signal.aborted) setPreviews(images.shadow);
      }, (error: unknown) => {
        if (!controller.signal.aborted) setMessage({ text: error instanceof Error ? error.message : 'Unable to render the guide preview.', error: true });
      });
    return () => controller.abort();
  }, [readBatch, model, printParts, orientation, coverage, tones, rows]);

  function position(view: GuideView, x: number, y: number) {
    if (!region) return;
    setCallouts([...callouts.filter((pin) => pin.view !== view || pin.regionId !== region),
      { view, regionId: region, x: pinPosition(x), y: pinPosition(y) }]);
  }

  async function exportGuide() {
    if (!api.exportPaintingGuide || (warnings && !acknowledged)) return;
    const controller = new AbortController();
    request.current = controller;
    setExporting(true);
    setMessage(null);
    try {
      const options = { readBatch, model, orientation, coverage, tones, edges, rows, preview: false, signal: controller.signal };
      const passCallouts: NonNullable<GuideExport['passCallouts']> = {};
      const images = await renderGuideViews({ ...options, parts: printParts, focusPasses,
        mapCallouts: (pass, remap) => {
          passCallouts[pass] = callouts.flatMap((callout) => remap(callout) ?? []);
        },
      });
      const installationViews = focusPasses && installation.order.length ? previews ?? undefined : undefined;
      const byId = new Map(printParts.map((part) => [part.id, part]));
      const jointByChild = new Map(joints.map((joint) => [joint.childId, joint]));
      const steps = installation.order.flatMap((id) => {
        const joint = jointByChild.get(id);
        const child = byId.get(id);
        const parent = joint && byId.get(joint.parentId);
        if (!child || !parent || !joint) return [];
        return [{
          incoming: child.name || 'Untitled part',
          parent: parent.name || 'Untitled parent',
          note: installation.notes[id] ?? '',
          ...locateJointOnGuide(model, orientation, printParts, parent, joint.point),
        }];
      });
      const isolatedSheets: NonNullable<GuideExport['isolatedSheets']> = [];
      for (const id of installation.isolatedViews) {
        const part = byId.get(id);
        if (!part) continue;
        controller.signal.throwIfAborted();
        isolatedSheets.push({ partName: part.name || 'Untitled part',
          images: await renderGuideViews({ ...options, parts: [part], focusPasses }) });
      }
      controller.signal.throwIfAborted();
      const saved = await api.exportPaintingGuide({
        paper, modelName: model.fileName, snapshot, rows, callouts, images, installation: steps, isolatedSheets,
        focusedPasses: focusPasses, passCallouts: focusPasses ? passCallouts : undefined, installationViews,
      });
      if (!controller.signal.aborted && saved) setMessage({ text: 'Painting guide saved.', error: false });
    } catch (error) {
      if (!controller.signal.aborted) setMessage({ text: error instanceof Error ? error.message : 'Unable to export the painting guide.', error: true });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <dialog ref={dialog} className="guide-dialog" aria-labelledby="guide-title" onCancel={(event) => {
      event.preventDefault();
      close();
    }}>
      <header className="guide-dialog__header">
        <div>
          <h2 id="guide-title">Painting guide</h2>
          <p className="hint-text">{model.fileName} · {snapshot}</p>
        </div>
        <button type="button" className="btn btn--secondary" onClick={close}>Close</button>
      </header>
      <div className="guide-dialog__options">
        <label>Paper
          <select value={paper} onChange={(event) => setPaper(event.target.value as GuidePaper)} disabled={exporting}>
            <option>Letter</option>
            <option>A4</option>
          </select>
        </label>
        <label>Paint views
          <select value={focusPasses ? 'painted' : 'full'} disabled={exporting}
            onChange={(event) => setFocusPasses(event.target.value === 'painted')}>
            <option value="painted">Painted surfaces</option>
            <option value="full">Full model</option>
          </select>
        </label>
        <label>Callout region
          <select value={region} onChange={(event) => setRegion(event.target.value)} disabled={exporting || rows.length === 0}>
            {rows.length === 0 && <option value="">No regions</option>}
            {rows.map((row, index) => <option key={row.id} value={row.id}>{index + 1}. {row.name}</option>)}
          </select>
        </label>
      </div>
      {rows.length > 0 && <p className="hint-text">Click a view to place the selected region’s number. Click a number to remove it.</p>}
      {previews ? (
        <div className="guide-dialog__views">
          {GUIDE_VIEWS.map((view, index) => (
            <figure key={view}>
              <figcaption>{view}</figcaption>
              <div className="guide-dialog__view">
                <button type="button" className="guide-dialog__image" aria-label={`Place callout on ${view.toLowerCase()} view`}
                  disabled={exporting || !region}
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    position(view, event.detail === 0 ? 0.5 : (event.clientX - box.left) / box.width,
                      event.detail === 0 ? 0.5 : (event.clientY - box.top) / box.height);
                  }}>
                  <img src={previews[index]} alt={`${view} orthographic view`} draggable={false} />
                </button>
                {callouts.filter((pin) => pin.view === view && numbers.has(pin.regionId)).map((pin) => (
                  <button type="button" key={pin.regionId} className="guide-dialog__pin"
                    aria-label={`Remove callout ${numbers.get(pin.regionId)} from ${view.toLowerCase()} view`}
                    disabled={exporting} style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
                    onClick={() => setCallouts(callouts.filter((other) => other !== pin))}>
                    {numbers.get(pin.regionId)}
                  </button>
                ))}
              </div>
            </figure>
          ))}
        </div>
      ) : !message && <p className="hint-text" role="status">Rendering the model views…</p>}
      {joints.length > 0 && <InstallationEditor parts={printParts} joints={joints} plan={installation}
        onChange={setInstallation} disabled={exporting} />}
      {warnings && (
        <div className="guide-dialog__warnings">
          {unapplied && <p>Lighting changes are unapplied. The guide will use the committed masks.</p>}
          {missing.length > 0 && <p>Missing swatches for {missing.map((row) => row.name).join(', ')}.</p>}
          {missingEdges.length > 0 && <p>Missing edge swatches for {missingEdges.map((row) => row.name).join(', ')}.</p>}
          <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={exporting} /> Export with these warnings</label>
        </div>
      )}
      {message && <p className="hint-text" role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      <footer className="guide-dialog__footer">
        <button type="button" className="btn btn--primary" onClick={exportGuide} disabled={!previews || exporting || warnings && !acknowledged}>
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </footer>
    </dialog>
  );
}
