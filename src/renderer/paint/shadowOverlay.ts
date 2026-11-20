import * as THREE from 'three';
import { toneColorKey, type LightTonePreview } from './lightingState';
import type { ShadowHit } from './shadowPaint';

const PALETTE_WIDTH = 256;
const MAX_PALETTE_COLORS = 65536;
const FALLBACK_COLOR = '#2b303a';

const cutoffStorage = new Float32Array(1);
const cutoffBits = new Uint32Array(cutoffStorage.buffer);
function floatCutoff(percent: number) {
  const cutoff = percent / 100;
  cutoffStorage[0] = cutoff;
  if (cutoffStorage[0] < cutoff) cutoffBits[0]++;
  return cutoffStorage[0];
}

export class PaintOverlayStyle {
  private pixels = new Float32Array(PALETTE_WIDTH * 4);
  private texture = { value: this.createTexture() };
  private paletteHeight = { value: 1 };
  private thresholds = { value: new THREE.Vector3() };
  private indices = new Map<string, number>();
  private displayed = new Map<string, string>();
  private color = new THREE.Color();
  private nextIndex = 1;

  constructor() {
    this.writeColor(0, FALLBACK_COLOR);
  }

  private createTexture() {
    return new THREE.DataTexture(this.pixels, PALETTE_WIDTH, this.pixels.length / (PALETTE_WIDTH * 4),
      THREE.RGBAFormat, THREE.FloatType);
  }

  private writeColor(index: number, hex: string) {
    if (index * 4 >= this.pixels.length) {
      const expanded = new Float32Array(this.pixels.length * 2);
      expanded.set(this.pixels);
      this.pixels = expanded;
      this.texture.value.dispose();
      this.texture.value = this.createTexture();
      this.paletteHeight.value = this.pixels.length / (PALETTE_WIDTH * 4);
    }
    this.color.set(hex).toArray(this.pixels, index * 4);
    this.pixels[index * 4 + 3] = 1;
    this.texture.value.needsUpdate = true;
  }

  indexFor(key: string) {
    let index = this.indices.get(key);
    if (index === undefined) {
      if (this.nextIndex >= MAX_PALETTE_COLORS) return 0;
      index = this.nextIndex++;
      this.indices.set(key, index);
      this.writeColor(index, FALLBACK_COLOR);
    }
    return index;
  }

  setColors(colors: ReadonlyMap<string, string>) {
    for (const key of this.displayed.keys()) {
      if (!colors.has(key)) this.writeColor(this.indexFor(key), FALLBACK_COLOR);
    }
    for (const [key, hex] of colors) {
      if (this.displayed.get(key) !== hex) this.writeColor(this.indexFor(key), hex);
    }
    this.displayed = new Map(colors);
  }

  setPreview(preview: LightTonePreview | null | undefined) {
    if (preview) {
      this.thresholds.value.set(floatCutoff(preview.midtone), floatCutoff(preview.highlight), 1);
    } else {
      this.thresholds.value.z = 0;
    }
  }

  attach(material: THREE.MeshBasicMaterial) {
    const beforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      beforeCompile.call(material, shader, renderer);
      shader.uniforms.paintPalette = this.texture;
      shader.uniforms.paintPaletteHeight = this.paletteHeight;
      shader.uniforms.paintThresholds = this.thresholds;
      shader.vertexShader = `
        uniform sampler2D paintPalette;
        uniform float paintPaletteHeight;
        uniform vec3 paintThresholds;
        attribute vec4 paintIndices;
        attribute float paintExposure;
        varying vec3 viewPaintColor;
      ` + shader.vertexShader.replace('#include <color_vertex>', `
        #include <color_vertex>
        float paintSlot = paintIndices.x;
        if (paintThresholds.z > 0.0) {
          paintSlot = paintIndices.y;
          if (paintExposure > 0.0 && paintExposure >= paintThresholds.x) {
            paintSlot = paintExposure >= paintThresholds.y ? paintIndices.w : paintIndices.z;
          }
        }
        vec2 swatch = vec2((mod(paintSlot, ${PALETTE_WIDTH}.0) + 0.5) / ${PALETTE_WIDTH}.0,
          (floor(paintSlot / ${PALETTE_WIDTH}.0) + 0.5) / paintPaletteHeight);
        viewPaintColor = texture2D(paintPalette, swatch).rgb;
      `);
      shader.fragmentShader = 'varying vec3 viewPaintColor;\n' + shader.fragmentShader.replace('#include <color_fragment>',
        '#include <color_fragment>\n diffuseColor.rgb *= viewPaintColor;');
    };
  }

  dispose() {
    this.texture.value.dispose();
  }
}

