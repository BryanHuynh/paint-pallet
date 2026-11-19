import { Euler, Quaternion } from 'three';
import { useMemo, useRef, useState } from 'react';
import type { KitJoint, KitPart, PartPose } from '../../shared/kit';
import type { PaintPalletApi, PickResult, Vec3 } from '../../shared/workerProtocol';
import { startShadowStroke, paintShadowFaces, type ShadowCoverage, type ShadowHit } from '../paint/shadowPaint';
import { unpackFillFaces } from '../paint/useConnectedFill';
import { canAttach, fitSixFaces, moveKitPart, type PlanePick } from './jointMath';
import { findNearbyFit } from './findNearbyFit';

export type JointMode = 'authored' | 'six-face' | 'manual' | 'nearby';
export const JOINT_HIGHLIGHT = 'joint-highlight';
export const JOINT_STEPS = ['Peg tip', 'Peg first side', 'Peg second side', 'Socket floor', 'Socket first wall', 'Socket second wall'];

interface SurfacePick extends PlanePick {
  coverage: ShadowCoverage;
}
interface JointDraft {
  childId: string;
  parentId: string;
  method: JointMode;
  pose: PartPose;
  point?: Vec3;
  picks: SurfacePick[];
  adjustments: Vec3;
  preview: boolean;
}

interface AssemblyEdit {
  parts: KitPart[];
  joints: KitJoint[];
}

