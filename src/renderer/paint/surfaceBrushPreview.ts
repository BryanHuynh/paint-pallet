import * as THREE from 'three';

const DECLARATIONS = `
  uniform vec3 surfaceBrushFootprint;
  uniform vec2 surfaceBrushPixelScale;
`;

const DRAW_FOOTPRINT = `
  if (surfaceBrushFootprint.z > 0.0 && gl_FrontFacing) {
    vec2 brushOffset = (gl_FragCoord.xy - surfaceBrushFootprint.xy) / surfaceBrushPixelScale;
    float brushRadius = surfaceBrushFootprint.z;
    float brushDistance = length(brushOffset);
    float brushFill = 1.0 - smoothstep(brushRadius - 0.6, brushRadius + 0.5, brushDistance);
    float brushRim = brushFill * smoothstep(max(0.0, brushRadius - 2.2), brushRadius - 0.45, brushDistance);
    vec3 surfaceColor = gl_FragColor.rgb;
    vec3 brushTint = vec3(0.66, 0.93, 0.49);
    gl_FragColor.rgb = mix(surfaceColor, brushTint, 0.15 * brushFill + 0.55 * brushRim);
  }
`;

export class SurfaceBrushPreview {
  private footprint = { value: new THREE.Vector3() };
  private pixelScale = { value: new THREE.Vector2(1, 1) };
  private drawingBuffer = new THREE.Vector2();

  attach(material: THREE.Material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.surfaceBrushFootprint = this.footprint;
      shader.uniforms.surfaceBrushPixelScale = this.pixelScale;
      shader.fragmentShader = DECLARATIONS + shader.fragmentShader.replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\n' + DRAW_FOOTPRINT,
      );
    };
  }

  update(renderer: THREE.WebGLRenderer, pointer: { x: number; y: number } | null, diameter: number) {
    this.footprint.value.z = 0;
    if (!pointer) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const x = pointer.x - rect.left;
    const y = pointer.y - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;

    renderer.getDrawingBufferSize(this.drawingBuffer);
    const scale = this.pixelScale.value.set(
      this.drawingBuffer.x / rect.width,
      this.drawingBuffer.y / rect.height,
    );
    this.footprint.value.set(
      x * scale.x,
      (rect.height - y) * scale.y,
      Math.max(0.75, diameter / 2),
    );
  }
}