export interface ShadowOverlayContext {
  material: THREE.MeshBasicMaterial;
  style: PaintOverlayStyle;
  hits?: ReadonlyMap<number, ShadowHit>;
  baseHits?: ReadonlyMap<number, ShadowHit>;
  scores?: Float32Array;
  faceOffset?: number;
}

interface PaintOverlayData {
  hits: ShadowOverlayContext['hits'];
  baseHits: ShadowOverlayContext['baseHits'];
  faceOffset: number;
  paintedIds: Uint32Array;
  scores?: Float32Array;
}

function updateExposure(overlay: THREE.Mesh, data: PaintOverlayData, scores?: Float32Array) {
  if (!scores || data.scores === scores) return;
  const exposure = overlay.geometry.getAttribute('paintExposure') as THREE.BufferAttribute;
  const values = exposure.array as Float32Array;
  for (let index = 0; index < data.paintedIds.length; index++) {
    const score = scores[data.paintedIds[index]] ?? 0;
    const start = index * 3;
    values[start] = values[start + 1] = values[start + 2] = score;
  }
  exposure.needsUpdate = true;
  data.scores = scores;
}

export function setShadowOverlay(
  mesh: THREE.Mesh,
  faceIds: Uint32Array,
  { material, style, hits, baseHits, scores, faceOffset = 0 }: ShadowOverlayContext,
) {
  const previous = mesh.children[0] as THREE.Mesh | undefined;
  const last = previous?.userData as PaintOverlayData | undefined;
  if (previous && last && last.hits === hits && last.baseHits === baseHits && last.faceOffset === faceOffset) {
    updateExposure(previous, last, scores);
    return;
  }
  if (previous) {
    mesh.remove(previous);
    previous.geometry.dispose();
  }
  if (!hits?.size) return;

  const source = mesh.geometry.getAttribute('position').array as Float32Array;
  const positions = new Float32Array(hits.size * 9);
  const paletteIndices = new Uint16Array(hits.size * 12);
  const paintedIds = new Uint32Array(hits.size);
  const slotsByColor = new Map<string, number[]>();
  let count = 0;
  for (const hit of hits.values()) {
    if (faceIds[hit.triangleIndex] + faceOffset !== hit.faceId) continue;
    const start = hit.triangleIndex * 9;
    positions.set(source.subarray(start, start + 9), count * 9);
    let slots = slotsByColor.get(hit.recipeId);
    if (!slots) {
      const base = baseHits?.get(hit.faceId)?.recipeId;
      const current = style.indexFor(hit.recipeId);
      slots = [current, current, current, current];
      if (base && (hit.recipeId === base || hit.recipeId === toneColorKey(base, 'midtone') || hit.recipeId === toneColorKey(base, 'highlight'))) {
        slots[1] = style.indexFor(base);
        slots[2] = style.indexFor(toneColorKey(base, 'midtone'));
        slots[3] = style.indexFor(toneColorKey(base, 'highlight'));
      }
      slotsByColor.set(hit.recipeId, slots);
    }
    for (let vertex = 0; vertex < 3; vertex++) paletteIndices.set(slots, count * 12 + vertex * 4);
    paintedIds[count++] = hit.faceId;
  }
  if (!count) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, count * 9), 3));
  geometry.setAttribute('paintIndices', new THREE.BufferAttribute(paletteIndices.subarray(0, count * 12), 4));
  geometry.setAttribute('paintExposure', new THREE.BufferAttribute(new Float32Array(count * 3), 1));
  const overlay = new THREE.Mesh(geometry, material);
  const data = { hits, baseHits, faceOffset, paintedIds: paintedIds.subarray(0, count) };
  overlay.userData = data;
  updateExposure(overlay, data, scores);
  overlay.renderOrder = 1;
  mesh.add(overlay);
}

export function disposeDetailMesh(mesh: THREE.Mesh) {
  for (const child of mesh.children) {
    if (child instanceof THREE.Mesh) child.geometry.dispose();
  }
  mesh.geometry.dispose();
}
