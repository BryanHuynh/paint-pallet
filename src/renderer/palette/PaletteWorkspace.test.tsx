// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PaletteWorkspace from './PaletteWorkspace';

interface FixtureBitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

function createBitmapFixture(
  name: string,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  width: number,
  height: number,
  fillPixel: (x: number, y: number) => [number, number, number, number?],
  registry: Map<string, FixtureBitmap | 'error' | 'deferred'>,
): File {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = fillPixel(x, y);
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  const file = new File([data], name, { type: mimeType });
  const key = `${name}:${mimeType}:${width}x${height}`;
  (file as File & { __fixtureKey?: string }).__fixtureKey = key;
  registry.set(key, { width, height, data });
  return file;
}

function installCanvasAndImageHarness() {
  const registry = new Map<string, FixtureBitmap | 'error' | 'deferred'>();
  const urlToBitmap = new Map<string, FixtureBitmap | 'error' | 'deferred'>();
  const deferredResolvers = new Map<string, (bitmap: FixtureBitmap) => void>();
  const createdUrls: string[] = [];
  const revokeCounts = new Map<string, number>();
  const canvasBuffers = new WeakMap<HTMLCanvasElement, FixtureBitmap>();
  let urlCounter = 0;

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const key = (blob as File & { __fixtureKey?: string }).__fixtureKey;
      const url = `blob:fixture-${++urlCounter}`;
      createdUrls.push(url);
      if (key && registry.has(key)) {
        urlToBitmap.set(url, registry.get(key)!);
      }
      return url;
    },
    revokeObjectURL: (url: string) => {
      revokeCounts.set(url, (revokeCounts.get(url) ?? 0) + 1);
      urlToBitmap.delete(url);
    },
  });

  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    width = 0;
    height = 0;
    __bitmap?: FixtureBitmap;
    private _src = '';

    get src() {
      return this._src;
    }

    set src(value: string) {
      this._src = value;
      const entry = urlToBitmap.get(value);
      if (entry === 'deferred') {
        deferredResolvers.set(value, (bitmap: FixtureBitmap) => {
          this.naturalWidth = bitmap.width;
          this.naturalHeight = bitmap.height;
          this.width = bitmap.width;
          this.height = bitmap.height;
          this.__bitmap = bitmap;
          this.onload?.();
        });
        return;
      }
      queueMicrotask(() => {
        if (!entry || entry === 'error') {
          this.onerror?.();
          return;
        }
        this.naturalWidth = entry.width;
        this.naturalHeight = entry.height;
        this.width = entry.width;
        this.height = entry.height;
        this.__bitmap = entry;
        this.onload?.();
      });
    }
  }

  vi.stubGlobal('Image', MockImage);

  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== '2d') return null;
    const canvas = this;
    let fillStyle = '#000000';
    return {
      imageSmoothingEnabled: true,
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string) {
        fillStyle = value;
      },
      clearRect: () => {
        canvasBuffers.delete(canvas);
      },
      fillRect: (rx: number, ry: number, rw: number, rh: number) => {
        const existing = canvasBuffers.get(canvas);
        const out = existing
          ? new Uint8ClampedArray(existing.data)
          : new Uint8ClampedArray(canvas.width * canvas.height * 4);
        const hex = fillStyle.startsWith('#') && fillStyle.length === 7 ? fillStyle : '#000000';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const x0 = Math.max(0, Math.floor(rx));
        const y0 = Math.max(0, Math.floor(ry));
        const x1 = Math.min(canvas.width, Math.ceil(rx + rw));
        const y1 = Math.min(canvas.height, Math.ceil(ry + rh));
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const idx = (y * canvas.width + x) * 4;
            out[idx] = r;
            out[idx + 1] = g;
            out[idx + 2] = b;
            out[idx + 3] = 255;
          }
        }
        canvasBuffers.set(canvas, {
          width: canvas.width,
          height: canvas.height,
          data: out,
        });
      },
      drawImage: (
        imgOrCanvas: unknown,
        sx?: number,
        sy?: number,
        sw?: number,
        sh?: number,
        dx?: number,
        dy?: number,
        dw?: number,
        dh?: number,
      ) => {
        if (imgOrCanvas instanceof HTMLCanvasElement) {
          const srcBuf = canvasBuffers.get(imgOrCanvas);
          if (!srcBuf) return;
          const srcX = sx ?? 0;
          const srcY = sy ?? 0;
          const srcW = sw ?? srcBuf.width;
          const srcH = sh ?? srcBuf.height;
          const dstW = dw ?? srcW;
          const dstH = dh ?? srcH;
          const dstX = dx ?? 0;
          const dstY = dy ?? 0;
          const existing = canvasBuffers.get(canvas);
          const out = existing
            ? new Uint8ClampedArray(existing.data)
            : new Uint8ClampedArray(canvas.width * canvas.height * 4);
          for (let y = 0; y < dstH; y++) {
            for (let x = 0; x < dstW; x++) {
              const sampleX = Math.min(
                srcBuf.width - 1,
                Math.floor(srcX + (x / dstW) * srcW),
              );
              const sampleY = Math.min(
                srcBuf.height - 1,
                Math.floor(srcY + (y / dstH) * srcH),
              );
              const srcIdx = (sampleY * srcBuf.width + sampleX) * 4;
              const dstIdx = ((dstY + y) * canvas.width + (dstX + x)) * 4;
              if (dstIdx >= 0 && dstIdx + 3 < out.length) {
                out[dstIdx] = srcBuf.data[srcIdx];
                out[dstIdx + 1] = srcBuf.data[srcIdx + 1];
                out[dstIdx + 2] = srcBuf.data[srcIdx + 2];
                out[dstIdx + 3] = srcBuf.data[srcIdx + 3];
              }
            }
          }
          canvasBuffers.set(canvas, {
            width: canvas.width,
            height: canvas.height,
            data: out,
          });
          return;
        }
        const bitmap = (imgOrCanvas as { __bitmap?: FixtureBitmap }).__bitmap;
        if (bitmap) {
          canvasBuffers.set(canvas, {
            width: bitmap.width,
            height: bitmap.height,
            data: new Uint8ClampedArray(bitmap.data),
          });
        }
      },
      createImageData: (width: number, height: number) => ({
        width, height, data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: FixtureBitmap) => {
        canvasBuffers.set(canvas, image);
      },
      getImageData: (sx: number, sy: number, sw: number, sh: number) => {
        const buf = canvasBuffers.get(canvas);
        const out = new Uint8ClampedArray(sw * sh * 4);
        if (!buf) {
          return { data: out, width: sw, height: sh };
        }
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const srcX = sx + x;
            const srcY = sy + y;
            if (srcX >= 0 && srcX < buf.width && srcY >= 0 && srcY < buf.height) {
              const srcIdx = (srcY * buf.width + srcX) * 4;
              const dstIdx = (y * sw + x) * 4;
              out[dstIdx] = buf.data[srcIdx];
              out[dstIdx + 1] = buf.data[srcIdx + 1];
              out[dstIdx + 2] = buf.data[srcIdx + 2];
              out[dstIdx + 3] = buf.data[srcIdx + 3];
            }
          }
        }
        return { data: out, width: sw, height: sh };
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  return { registry, createdUrls, revokeCounts, deferredResolvers };
}