export function useKitAssembly(
  api: PaintPalletApi | undefined,
  parts: KitPart[],
  setParts: (parts: KitPart[] | ((current: KitPart[]) => KitPart[])) => void,
  focus: (part: KitPart) => void,
) {
  const [joints, setJoints] = useState<KitJoint[]>([]);
  const [undo, setUndo] = useState<AssemblyEdit[]>([]);
  const [redo, setRedo] = useState<AssemblyEdit[]>([]);
  const [draft, setDraft] = useState<JointDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const [isolated, setIsolated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const pickJob = useRef<string | null>(null);
  const snapJob = useRef<AbortController | null>(null);

  const expectedId = !draft || draft.preview ? null
    : draft.method === 'six-face' ? draft.picks.length < 3 ? draft.childId : draft.parentId
    : picking ? draft.parentId : null;

  function focusPart(id: string) {
    const part = parts.find((item) => item.id === id);
    if (part) focus(part);
  }

  function cancel() {
    snapJob.current?.abort();
    snapJob.current = null;
    if (pickJob.current) void api?.cancelConnectedFill?.(pickJob.current).catch(() => {});
    pickJob.current = null;
    setAnalyzing(false);
    setIsolated(null);
    setDraft(null);
    setPicking(false);
    setError(null);
  }

  function begin(child: KitPart, method: JointMode) {
    const previous = joints.find((joint) => joint.childId === child.id);
    const parentId = previous?.parentId ?? parts[0]?.id;
    if (!parentId || child.id === parentId) return;
    cancel();
    setDraft({ childId: child.id, parentId: method === 'nearby' ? '' : parentId,
      method, pose: child.pose, point: method === 'nearby' ? undefined : previous?.point, picks: [],
      adjustments: [0, 0, 0], preview: false });
    focusPart(child.id);
  }

  function selectParent(parentId: string) {
    if (!draft || (!(draft.method === 'nearby' && !parentId) && !canAttach(parts, joints, draft.childId, parentId))) return;
    const picks = draft.picks.slice(0, 3);
    setDraft({ ...draft, parentId, picks, point: undefined, preview: false });
    setPicking(false);
    setIsolated(null);
    setError(null);
    if (picks.length === 3) focusPart(parentId);
  }

  async function snapNearby() {
    if (!draft || draft.method !== 'nearby' || draft.preview || !api || snapJob.current) return;
    const child = parts.find((part) => part.id === draft.childId);
    if (!child) return;
    const parents = parts.filter((part) => (!draft.parentId || part.id === draft.parentId) &&
      canAttach(parts, joints, child.id, part.id));
    const controller = new AbortController();
    snapJob.current = controller;
    setAnalyzing(true);
    setError(null);
    try {
      const result = await findNearbyFit(child, parents, api.readBatch, controller.signal);
      if (snapJob.current !== controller) return;
      if (result.kind !== 'fit') {
        setError(result.kind === 'ambiguous'
          ? 'Multiple nearby fits look similar. Choose a parent or use a six-face fit.'
          : 'No reliable nearby fit. Move the part closer or use a six-face fit.');
        return;
      }
      setDraft({ ...draft, parentId: result.best.parentId, point: result.best.point,
        pose: result.best.pose, preview: true });
      focusPart(result.best.parentId);
    } catch (failure) {
      if (snapJob.current === controller) setError(failure instanceof Error ? failure.message : 'Could not search nearby surfaces.');
    } finally {
      if (snapJob.current === controller) {
        snapJob.current = null;
        setAnalyzing(false);
      }
    }
  }

  async function capture(part: KitPart, result: PickResult) {
    if (!draft || pickJob.current || part.id !== expectedId || !result.hit || !result.point ||
      !result.normal || result.originalFaceId === null) return;
    setError(null);
    if (draft.method !== 'six-face') {
      setPicking(false);
      setDraft({ ...draft, point: result.point });
      return;
    }
    if (!api?.previewConnectedFill || draft.picks.length === 6) return;

    const id = crypto.randomUUID();
    pickJob.current = id;
    setAnalyzing(true);
    try {
      const packed = await api.previewConnectedFill({ modelId: part.model.modelId, jobId: id,
        faceId: result.originalFaceId, maxCreaseDegrees: 0.5, blockedFaces: [], coplanar: true });
      if (pickJob.current !== id) return;
      const layer = startShadowStroke(new Map(), JOINT_HIGHLIGHT, 'brush');
      paintShadowFaces(layer, unpackFillFaces(packed));
      if (!layer.coverage.size) throw new Error('No connected planar surface found. Choose a nearby face.');
      const currentSide = draft.picks.slice(draft.picks.length < 3 ? 0 : 3);
      if (currentSide.some((entry) => [...layer.coverage.values()].some((faces) =>
        [...faces.values()].some((face) => entry.coverage.get(face.batchIndex)?.has(face.faceId))))) {
        throw new Error('That face is already selected. Pick an adjacent mating face.');
      }
      const picks = [...draft.picks, { point: result.point, normal: result.normal, coverage: layer.coverage }];
      if (picks.length === 3) focusPart(draft.parentId);
      if (picks.length === 6) {
        const fit = calculateFit(draft, picks, draft.adjustments);
        setDraft({ ...draft, picks, ...fit, preview: true });
        setIsolated(null);
      } else {
        setDraft({ ...draft, picks });
      }
    } catch (failure) {
      if (pickJob.current === id) setError(failure instanceof Error ? failure.message : 'Could not use the selected face.');
    } finally {
      if (pickJob.current === id) {
        pickJob.current = null;
        setAnalyzing(false);
      }
    }
  }

  function calculateFit(target: JointDraft, picks: SurfacePick[], adjustments: Vec3) {
    const parent = parts.find((part) => part.id === target.parentId);
    if (!parent) throw new Error('Choose an attached parent.');
    return fitSixFaces([picks[0], picks[1], picks[2]], [picks[3], picks[4], picks[5]], parent.pose, adjustments);
  }

  function adjust(offset: number, value: number) {
    if (!draft || draft.picks.length !== 6 || !Number.isFinite(value)) return;
    const adjustments: Vec3 = [...draft.adjustments];
    adjustments[offset] = value;
    setDraft({ ...draft, adjustments, ...calculateFit(draft, draft.picks, adjustments) });
  }

  function adjustManual(axis: number, distance: number, angle: boolean) {
    if (!draft || draft.method !== 'manual' || !Number.isFinite(distance)) return;
    const pose: PartPose = { translation: [...draft.pose.translation], rotation: [...draft.pose.rotation] };
    if (angle) {
      const rotation = new Quaternion(...pose.rotation);
      const change: Vec3 = [0, 0, 0];
      change[axis] = distance * Math.PI / 180;
      rotation.premultiply(new Quaternion().setFromEuler(new Euler(...change)));
      pose.rotation = rotation.normalize().toArray();
    } else {
      pose.translation[axis] += distance;
    }
    setDraft({ ...draft, pose });
  }

  function back() {
    if (!draft || draft.picks.length === 0) return;
    const picks = draft.picks.slice(0, -1);
    setDraft({ ...draft, picks, preview: false, point: undefined });
    setError(null);
    focusPart(picks.length < 3 ? draft.childId : draft.parentId);
  }

  function markPoint() {
    if (!draft) return;
    setPicking(true);
    setError(null);
    focusPart(draft.parentId);
  }

  function write(partsNext: KitPart[], jointsNext: KitJoint[]) {
    setUndo((stack) => [...stack, { parts, joints }]);
    setRedo([]);
    setParts(partsNext);
    setJoints(jointsNext);
    cancel();
  }

  function confirmPlacement(ids: readonly string[]) {
    if (draft) return;
    const selected = new Set(ids);
    const confirmed = parts.map((part) => part.staged && selected.has(part.id)
      ? { ...part, staged: false, placementConfirmed: true as const }
      : part);
    if (confirmed.some((part, index) => part !== parts[index])) write(confirmed, joints);
  }

  function keepPose() {
    if (!draft || draft.method !== 'manual') return;
    write(moveKitPart(parts, joints, draft.childId, draft.pose), joints);
  }

  function confirm() {
    if (!draft?.preview || !draft.point || !canAttach(parts, joints, draft.childId, draft.parentId)) return;
    const record: KitJoint = { childId: draft.childId, parentId: draft.parentId, point: draft.point, method: draft.method };
    const previous = joints.findIndex((joint) => joint.childId === record.childId);
    const next = [...joints];
    if (previous < 0) next.push(record);
    else next[previous] = record;
    write(moveKitPart(parts, joints, draft.childId, draft.pose).map((part) => part.id === draft.childId ? { ...part, staged: false, placementConfirmed: undefined } : part), next);
  }

  function transfer(from: AssemblyEdit[], save: (edit: AssemblyEdit) => void, trim: () => void) {
    const next = from.at(-1);
    if (!next || draft) return;
    save({ parts, joints });
    trim();
    // Imported or removed staged parts remain available outside the undo history.
    const recorded = new Map(next.parts.map((part) => [part.id, part]));
    const restored = parts.map((part) => {
      const earlier = recorded.get(part.id);
      return earlier ? { ...part, pose: earlier.pose, staged: earlier.staged, placementConfirmed: earlier.placementConfirmed } : part;
    });
    const ids = new Set(restored.map((part) => part.id));
    setParts(restored);
    setJoints(next.joints.filter((joint) => ids.has(joint.parentId) && ids.has(joint.childId)));
  }

  function reset(next: KitJoint[] = []) {
    cancel();
    setUndo([]);
    setRedo([]);
    setJoints(next);
  }

  const overlay = useMemo(() => {
    const layers = new Map<number, Map<number, ShadowHit>>();
    if (!draft || draft.method !== 'six-face') return layers;
    const samePart = expectedId === draft.childId ? draft.picks.slice(0, 3) : draft.picks.slice(3);
    for (const pick of samePart) {
      for (const [batch, faces] of pick.coverage) {
        let layer = layers.get(batch);
        if (!layer) { layer = new Map(); layers.set(batch, layer); }
        for (const [faceId, hit] of faces) layer.set(faceId, hit);
      }
    }
    return layers;
  }, [draft, expectedId]);

  return {
    joints, draft, overlay, expectedId, error, analyzing, isolated, setIsolated,
    begin, selectParent, capture, snapNearby, cancel, adjust, adjustManual, back, markPoint, keepPose, confirm, confirmPlacement, reset,
    canUndo: undo.length > 0, canRedo: redo.length > 0, picking,
    showPreview() {
      if (draft?.point && draft.method !== 'six-face') {
        setDraft({ ...draft, preview: true });
        setIsolated(null);
      }
    },
    undo() { transfer(undo, (edit) => setRedo([...redo, edit]), () => setUndo(undo.slice(0, -1))); },
    redo() { transfer(redo, (edit) => setUndo([...undo, edit]), () => setRedo(redo.slice(0, -1))); },
  };
}
