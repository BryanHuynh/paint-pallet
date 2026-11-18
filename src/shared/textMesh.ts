import { ShapeUtils, Vector2 } from 'three';

export type TextMeshFormat = 'ascii-stl' | 'obj';
type Vertex = [number, number, number];
type Triangle = [Vertex, Vertex, Vertex];
type EmitTriangle = (triangle: Triangle, groupId: number) => void;

function coordinates(line: number, values: string[]): Vertex {
  const parts = values.slice(0, 3);
  if (parts.length !== 3 || parts.some((word) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(word))) {
    throw new Error(`Line ${line}: expected three numeric coordinates.`);
  }
  const vertex = parts.map((word) => Math.fround(Number(word))) as Vertex;
  if (vertex.some((axis) => !Number.isFinite(axis))) throw new Error(`Line ${line}: coordinate exceeds the mesh format range.`);
  return vertex;
}

function polygonTriangles(vertices: Vertex[], line: number): Triangle[] {
  if (vertices.length === 3) return [vertices as Triangle];
  const normal = [0, 0, 0];
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index];
    const b = vertices[(index + 1) % vertices.length];
    normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
    normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
    normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const dominant = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? 0 : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  if (!normal[dominant]) throw new Error(`Line ${line}: OBJ polygon has no usable surface.`);
  const plane = vertices.map((vertex) => new Vector2(vertex[(dominant + 1) % 3], vertex[(dominant + 2) % 3]));
  const indices = ShapeUtils.triangulateShape(plane, []);
  if (indices.length === 0) throw new Error(`Line ${line}: could not triangulate the OBJ polygon.`);
  return indices.map(([a, b, c]) => {
    const winding = (plane[b].x - plane[a].x) * (plane[c].y - plane[a].y)
      - (plane[b].y - plane[a].y) * (plane[c].x - plane[a].x);
    return winding * normal[dominant] > 0
      ? [vertices[a], vertices[b], vertices[c]]
      : [vertices[a], vertices[c], vertices[b]];
  });
}

export function looksLikeAsciiStl(prefix: string): boolean {
  return /^\s*solid(?:\s|$)/i.test(prefix) && !prefix.includes('\0');
}

export function createTextMeshParser(format: TextMeshFormat, emit: EmitTriangle) {
  const vertices: Vertex[] = [];
  const groups = new Map<string, number>();
  const groupNames: { object: string; groups: string[] }[] = [];
  let objectName = '';
  let groupSet: string[] = [];
  let groupId: number | undefined;
  let line = 0;
  let triangles = 0;
  let stlState: 'solid' | 'facet' | 'loop' | 'vertices' | 'endloop' | 'endfacet' = 'solid';
  let corners: Vertex[] = [];

  function write(triangle: Triangle, group: number) {
    emit(triangle, group);
    triangles++;
  }

  function parseStl(tokens: string[]) {
    const [command, qualifier, ...rest] = tokens;
    const keyword = command.toLowerCase();
    switch (stlState) {
      case 'solid':
        if (keyword === 'solid') { stlState = 'facet'; return; }
        break;
      case 'facet':
        if (keyword === 'endsolid') { stlState = 'solid'; return; }
        if (keyword === 'facet' && qualifier?.toLowerCase() === 'normal' && rest.length === 3) {
          coordinates(line, rest);
          stlState = 'loop';
          return;
        }
        break;
      case 'loop':
        if (keyword === 'outer' && qualifier?.toLowerCase() === 'loop') {
          corners = [];
          stlState = 'vertices';
          return;
        }
        break;
      case 'vertices':
        if (keyword === 'vertex' && tokens.length === 4) {
          corners.push(coordinates(line, tokens.slice(1)));
          if (corners.length === 3) stlState = 'endloop';
          return;
        }
        break;
      case 'endloop':
        if (keyword === 'endloop') { stlState = 'endfacet'; return; }
        break;
      case 'endfacet':
        if (keyword === 'endfacet') {
          write(corners as Triangle, 0);
          stlState = 'facet';
          return;
        }
        break;
    }
    throw new Error(`Line ${line}: malformed ASCII STL near "${command}".`);
  }

  function parseObj(tokens: string[]) {
    const [command, ...parts] = tokens;
    if (command === 'v') {
      vertices.push(coordinates(line, parts));
    } else if (command === 'g' || command === 'o') {
      if (command === 'o') objectName = parts.join(' ');
      else groupSet = [...new Set(parts)].sort();
      groupId = undefined;
    } else if (command === 'f') {
      const polygon = parts.map((part) => {
        const raw = part.split('/')[0];
        const id = Number(raw);
        const index = id > 0 ? id - 1 : vertices.length + id;
        if (!/^[+-]?\d+$/.test(raw) || !id || !Number.isSafeInteger(id) || index < 0 || index >= vertices.length) {
          throw new Error(`Line ${line}: OBJ face references invalid vertex "${raw}".`);
        }
        return vertices[index];
      });
      if (polygon.length > 3 && polygon.at(-1) === polygon[0]) polygon.pop();
      if (polygon.length < 3) throw new Error(`Line ${line}: OBJ face needs at least three vertices.`);

      if (groupId === undefined) {
        const key = JSON.stringify([objectName, groupSet]);
        groupId = groups.get(key);
        if (groupId === undefined) {
          groupId = groups.size;
          groups.set(key, groupId);
          groupNames.push({ object: objectName, groups: groupSet });
        }
      }
      for (const triangle of polygonTriangles(polygon, line)) write(triangle, groupId);
    }
  }

  return {
    push(text: string) {
      line++;
      const content = (format === 'obj' ? text.split('#', 1)[0] : text).trim();
      if (!content) return;
      const tokens = content.split(/\s+/);
      if (format === 'obj') parseObj(tokens);
      else parseStl(tokens);
    },
    finish() {
      if (format === 'ascii-stl' && stlState !== 'solid') throw new Error(`Line ${line}: ASCII STL ended before "endsolid".`);
      if (triangles === 0) throw new Error('The model has no triangles to import.');
      return { triangles, groupNames };
    },
  };
}