describe('PaletteWorkspace', () => {
  let registry: Map<string, FixtureBitmap | 'error' | 'deferred'>;
  let createdUrls: string[];
  let revokeCounts: Map<string, number>;
  let deferredResolvers: Map<string, (bitmap: FixtureBitmap) => void>;

  beforeEach(() => {
    ({ registry, createdUrls, revokeCounts, deferredResolvers } =
      installCanvasAndImageHarness());
  });

  it('mounts with no required props and lets the painter create and rename recipes', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    expect(
      screen.getByRole('heading', { name: /reference palette/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/import reference images/i)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /shadow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /midtone/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /highlight/i })).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/recipe name/i);
    expect(nameInput).toHaveValue('Recipe 1');

    await user.click(screen.getByRole('button', { name: /add recipe/i }));
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 2');

    await user.clear(screen.getByLabelText(/recipe name/i));
    await user.type(screen.getByLabelText(/recipe name/i), 'Cloak Blue');
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Cloak Blue');

    await user.click(screen.getByRole('button', { name: /Recipe 1/i }));
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 1');

    await user.click(screen.getByRole('button', { name: /Cloak Blue/i }));
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Cloak Blue');
  });

  it('imports multiple PNG, JPEG, and WebP references and switches between them without losing the active recipe', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    await user.clear(screen.getByLabelText(/recipe name/i));
    await user.type(screen.getByLabelText(/recipe name/i), 'Steel Armor');

    const imgA = createBitmapFixture(
      'armor-plate.png',
      'image/png',
      20,
      20,
      () => [32, 64, 96],
      registry,
    );
    const imgB = createBitmapFixture(
      'cloak-cloth.webp',
      'image/webp',
      30,
      15,
      () => [180, 40, 50],
      registry,
    );
    const imgC = createBitmapFixture(
      'brass-trim.jpg',
      'image/jpeg',
      24,
      24,
      () => [200, 160, 60],
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [imgA, imgB, imgC] } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /armor-plate\.png/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /cloak-cloth\.webp/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /brass-trim\.jpg/i }),
      ).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    expect(canvas.width).toBe(20);
    expect(canvas.height).toBe(20);

    await user.click(screen.getByRole('button', { name: /cloak-cloth\.webp/i }));
    expect(canvas.width).toBe(30);
    expect(canvas.height).toBe(15);
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Steel Armor');
  });

  it('adds supported dropped images to the reference stage and reports skipped files', async () => {
    render(<PaletteWorkspace />);
    const stage = screen.getByRole('region', { name: /reference stage/i });
    const png = createBitmapFixture('armor.png', 'image/png', 10, 10, () => [32, 64, 96], registry);
    const webp = createBitmapFixture('cloak.webp', 'image/webp', 10, 10, () => [180, 40, 50], registry);
    const text = new File(['notes'], 'notes.txt');
    const dataTransfer = { types: ['Files'], files: [png, text, webp], dropEffect: 'none' };

    expect(fireEvent.dragOver(stage, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(fireEvent.drop(stage, { dataTransfer })).toBe(false);

    expect(await screen.findByRole('button', { name: 'armor.png' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'cloak.webp' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Skipped unsupported files (notes.txt)');
  });

  it('samples exact pixels with the eyedropper into different tone slots across two reference images', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const img1 = createBitmapFixture(
      'ref-1.png',
      'image/png',
      10,
      10,
      (x, y) => (x === 2 && y === 3 ? [18, 52, 86] : [0, 0, 0]),
      registry,
    );
    const img2 = createBitmapFixture(
      'ref-2.png',
      'image/png',
      10,
      10,
      (x, y) => (x === 7 && y === 4 ? [171, 205, 239] : [255, 255, 255]),
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [img1, img2] } });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    await user.click(screen.getByRole('button', { name: /shadow/i }));
    fireEvent.pointerDown(canvas, { clientX: 25, clientY: 35 });
    fireEvent.pointerUp(canvas, { clientX: 25, clientY: 35 });

    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#123456');

    await user.click(screen.getByRole('button', { name: /ref-2\.png/i }));
    await user.click(screen.getByRole('button', { name: /highlight/i }));
    fireEvent.pointerDown(canvas, { clientX: 75, clientY: 45 });
    fireEvent.pointerUp(canvas, { clientX: 75, clientY: 45 });

    expect(screen.getByLabelText(/highlight hex/i)).toHaveValue('#ABCDEF');
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#123456');
  });

  it('suggests three perceptual-lightness tones from whole image or selected rectangle and previews before applying', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const splitImg = createBitmapFixture(
      'split-tones.png',
      'image/png',
      30,
      20,
      (x, y) => {
        if (x < 15) {
          if (y < 7) return [20, 28, 40];
          if (y < 14) return [90, 110, 140];
          return [210, 224, 240];
        }
        if (y < 7) return [60, 20, 20];
        if (y < 14) return [160, 50, 50];
        return [245, 190, 190];
      },
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [splitImg] } });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Whole-image suggestion shows preview without mutating committed swatches
    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    expect(
      screen.getByRole('region', { name: /tone suggestion preview/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#2B303A');

    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(
      screen.queryByRole('region', { name: /tone suggestion preview/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#2B303A');

    // Select right-half rectangle and suggest tones from that region
    await user.click(screen.getByRole('button', { name: /select region/i }));
    fireEvent.pointerDown(canvas, { clientX: 55, clientY: 5 });
    fireEvent.pointerMove(canvas, { clientX: 95, clientY: 95 });
    fireEvent.pointerUp(canvas, { clientX: 95, clientY: 95 });

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));

    const preview = screen.getByRole('region', {
      name: /tone suggestion preview/i,
    });
    expect(preview).toHaveTextContent('#3C1414');
    expect(preview).toHaveTextContent('#A03232');
    expect(preview).toHaveTextContent('#F5BEBE');

    // Committed swatches remain unchanged until Apply suggestions is clicked
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#2B303A');

    await user.click(screen.getByRole('button', { name: /apply suggestions/i }));
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#3C1414');
    expect(screen.getByLabelText(/midtone hex/i)).toHaveValue('#A03232');
    expect(screen.getByLabelText(/highlight hex/i)).toHaveValue('#F5BEBE');
    expect(
      screen.queryByRole('region', { name: /tone suggestion preview/i }),
    ).not.toBeInTheDocument();

    // Clear selection restores whole-image scope
    await user.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(
      screen.queryByRole('button', { name: /clear selection/i }),
    ).not.toBeInTheDocument();
  });

  it('edits hex swatches manually and records optional paint brand, bottle name, and mix notes', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const shadowHex = screen.getByLabelText(/shadow hex/i);
    await user.clear(shadowHex);
    await user.type(shadowHex, '1f3a52');
    await user.tab();
    expect(shadowHex).toHaveValue('#1F3A52');

    await user.clear(shadowHex);
    await user.type(shadowHex, 'bad-hex');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/6-digit hex/i);
    expect(shadowHex).toHaveValue('#1F3A52');

    await user.type(screen.getByLabelText(/shadow brand/i), 'Vallejo');
    await user.type(
      screen.getByLabelText(/shadow bottle name/i),
      'Prussian Blue',
    );
    await user.type(
      screen.getByLabelText(/shadow mix notes/i),
      '1:1 with water',
    );

    await user.click(screen.getByRole('button', { name: /add recipe/i }));
    expect(screen.getByLabelText(/shadow brand/i)).toHaveValue('');

    await user.click(screen.getByRole('button', { name: /Recipe 1/i }));
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#1F3A52');
    expect(screen.getByLabelText(/shadow brand/i)).toHaveValue('Vallejo');
    expect(screen.getByLabelText(/shadow bottle name/i)).toHaveValue(
      'Prussian Blue',
    );
    expect(screen.getByLabelText(/shadow mix notes/i)).toHaveValue(
      '1:1 with water',
    );
  });

  it('retains valid images on mixed decode failure, revokes every object URL once, and cleans up late decodes after unmount', async () => {
    const { unmount } = render(<PaletteWorkspace />);

    const goodFile = createBitmapFixture(
      'good.png',
      'image/png',
      12,
      12,
      () => [40, 80, 120],
      registry as Map<string, FixtureBitmap>,
    );
    const badFile = new File([new Uint8Array([1, 2, 3])], 'corrupt.png', {
      type: 'image/png',
    });
    (badFile as File & { __fixtureKey?: string }).__fixtureKey = 'corrupt-key';
    registry.set('corrupt-key', 'error');

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [goodFile, badFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /good\.png/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/corrupt\.png/i);
    expect(createdUrls).toHaveLength(2);
    expect(revokeCounts.get(createdUrls[1])).toBe(1);
    expect(revokeCounts.get(createdUrls[0]) ?? 0).toBe(0);

    // Trigger a slow decode, unmount before it resolves, then resolve it
    const slowFile = new File([new Uint8Array([4, 5, 6])], 'slow.png', {
      type: 'image/png',
    });
    (slowFile as File & { __fixtureKey?: string }).__fixtureKey = 'slow-key';
    registry.set('slow-key', 'deferred');
    fireEvent.change(fileInput, { target: { files: [slowFile] } });

    const slowUrl = createdUrls[2];
    expect(slowUrl).toBeDefined();
    expect(deferredResolvers.has(slowUrl)).toBe(true);

    unmount();
    expect(revokeCounts.get(createdUrls[0])).toBe(1);
    expect(revokeCounts.get(createdUrls[1])).toBe(1);

    deferredResolvers.get(slowUrl)!({
      width: 8,
      height: 8,
      data: new Uint8ClampedArray(8 * 8 * 4),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(revokeCounts.get(slowUrl)).toBe(1);
  });

  it('bounds getImageData area memory for very large images while preserving exact 1x1 eyedropper sampling', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const largeImg = createBitmapFixture(
      'large-4mp.png',
      'image/png',
      2000,
      2000,
      (x, y) => {
        if (x === 1234 && y === 1567) return [42, 173, 99];
        if (y < 667) return [15, 25, 35];
        if (y < 1334) return [95, 115, 135];
        return [215, 225, 235];
      },
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [largeImg] } });

    await waitFor(() => {
      const el = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
      expect(el.width).toBe(2000);
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    const origGetContext = canvas.getContext.bind(canvas);
    const getImageDataSizes: number[] = [];
    vi.spyOn(canvas, 'getContext').mockImplementation(((id: string) => {
      const ctx = origGetContext(id as '2d');
      if (!ctx) return null;
      const origGetImageData = ctx.getImageData.bind(ctx);
      ctx.getImageData = (sx: number, sy: number, sw: number, sh: number) => {
        getImageDataSizes.push(sw * sh);
        return origGetImageData(sx, sy, sw, sh);
      };
      return ctx;
    }) as typeof canvas.getContext);

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 2000,
      height: 2000,
      right: 2000,
      bottom: 2000,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerDown(canvas, { clientX: 1234, clientY: 1567 });
    fireEvent.pointerUp(canvas, { clientX: 1234, clientY: 1567 });
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#2AAD63');

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', {
      name: /tone suggestion preview/i,
    });
    expect(preview).toHaveTextContent('#0F1923');
    expect(preview).toHaveTextContent('#5F7387');
    expect(preview).toHaveTextContent('#D7E1EB');
    expect(Math.max(...getImageDataSizes)).toBeLessThanOrEqual(65536);
  });

  it('supports keyboard pixel sampling and keyboard rectangle selection with clear labels and focus', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const img = createBitmapFixture(
      'keyboard-ref.png',
      'image/png',
      20,
      20,
      (x, y) => {
        if (x === 2 && y === 1) return [17, 136, 204];
        if (x >= 10 && y >= 10) {
          if (y < 13) return [30, 15, 15];
          if (y < 16) return [140, 40, 40];
          return [240, 180, 180];
        }
        return [220, 220, 220];
      },
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [img] } });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    expect(canvas).toHaveAttribute('tabindex', '0');

    // Keyboard arrow navigation + Enter samples exact pixel (2, 1) -> #1188CC
    canvas.focus();
    expect(canvas).toHaveFocus();
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    fireEvent.keyDown(canvas, { key: 'ArrowDown' });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#1188CC');

    // Switch to Select region and select bottom-right quadrant via keyboard
    await user.click(screen.getByRole('button', { name: /select region/i }));
    const cursorX = screen.getByLabelText(/cursor x/i);
    const cursorY = screen.getByLabelText(/cursor y/i);
    await user.clear(cursorX);
    await user.type(cursorX, '10');
    await user.clear(cursorY);
    await user.type(cursorY, '10');

    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Enter' });
    fireEvent.keyDown(canvas, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(canvas, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(canvas, { key: 'Enter' });

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', {
      name: /tone suggestion preview/i,
    });
    expect(preview).toHaveTextContent('#1E0F0F');
    expect(preview).toHaveTextContent('#8C2828');
    expect(preview).toHaveTextContent('#F0B4B4');
  });

  it('ends selection drag when pointer is released outside the canvas and invalidates stale suggestion preview when selection scope changes', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const img = createBitmapFixture(
      'scope-invalidation.png',
      'image/png',
      20,
      20,
      (x, y) => {
        if (x < 10) return [20, 40, 60];
        if (y < 10) return [120, 140, 160];
        return [220, 230, 240];
      },
      registry,
    );

    const fileInput = screen.getByLabelText(/import reference images/i);
    fireEvent.change(fileInput, { target: { files: [img] } });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Generate whole-image suggestion preview, then start a selection rectangle:
    // changing the scope must invalidate the stale preview.
    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    expect(
      screen.getByRole('region', { name: /tone suggestion preview/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /select region/i }));
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 40 });

    expect(
      screen.queryByRole('region', { name: /tone suggestion preview/i }),
    ).not.toBeInTheDocument();

    // Release pointer outside canvas (on window): subsequent pointerMove must not resize selection.
    fireEvent(window, new Event('pointerup'));
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 90 });

    // Generate suggestion from the 10..40% selection (x < 10 -> #14283C), not 90%:
    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', {
      name: /tone suggestion preview/i,
    });
    expect(preview).toHaveTextContent('#14283C');
    expect(preview).not.toHaveTextContent('#DCE6F0');

    // Clearing selection also invalidates the preview.
    await user.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(
      screen.queryByRole('region', { name: /tone suggestion preview/i }),
    ).not.toBeInTheDocument();
  });

  it('deletes active and last recipes with confirmation, selects sensible neighbors, handles zero-recipe state, and keeps IDs noncolliding', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    // Import a reference image to verify it stays intact across recipe deletions
    const img = createBitmapFixture(
      'keep-ref.png',
      'image/png',
      16,
      16,
      () => [40, 80, 120],
      registry,
    );
    fireEvent.change(screen.getByLabelText(/import reference images/i), {
      target: { files: [img] },
    });
    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    // Customize Recipe 1
    const shadowHex1 = screen.getByLabelText(/shadow hex/i);
    await user.clear(shadowHex1);
    await user.type(shadowHex1, '112233');
    await user.tab();

    // Add Recipe 2 and Recipe 3
    await user.click(screen.getByRole('button', { name: /add recipe/i }));
    await user.click(screen.getByRole('button', { name: /add recipe/i }));
    const shadowHex3 = screen.getByLabelText(/shadow hex/i);
    await user.clear(shadowHex3);
    await user.type(shadowHex3, '445566');
    await user.tab();

    // Select middle recipe (Recipe 2), open Delete confirmation, then cancel
    await user.click(screen.getByRole('button', { name: /Recipe 2/i }));
    await user.click(screen.getByRole('button', { name: /delete recipe/i }));
    expect(
      screen.getByRole('button', { name: /confirm delete/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 2');

    // Confirm delete of middle recipe -> next neighbor (Recipe 3) becomes active
    await user.click(screen.getByRole('button', { name: /delete recipe/i }));
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(
      screen.queryByRole('button', { name: /^Recipe 2$/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 3');
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#445566');

    // Delete last recipe (Recipe 3) -> previous neighbor (Recipe 1) becomes active
    await user.click(screen.getByRole('button', { name: /delete recipe/i }));
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(
      screen.queryByRole('button', { name: /^Recipe 3$/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 1');
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#112233');

    // Delete final remaining recipe -> graceful zero-recipe state, reference intact
    await user.click(screen.getByRole('button', { name: /delete recipe/i }));
    await user.click(screen.getByRole('button', { name: /confirm delete/i }));
    expect(screen.queryByLabelText(/recipe name/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no recipes yet/i)).toBeInTheDocument();
    expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /keep-ref\.png/i }),
    ).toBeInTheDocument();

    // Add recipe afterward -> noncolliding ID/name (Recipe 4)
    await user.click(screen.getByRole('button', { name: /add recipe/i }));
    expect(screen.getByLabelText(/recipe name/i)).toHaveValue('Recipe 4');
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#2B303A');
  });

  it('supports zoom in/out, fit/reset, and source pixel-accurate eyedropper and selection under zoom and scroll', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const img = createBitmapFixture(
      'zoom-ref.png',
      'image/png',
      40,
      40,
      (x, y) => {
        if (x === 25 && y === 10) return [18, 52, 86];
        if (x >= 20 && y >= 20) {
          if (y < 27) return [30, 15, 15];
          if (y < 34) return [140, 40, 40];
          return [240, 180, 180];
        }
        return [200, 200, 200];
      },
      registry,
    );

    fireEvent.change(screen.getByLabelText(/import reference images/i), {
      target: { files: [img] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    const stage = screen.getByTestId('canvas-stage') as HTMLDivElement;

    const zoomInBtn = screen.getByRole('button', { name: /zoom in/i });
    const zoomOutBtn = screen.getByRole('button', { name: /zoom out/i });

    expect(screen.getByTestId('zoom-readout')).toHaveTextContent(/fit/i);

    // Zoom in twice (1.5x -> 2x) and verify scaled canvas dimensions
    await user.click(zoomInBtn);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('150%');
    expect(canvas.style.width).toBe('60px');

    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    fireEvent.keyDown(window, { key: '+', ctrlKey: true });
    fireEvent.keyDown(window, { key: '=', ctrlKey: true });
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('400%');
    expect(canvas.style.width).toBe('160px');
    expect(canvas.style.height).toBe('160px');

    // Simulate scrolled stage + zoomed bounding rect (40x40 at 400% = 160x160, scrolled by 50, 40)
    stage.scrollLeft = 50;
    stage.scrollTop = 40;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: -50,
      top: -40,
      width: 160,
      height: 160,
      right: 110,
      bottom: 120,
      x: -50,
      y: -40,
      toJSON: () => {},
    });

    // Target pixel (25, 10): (25.5 * 4 - 50) = 52, (10.5 * 4 - 40) = 2 -> #123456
    fireEvent.pointerDown(canvas, { clientX: 52, clientY: 2 });
    fireEvent.pointerUp(canvas, { clientX: 52, clientY: 2 });
    expect(screen.getByLabelText(/shadow hex/i)).toHaveValue('#123456');

    // Rectangle selection at zoom + scroll over bottom-right quadrant (20..39, 20..39)
    // In viewport coords: (20*4 - 50) = 30, (20*4 - 40) = 40 to (39*4 - 50) = 106, (39*4 - 40) = 116
    await user.click(screen.getByRole('button', { name: /select region/i }));
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 40 });
    fireEvent.pointerMove(canvas, { clientX: 106, clientY: 116 });
    fireEvent.pointerUp(canvas, { clientX: 106, clientY: 116 });

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', {
      name: /tone suggestion preview/i,
    });
    expect(preview).toHaveTextContent('#1E0F0F');
    expect(preview).toHaveTextContent('#8C2828');
    expect(preview).toHaveTextContent('#F0B4B4');

    // Zoom out and Fit / Reset restores Fit state and resets scroll
    await user.click(zoomOutBtn);
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('300%');

    await user.click(screen.getByLabelText('Zoom presets'));
    await user.click(screen.getByRole('button', { name: /actual size/i }));
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent('100%');

    fireEvent.keyDown(window, { key: '0', ctrlKey: true });
    expect(screen.getByTestId('zoom-readout')).toHaveTextContent(/fit/i);
    expect(canvas.style.width).toBe('');
    expect(stage.scrollLeft).toBe(0);
    expect(stage.scrollTop).toBe(0);
  });

  it('masks connected pixels, leaves separated colors out, and suggests tones from the mask', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);
    const image = createBitmapFixture('mask.png', 'image/png', 5, 2, (x) =>
      x === 2 ? [0, 0, 200] : [240, 0, 0],
    registry);
    fireEvent.change(screen.getByLabelText(/import reference images/i), { target: { files: [image] } });
    const canvas = await screen.findByTestId('reference-canvas');

    await user.click(screen.getByRole('button', { name: /smart select/i }));
    fireEvent.pointerDown(canvas, { button: 0, clientX: 0, clientY: 0 });

    const mask = screen.getByTestId('smart-selection-mask') as HTMLCanvasElement;
    const alphaAt = (x: number) => mask.getContext('2d')!.getImageData(x, 0, 1, 1).data[3];
    expect(alphaAt(0)).toBeGreaterThan(0);
    expect(alphaAt(2)).toBe(0);
    expect(alphaAt(4)).toBe(0);

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', { name: /tone suggestion preview/i });
    expect(preview).toHaveTextContent('#F00000');
    expect(preview).not.toHaveTextContent('#0000C8');

    fireEvent.pointerDown(canvas, { button: 0, clientX: 4, clientY: 0, shiftKey: true });
    expect(alphaAt(0)).toBeGreaterThan(0);
    expect(alphaAt(4)).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(mask).not.toBeInTheDocument();
  });

  it('reapplies tolerance changes to all selected color seeds without another click', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);
    const colors: [number, number, number][] = [
      [180, 0, 0], [145, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 110], [0, 0, 180],
    ];
    const image = createBitmapFixture('tolerance.png', 'image/png', colors.length, 2, (x) => colors[x], registry);
    fireEvent.change(screen.getByLabelText(/import reference images/i), { target: { files: [image] } });
    const canvas = await screen.findByTestId('reference-canvas');
    await user.click(screen.getByRole('button', { name: /smart select/i }));

    const tolerance = screen.getByRole('slider', { name: /tolerance/i });
    fireEvent.input(tolerance, { target: { value: '0' } });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 5, clientY: 0, shiftKey: true });

    const overlay = screen.getByTestId('smart-selection-mask') as HTMLCanvasElement;
    const included = (x: number) => overlay.getContext('2d')!.getImageData(x, 0, 1, 1).data[3] > 0;
    expect(colors.map((_, x) => included(x))).toEqual([true, false, false, false, false, true]);

    fireEvent.input(tolerance, { target: { value: '25' } });
    await waitFor(() => expect(colors.map((_, x) => included(x))).toEqual([true, true, false, false, true, true]));

    fireEvent.input(tolerance, { target: { value: '0' } });
    await waitFor(() => expect(colors.map((_, x) => included(x))).toEqual([true, false, false, false, false, true]));
  });

  it('includes enclosed islands and leaves pixels connected to the outside unselected', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);
    const image = createBitmapFixture('island.png', 'image/png', 9, 7, (x, y) => {
      const ring = x >= 1 && x <= 5 && y >= 1 && y <= 5
        && (x === 1 || x === 5 || y === 1 || y === 5);
      if (ring) return [240, 0, 0];
      if (x >= 2 && x <= 4 && y >= 2 && y <= 4) return [0, 0, 200];
      return [0, 200, 0];
    }, registry);
    fireEvent.change(screen.getByLabelText(/import reference images/i), { target: { files: [image] } });
    const canvas = await screen.findByTestId('reference-canvas');

    await user.click(screen.getByRole('button', { name: /smart select/i }));
    fireEvent.pointerDown(canvas, { button: 0, clientX: 1, clientY: 1 });

    const mask = screen.getByTestId('smart-selection-mask') as HTMLCanvasElement;
    const alphaAt = (x: number, y: number) => mask.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
    expect(alphaAt(3, 3)).toBeGreaterThan(0);
    expect(alphaAt(6, 3)).toBe(0);

    await user.click(screen.getByRole('button', { name: /suggest tones/i }));
    const preview = screen.getByRole('region', { name: /tone suggestion preview/i });
    expect(preview).toHaveTextContent('#0000C8');
    expect(preview).not.toHaveTextContent('#00C800');
  });

  it('shows a live cursor magnifier with crosshair and source pixels during region selection, works at edges, and clears when leaving/switching tools', async () => {
    const user = userEvent.setup();
    render(<PaletteWorkspace />);

    const img = createBitmapFixture(
      'magnifier-ref.png',
      'image/png',
      20,
      20,
      (x, y) => {
        if (x === 0 && y === 0) return [255, 0, 0];
        if (x === 10 && y === 10) return [0, 255, 0];
        return [30, 60, 90];
      },
      registry,
    );

    fireEvent.change(screen.getByLabelText(/import reference images/i), {
      target: { files: [img] },
    });

    await waitFor(() => {
      expect(screen.getByTestId('reference-canvas')).toBeInTheDocument();
    });

    const canvas = screen.getByTestId('reference-canvas') as HTMLCanvasElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Not shown in Eyedropper mode
    fireEvent.pointerMove(canvas, { clientX: 105, clientY: 105 });
    expect(screen.queryByTestId('region-magnifier')).not.toBeInTheDocument();

    // Switch to Select region -> moving pointer shows magnifier with crosshair and center pixel #00FF00
    await user.click(screen.getByRole('button', { name: /select region/i }));
    fireEvent.pointerMove(canvas, { clientX: 105, clientY: 105 });

    const magnifier = screen.getByTestId('region-magnifier');
    expect(magnifier).toBeInTheDocument();
    expect(screen.getByTestId('magnifier-crosshair')).toBeInTheDocument();
    expect(magnifier).toHaveTextContent('10, 10');
    expect(magnifier).toHaveTextContent('#00FF00');

    const magCanvas = screen.getByTestId(
      'region-magnifier-canvas',
    ) as HTMLCanvasElement;
    const magCtx = magCanvas.getContext('2d')!;
    const centerX = Math.floor(magCanvas.width / 2);
    const centerY = Math.floor(magCanvas.height / 2);
    const centerPixel = magCtx.getImageData(centerX, centerY, 1, 1).data;
    expect([centerPixel[0], centerPixel[1], centerPixel[2]]).toEqual([0, 255, 0]);

    // Edge usability at (0, 0): center pixel is #FF0000, top-left out-of-bounds is background #0F1F10
    fireEvent.pointerMove(canvas, { clientX: 2, clientY: 2 });
    expect(magnifier).toHaveTextContent('0, 0');
    expect(magnifier).toHaveTextContent('#FF0000');
    const edgeCenter = magCtx.getImageData(centerX, centerY, 1, 1).data;
    expect([edgeCenter[0], edgeCenter[1], edgeCenter[2]]).toEqual([255, 0, 0]);
    const oobPixel = magCtx.getImageData(0, 0, 1, 1).data;
    expect([oobPixel[0], oobPixel[1], oobPixel[2]]).toEqual([15, 31, 16]);

    // Does not intercept pointer drag selection
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5 });
    fireEvent.pointerMove(canvas, { clientX: 105, clientY: 105 });
    fireEvent.pointerUp(canvas, { clientX: 105, clientY: 105 });
    expect(screen.getByRole('button', { name: /clear selection/i })).toBeInTheDocument();

    // Switching back to Eyedropper clears magnifier
    await user.click(screen.getByRole('button', { name: /eyedropper/i }));
    expect(screen.queryByTestId('region-magnifier')).not.toBeInTheDocument();
  });
});
