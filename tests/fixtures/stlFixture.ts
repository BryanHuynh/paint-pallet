import fs from 'node:fs';
import path from 'node:path';

export interface TriangleSpec {
  v1: [number, number, number];
  v2: [number, number, number];
  v3: [number, number, number];
  normal?: [number, number, number];
  attribute?: number;
}

/**
 * Writes a valid binary STL file from explicit triangle specs.
 */
export function writeBinaryStl(filePath: string, triangles: TriangleSpec[], headerText = 'Paint Pallet Fixture'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write(headerText.slice(0, 79), 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);

  let offset = 84;
  for (const tri of triangles) {
    const n = tri.normal ?? computeNormal(tri.v1, tri.v2, tri.v3);
    buffer.writeFloatLE(n[0], offset);
    buffer.writeFloatLE(n[1], offset + 4);
    buffer.writeFloatLE(n[2], offset + 8);
    buffer.writeFloatLE(tri.v1[0], offset + 12);
    buffer.writeFloatLE(tri.v1[1], offset + 16);
    buffer.writeFloatLE(tri.v1[2], offset + 20);
    buffer.writeFloatLE(tri.v2[0], offset + 24);
    buffer.writeFloatLE(tri.v2[1], offset + 28);
    buffer.writeFloatLE(tri.v2[2], offset + 32);
    buffer.writeFloatLE(tri.v3[0], offset + 36);
    buffer.writeFloatLE(tri.v3[1], offset + 40);
    buffer.writeFloatLE(tri.v3[2], offset + 44);
    buffer.writeUInt16LE(tri.attribute ?? 0, offset + 48);
    offset += 50;
  }

  fs.writeFileSync(filePath, buffer);
}

/**
 * Writes a deterministic grid of triangles for testing spatial batching, progress, and cancel.
 */
export function writeGridBinaryStl(filePath: string, triangleCount: number): void {
  const triangles: TriangleSpec[] = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(triangleCount / 2)));
  for (let i = 0; i < triangleCount; i++) {
    const cell = Math.floor(i / 2);
    const x = (cell % cols) * 1.0;
    const y = Math.floor(cell / cols) * 1.0;
    const z = (i % 5) * 0.1;
    if (i % 2 === 0) {
      triangles.push({
        v1: [x, y, z],
        v2: [x + 1, y, z],
        v3: [x, y + 1, z],
      });
    } else {
      triangles.push({
        v1: [x + 1, y, z],
        v2: [x + 1, y + 1, z],
        v3: [x, y + 1, z],
      });
    }
  }
  writeBinaryStl(filePath, triangles);
}

function computeNormal(
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number],
): [number, number, number] {
  const ux = v2[0] - v1[0];
  const uy = v2[1] - v1[1];
  const uz = v2[2] - v1[2];
  const vx = v3[0] - v1[0];
  const vy = v3[1] - v1[1];
  const vz = v3[2] - v1[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}
