export interface SmartSelection {
  image: ImageData;
  mask: Uint8Array;
  count: number;
}

export const MAX_SMART_PIXELS = 1024 * 1024;

export function selectConnectedColors(
  image: ImageData,
  seeds: readonly number[],
  tolerance: number,
): SmartSelection {
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(mask.length);
  const queue = new Uint32Array(mask.length);
  const threshold = 3 * (tolerance * 2.55) ** 2;
  let size = 0;
  let count = 0;

  function addRegion(seed: number) {
    visited.fill(0);
    size = 0;
    const start = seed * 4;

    function enqueue(index: number) {
      if (visited[index]) return;
      visited[index] = 1;
      const offset = index * 4;
      const distance = (data[offset] - data[start]) ** 2
        + (data[offset + 1] - data[start + 1]) ** 2
        + (data[offset + 2] - data[start + 2]) ** 2;
      if (data[offset + 3] < 128 || distance > threshold) return;
      queue[size++] = index;
      if (!mask[index]) {
        mask[index] = 1;
        count++;
      }
    }

    enqueue(seed);
    for (let cursor = 0; cursor < size; cursor++) {
      const index = queue[cursor];
      const column = index % width;
      if (column > 0) enqueue(index - 1);
      if (column + 1 < width) enqueue(index + 1);
      if (index >= width) enqueue(index - width);
      if (index + width < mask.length) enqueue(index + width);
    }
  }

  for (const seed of seeds) addRegion(seed);
  if (count === mask.length) return { image, mask, count };

  // Mark unselected pixels that can reach the image border. Diagonal gaps
  // connect to the exterior, so a nearly closed selection cannot fill a hole.
  visited.fill(0);
  size = 0;
  function enqueueExterior(index: number) {
    if (mask[index] || visited[index]) return;
    visited[index] = 1;
    queue[size++] = index;
  }
  for (let column = 0; column < width; column++) {
    enqueueExterior(column);
    enqueueExterior((height - 1) * width + column);
  }
  for (let row = 1; row < height - 1; row++) {
    enqueueExterior(row * width);
    enqueueExterior((row + 1) * width - 1);
  }
  for (let cursor = 0; cursor < size; cursor++) {
    const index = queue[cursor];
    const column = index % width;
    const row = Math.floor(index / width);
    for (let y = Math.max(0, row - 1); y <= Math.min(height - 1, row + 1); y++) {
      for (let x = Math.max(0, column - 1); x <= Math.min(width - 1, column + 1); x++) {
        enqueueExterior(y * width + x);
      }
    }
  }
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !visited[i]) {
      mask[i] = 1;
      count++;
    }
  }

  return { image, mask, count };
}

export function paintSelection(canvas: HTMLCanvasElement, selection: SmartSelection) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = selection.image;
  const { mask } = selection;
  const overlay = ctx.createImageData(width, height);

  const pixels = overlay.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const column = i % width;
    const edge = column === 0 || column === width - 1
      || !mask[i - 1] || !mask[i + 1] || !mask[i - width] || !mask[i + width];
    const offset = i * 4;
    pixels[offset] = 198;
    pixels[offset + 1] = 241;
    pixels[offset + 2] = 157;
    pixels[offset + 3] = edge ? 245 : 54;
  }
  ctx.putImageData(overlay, 0, 0);
}
