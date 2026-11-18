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
  registry: Map<string, FixtureBitmap>,
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
  const registry = new Map<string, FixtureBitmap>();
  const urlToBitmap = new Map<string, FixtureBitmap>();
  const canvasBuffers = new WeakMap<HTMLCanvasElement, FixtureBitmap>();
  let urlCounter = 0;

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      const key = (blob as File & { __fixtureKey?: string }).__fixtureKey;
      const url = `blob:fixture-${++urlCounter}`;
      if (key && registry.has(key)) {
        urlToBitmap.set(url, registry.get(key)!);
      }
      return url;
    },
    revokeObjectURL: (url: string) => {
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
      const bitmap = urlToBitmap.get(value);
      queueMicrotask(() => {
        if (!bitmap) {
          this.onerror?.();
          return;
        }
        this.naturalWidth = bitmap.width;
        this.naturalHeight = bitmap.height;
        this.width = bitmap.width;
        this.height = bitmap.height;
        this.__bitmap = bitmap;
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
    return {
      clearRect: () => {},
      drawImage: (img: unknown) => {
        const bitmap = (img as { __bitmap?: FixtureBitmap }).__bitmap;
        if (bitmap) {
          canvasBuffers.set(canvas, {
            width: bitmap.width,
            height: bitmap.height,
            data: new Uint8ClampedArray(bitmap.data),
          });
        }
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

  return { registry };
}

describe('PaletteWorkspace', () => {
  let registry: Map<string, FixtureBitmap>;

  beforeEach(() => {
    ({ registry } = installCanvasAndImageHarness());
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
});
