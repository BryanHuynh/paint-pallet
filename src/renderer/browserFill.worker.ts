import type { ConnectedFillRequest } from '../shared/workerProtocol';

export type BrowserFillMessage =
  | { type: 'mesh'; positions: Float32Array; normals: Float32Array; groups?: Uint32Array }
  | { type: 'fill'; request: ConnectedFillRequest };

export type BrowserFillResponse =
  | { jobId: string; faces: Uint32Array }
  | { jobId: string; error: string };

const NO_NEIGHBOR = 0xffffffff;
let neighbors: Uint32Array | undefined;
let normals: Float32Array | undefined;
let meshError: string | undefined;

function buildNeighbors(positions: Float32Array, faceNormals: Float32Array, groups?: Uint32Array): Uint32Array {
  const numVertices = positions.length / 3;
  const vertices = new Map<string, number>();
  const vertexIds = new Uint32Array(numVertices);
  for (let vertex = 0; vertex < numVertices; vertex++) {
    const offset = vertex * 3;
    const key = `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
    let index = vertices.get(key);
    if (index === undefined) {
      index = vertices.size;
      vertices.set(key, index);
    }
    vertexIds[vertex] = index;
  }

  const adjacency = new Uint32Array(numVertices).fill(NO_NEIGHBOR);
  const facesByGroup = new Map<number, Map<number, number>>();
  const distinctVertices = vertices.size;
  for (let offset = 0; offset < numVertices; offset += 3) {
    const normalOffset = offset * 3;
    if (faceNormals[normalOffset] === 0 && faceNormals[normalOffset + 1] === 0 && faceNormals[normalOffset + 2] === 0) continue;

    const group = groups?.[offset / 3] ?? 0;
    let edges = facesByGroup.get(group);
    if (!edges) {
      edges = new Map();
      facesByGroup.set(group, edges);
    }
    for (let side = 0; side < 3; side++) {
      const a = vertexIds[offset + side];
      const b = vertexIds[offset + (side + 1) % 3];
      const key = Math.min(a, b) * distinctVertices + Math.max(a, b);
      const slot = offset + side;
      const first = edges.get(key);
      if (first === undefined) {
        edges.set(key, slot);
      } else if (first >= 0) {
        const second = adjacency[first];
        if (second === NO_NEIGHBOR) {
          adjacency[first] = slot;
          adjacency[slot] = first;
        } else {
          // Ambiguous edges isolate all incident triangles.
          adjacency[first] = NO_NEIGHBOR;
          adjacency[second] = NO_NEIGHBOR;
          edges.set(key, -1);
        }
      }
    }
  }
  return adjacency;
}

function grow(request: ConnectedFillRequest): Uint32Array {
  if (!neighbors || !normals) throw new Error(meshError ?? 'Original mesh geometry is unavailable.');
  const triangleCount = neighbors.length / 3;
  const { faceId, maxCreaseDegrees, blockedFaces } = request;
  if (!Number.isInteger(faceId) || faceId < 0 || faceId >= triangleCount) throw new Error('The fill seed is unavailable.');
  const minimumDot = Math.cos(maxCreaseDegrees * Math.PI / 180);
  const excluded = new Uint8Array(triangleCount);
  for (const face of blockedFaces) excluded[face] = 1;
  if (excluded[faceId]) return new Uint32Array(0);

  const queue = new Uint32Array(triangleCount);
  queue[0] = faceId;
  excluded[faceId] = 1;
  let count = 1;
  for (let cursor = 0; cursor < count; cursor++) {
    const face = queue[cursor];
    const normal = face * 9;
    for (let side = 0; side < 3; side++) {
      const slot = neighbors[face * 3 + side];
      if (slot === NO_NEIGHBOR) continue;
      const adjacent = Math.floor(slot / 3);
      if (excluded[adjacent]) continue;
      const other = adjacent * 9;
      const dot = normals[normal] * normals[other] + normals[normal + 1] * normals[other + 1] + normals[normal + 2] * normals[other + 2];
      if (dot + 1e-6 < minimumDot) continue;

      excluded[adjacent] = 1;
      queue[count++] = adjacent;
    }
  }
  const packed = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    packed[i * 3] = queue[i];
    packed[i * 3 + 2] = queue[i];
  }
  return packed;
}

self.onmessage = (event: MessageEvent<BrowserFillMessage>) => {
  const message = event.data;
  if (message.type === 'mesh') {
    try {
      neighbors = buildNeighbors(message.positions, message.normals, message.groups);
      normals = message.normals;
    } catch (error) {
      meshError = error instanceof Error ? error.message : 'Could not index the mesh.';
    }
    return;
  }

  const jobId = message.request.jobId;
  let response: BrowserFillResponse;
  try {
    const faces = grow(message.request);
    response = { jobId, faces };
    self.postMessage(response, { transfer: [faces.buffer] });
  } catch (error) {
    response = { jobId, error: error instanceof Error ? error.message : 'Could not preview the connected fill.' };
    self.postMessage(response);
  }
};
