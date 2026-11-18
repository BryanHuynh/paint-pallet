import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';

const ZOOM_LEVELS = [0.03125, 0.0625, 0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

export function usePreviewZoom(
  workspaceRef: React.RefObject<HTMLElement | null>,
  stageRef: React.RefObject<HTMLDivElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  hasImage: boolean,
) {
  const [zoom, setZoom] = useState<number | null>(null);
  const anchor = useRef<{ x: number; y: number; u: number; v: number } | null>(null);

  function getScale() {
    const canvas = canvasRef.current;
    const width = canvas?.getBoundingClientRect().width;
    return zoom ?? (canvas && width ? width / canvas.width : 1);
  }

  function zoomTo(scale: number, clientX?: number, clientY?: number) {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    if (!canvas || !stage || zoom === next) return;

    const image = canvas.getBoundingClientRect();
    const viewport = stage.getBoundingClientRect();
    const x = clientX ?? viewport.left + stage.clientWidth / 2;
    const y = clientY ?? viewport.top + stage.clientHeight / 2;
    anchor.current = image.width && image.height
      ? {
          x,
          y,
          u: Math.max(0, Math.min(1, (x - image.left) / image.width)),
          v: Math.max(0, Math.min(1, (y - image.top) / image.height)),
        }
      : null;
    setZoom(next);
  }

  function stepZoom(direction: 1 | -1) {
    const scale = getScale();
    const next = direction === 1
      ? ZOOM_LEVELS.find((level) => level > scale * 1.005) ?? MAX_ZOOM
      : ZOOM_LEVELS.filter((level) => level < scale * 0.995).at(-1);
    if (next !== undefined) zoomTo(next);
  }

  function fit() {
    anchor.current = null;
    setZoom(null);
    const stage = stageRef.current;
    if (stage) {
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    }
  }

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const image = canvasRef.current?.getBoundingClientRect();
    const point = anchor.current;
    anchor.current = null;
    if (!stage || !image || !point) return;
    stage.scrollLeft += image.left + point.u * image.width - point.x;
    stage.scrollTop += image.top + point.v * image.height - point.y;
  }, [zoom, stageRef, canvasRef]);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const workspace = workspaceRef.current;
    if (!workspace || workspace.closest('[hidden]') || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    switch (event.key) {
      case '+':
      case '=':
        stepZoom(1);
        break;
      case '-':
      case '_':
        stepZoom(-1);
        break;
      case '0':
        fit();
        break;
      case '1':
        zoomTo(1);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  const handleWheel = useEffectEvent((event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
    event.preventDefault();
    const sensitivity = event.deltaMode === 1 ? 0.05 : 0.002;
    const scale = getScale();
    if (scale < MIN_ZOOM && event.deltaY > 0) return;
    zoomTo(scale * Math.exp(-event.deltaY * sensitivity), event.clientX, event.clientY);
  });

  useEffect(() => {
    const stage = stageRef.current;
    if (!hasImage || !stage) return;
    window.addEventListener('keydown', handleShortcut);
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', handleShortcut);
      stage.removeEventListener('wheel', handleWheel);
    };
  }, [hasImage, stageRef]);

  return { zoom, zoomTo, stepZoom, fit, atMin: zoom === MIN_ZOOM, atMax: zoom === MAX_ZOOM };
}
