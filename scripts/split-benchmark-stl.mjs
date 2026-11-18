import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const [input, destination, count = '4'] = process.argv.slice(2);
const parts = Number(count);
if (!input || !destination || !Number.isInteger(parts) || parts < 2) {
  throw new Error('Usage: node scripts/split-benchmark-stl.mjs input.stl output-folder [part-count]');
}
const source = await open(input, 'r');
const header = Buffer.alloc(84);
try {
  await source.read(header, 0, header.length, 0);
} finally {
  await source.close();
}
const triangles = header.readUInt32LE(80);
if (!triangles || triangles < parts || (await stat(input)).size !== 84 + triangles * 50 ||
    84 * parts + triangles * 50 > 2 * 1024 ** 3) {
  throw new Error('The input is not a complete binary STL that fits the project limit after splitting.');
}

await mkdir(destination, { recursive: true });
let from = 0;
for (let part = 0; part < parts; part++) {
  const next = Math.floor((part + 1) * triangles / parts);
  const target = path.join(destination, 'benchmark-part-' + (part + 1) + '.stl');
  const handle = await open(target, 'wx');
  try {
    header.writeUInt32LE(next - from, 80);
    await handle.write(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  await pipeline(createReadStream(input, { start: 84 + 50 * from, end: 84 + 50 * next - 1 }),
    createWriteStream(target, { flags: 'r+', start: 84 }));
  from = next;
}
console.log(JSON.stringify({ parts, triangles, bytes: 84 * parts + triangles * 50 }));
