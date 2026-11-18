import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { FileHandle } from 'node:fs/promises';
import { createTextMeshParser, looksLikeAsciiStl, type TextMeshFormat } from '../shared/textMesh';

const HEADER_BYTES = 84;
const TRIANGLE_BYTES = 50;
const MAX_STL_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_FACES = 4096;

interface PreparedMesh {
  filePath: string;
  sourceName?: string;
  sourceBytes?: number;
  sourceGroups?: string;
  sourceGroupNames?: string;
  cleanup?: () => Promise<void>;
}

async function writeAll(file: FileHandle, bytes: Buffer, position: number | null = null) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(
      bytes, offset, bytes.byteLength - offset, position === null ? null : position + offset,
    );
    if (!bytesWritten) throw new Error('Could not write the converted mesh.');
    offset += bytesWritten;
  }
}

async function convertTextMesh(
  source: string,
  format: TextMeshFormat,
  cacheDir: string,
  sourceBytes: number,
  signal: AbortSignal,
): Promise<PreparedMesh> {
  const scratch = await fs.promises.mkdtemp(path.join(cacheDir, 'source-'));
  const cleanup = async () => {
    const relative = path.relative(cacheDir, scratch);
    if (/^source-[a-zA-Z0-9]+$/.test(relative)) await fs.promises.rm(scratch, { recursive: true, force: true });
  };
  const filePath = path.join(scratch, 'mesh.stl');
  const sourceGroups = format === 'obj' ? path.join(scratch, 'groups.bin') : undefined;
  const sourceGroupNames = sourceGroups ? path.join(scratch, 'groups.json') : undefined;
  let meshFile: FileHandle | undefined;
  let groupsFile: FileHandle | undefined;
  let complete = false;

  try {
    meshFile = await fs.promises.open(filePath, 'wx');
    if (sourceGroups) groupsFile = await fs.promises.open(sourceGroups, 'wx');
    await writeAll(meshFile, Buffer.alloc(HEADER_BYTES));

    let meshChunk = Buffer.alloc(CHUNK_FACES * TRIANGLE_BYTES);
    let groupChunk = groupsFile ? Buffer.alloc(CHUNK_FACES * 4) : undefined;
    let position = 0;
    let faceCount = 0;
    const buffered: { mesh: Buffer; groups?: Buffer }[] = [];
    const queueChunk = () => {
      if (!position) return;
      buffered.push({
        mesh: meshChunk.subarray(0, position * TRIANGLE_BYTES),
        groups: groupChunk?.subarray(0, position * 4),
      });
      meshChunk = Buffer.alloc(CHUNK_FACES * TRIANGLE_BYTES);
      if (groupsFile) groupChunk = Buffer.alloc(CHUNK_FACES * 4);
      position = 0;
    };
    const parser = createTextMeshParser(format, (triangle, group) => {
      if (HEADER_BYTES + (++faceCount) * TRIANGLE_BYTES > MAX_STL_BYTES) {
        throw new Error('Converted mesh exceeds the 2 GiB binary size limit.');
      }
      const start = position * TRIANGLE_BYTES + 12;
      for (let vertex = 0; vertex < 3; vertex++) {
        for (let axis = 0; axis < 3; axis++) {
          meshChunk.writeFloatLE(triangle[vertex][axis], start + (vertex * 3 + axis) * 4);
        }
      }
      groupChunk?.writeUInt32LE(group, position * 4);
      if (++position === CHUNK_FACES) queueChunk();
    });
    const flush = async () => {
      for (const chunk of buffered) {
        signal.throwIfAborted();
        await writeAll(meshFile!, chunk.mesh);
        if (groupsFile && chunk.groups) await writeAll(groupsFile, chunk.groups);
      }
      buffered.length = 0;
    };

    const input = fs.createReadStream(source, { encoding: 'utf8', signal });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        signal.throwIfAborted();
        parser.push(line);
        if (buffered.length) await flush();
      }
    } finally {
      lines.close();
      input.destroy();
    }

    const parsed = parser.finish();
    queueChunk();
    await flush();
    const headerCount = Buffer.alloc(4);
    headerCount.writeUInt32LE(parsed.triangles);
    await writeAll(meshFile, headerCount, 80);
    if (sourceGroupNames) await fs.promises.writeFile(sourceGroupNames, JSON.stringify(parsed.groupNames), { signal });
    signal.throwIfAborted();
    complete = true;
    return { filePath, sourceName: path.basename(source), sourceBytes, sourceGroups, sourceGroupNames, cleanup };
  } finally {
    try {
      await Promise.all([meshFile?.close(), groupsFile?.close()]);
    } finally {
      if (!complete) await cleanup();
    }
  }
}

export async function prepareMeshSource(filePath: string, cacheDir: string, signal: AbortSignal): Promise<PreparedMesh> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.stl' && extension !== '.obj') throw new Error('Choose an STL or OBJ model.');
  const stat = await fs.promises.stat(filePath).catch(() => {
    throw new Error(`Could not open model file: ${filePath}`);
  });
  if (!stat.isFile()) throw new Error(`Model path is not a regular file: ${filePath}`);
  if (stat.size > MAX_STL_BYTES) throw new Error('Model file exceeds 2 GiB limit');
  signal.throwIfAborted();

  if (extension === '.obj') return convertTextMesh(filePath, 'obj', cacheDir, stat.size, signal);

  const file = await fs.promises.open(filePath, 'r');
  const header = Buffer.alloc(512);
  let read: number;
  try {
    read = (await file.read(header, 0, header.byteLength, 0)).bytesRead;
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  const triangleCount = read >= HEADER_BYTES ? header.readUInt32LE(80) : 0;
  const expectedSize = HEADER_BYTES + triangleCount * TRIANGLE_BYTES;
  if (triangleCount > 0 && expectedSize === stat.size) return { filePath, sourceBytes: stat.size };
  if (looksLikeAsciiStl(header.toString('utf8', 0, read))) {
    return convertTextMesh(filePath, 'ascii-stl', cacheDir, stat.size, signal);
  }

  if (read < HEADER_BYTES) throw new Error('Malformed STL: file is smaller than 84-byte binary STL header');
  if (triangleCount === 0) throw new Error('Malformed STL: triangle count is 0');
  throw new Error(`Truncated or malformed binary STL: expected ${expectedSize} bytes for ${triangleCount} triangles, got ${stat.size} bytes`);
}
