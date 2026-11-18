# Paint Pallet

## Goal

Build an offline Windows app that turns a reference image and a 3D miniature into a printable painting guide. Support full-resolution binary STL files up to 2 GiB on a Windows 11 x64 PC with 32 GB RAM and SSD storage. The supplied acceptance model is 418 MiB and contains 8,766,580 triangles. Use it locally and use generated fixtures for automated tests.

## Painting workflow

- Import one PNG, JPEG, or WebP reference and one STL or OBJ. Sample a color with the eyedropper or suggest a shadow, midtone, and highlight from a selected rectangle or the whole image. Let the painter review and edit the hex swatches and add paint names, brands, and mix notes.
- Set the model's upright direction and front. Create named regions and link them to reusable color recipes. Brush or erase shadow coverage on the visible surface. Preview a connected bucket fill from a clicked face, adjust crease sensitivity, and confirm the result. Respect disconnected pieces, OBJ groups, and other region assignments. Support undo and redo.
- Rotate a directional light by azimuth and elevation. Evaluate exposure from surface angle and self-shadowing. Preview two ordered cutoffs, initially 35% and 75%. Commit and edit the cumulative masks. Adding highlights adds midtone coverage there, and erasing midtones clears highlights there.
- Create, name, and duplicate lighting snapshots. Each stores its own light, cutoffs, and committed masks. All snapshots share the palette, regions, and shadow coat. Confirm regeneration over brush edits and support undo.
- Export the active snapshot's committed masks to Letter or A4 PDF. Include the palette, paint notes, and a page for each paint pass with consistent front, back, left, and right orthographic views. Flag missing swatches or unapplied light changes before export.

## Geometry, rendering, and acceleration

- Use Electron, React, and Three.js for the desktop app and ship an x64 installer with Electron Forge. Bundle an x64 C++ geometry worker and expose bounded queries, progress, and cancellation to the renderer. Keep file access behind a narrow preload interface.
- Stream binary STL records with 64-bit offsets. Retain stable original face IDs and spatially partition the mesh into disk-backed batches. Match shared edges across partitions. Keep region and mask edits keyed by face ID so snapshots share geometry. Accept ASCII STL and geometry-only OBJ as well. The 2 GiB size target applies to binary STL.
- Use the GPU to draw the viewport, paint overlays, and offscreen PDF views. Use a lighter meshoptimizer preview while moving the camera and restore full-detail batches when it settles. Brush, bucket, mask generation, and PDF rendering use the original triangles.
- Implement full-resolution lighting in the native worker with Embree as the CPU reference and fallback. Evaluate surface angle and occlusion across partitions and cache exposure by mesh and light direction. Threshold-only changes reuse the cached scores.
- Evaluate D3D12 DirectX Raytracing for GPU occlusion on supported adapters. Test ray-tracing support and the available video memory budget before building acceleration structures. Commit results only when a full run completes for the current light revision. Use the same input geometry, exposure rules, and face IDs on both backends. Fall back to Embree if support or memory is insufficient, the GPU job fails, or the comparison fails validation. Keep GPU mask generation conditional on measured end-to-end gains.

## Portable projects

Save one versioned ZIP64 .paintproject archive containing the original model, reference, orientation, palette, regions, and snapshots. Keep derived geometry in a rebuildable local cache. Stream the archive to a temporary sibling file and replace the destination after a successful write. Preserve the current project if another import or save fails.

## Validation

- Start with large-mesh import and picking on the supplied STL. Verify all 8,766,580 faces remain addressable, brush and bucket work after camera movement, and fills and shadows cross partition boundaries. Verify edited masks appear in the PDF.
- Exercise a generated binary STL just under 2 GiB on 32 GB Windows hardware. Measure import time, UI responsiveness, peak process memory and disk use, mask generation, and PDF export. Verify cancellation cleans temporary data and the app stays responsive.
- For GPU lighting, compare committed masks on overhang and partition-boundary fixtures, the supplied STL, and the near-2 GiB fixture. Time initial setup and repeat light changes, including upload and readback. Record peak video memory use and adapter details. Verify CPU fallback for unsupported devices and insufficient GPU memory. GPU capabilities and timings on the user's PC are unverified.
- Test the packaged app offline, reopen a moved project after clearing its cache, and inspect both PDF paper sizes. Deliver an unsigned local installer unless signing credentials are available.

## Ticket impact

Add ticket 13, **Benchmark GPU light-mask generation**, blocked by ticket 06 for its CPU reference and mask interface. Ticket 12, **Package and verify the offline Windows release**, also depends on ticket 13 so release verification covers the benchmark decision and the CPU fallback.
