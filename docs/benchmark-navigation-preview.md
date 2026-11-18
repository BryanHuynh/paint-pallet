# Navigation preview benchmark

Measured on November 18, 2026, on the Windows 11 x64 reference host with 32 GiB RAM and its hardware-accelerated Electron viewport. The native importer welds its streamed preview into spatial clusters and passes the indexed result to meshoptimizer 1.3. Original detail and face IDs come from the disk-backed batches.

| Fixture | Original faces | Bytes | Import and commit | Orbit median / p95 frame | First original-detail frame after release | Peak working set by process type |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Local reference STL | 8,766,580 | 438,329,084 | 4,284 ms | 16.7 / 16.8 ms | 1,899 ms | Browser 188 MiB, GPU 582 MiB, utility 48 MiB, renderer 1,658 MiB |
| Generated torus | 42,946,560 | 2,147,328,084 | 15,741 ms | 16.7 / 16.8 ms | 1,893 ms | Browser 176 MiB, GPU 647 MiB, utility 48 MiB, renderer 1,896 MiB |

The generated torus has 5,120 segments around the major circle and 4,194 around the tube, with radii 60 and 28. Each cell contributes two triangles to the binary STL. The preview benchmark samples animation frames during a discrete scripted orbit. The restore time includes camera damping and loading the first set of original batches. Working-set peaks are sampled independently per Electron process type and exclude the native worker. These measurements describe the tested models and camera motion.

Run the benchmark against a freshly packaged Windows executable and two local fixtures.

```powershell
node scripts/benchmark-preview.mjs <packaged-exe> <reference-stl> <near-2-gib-stl>
```

The WebGL integration test also verifies that original face IDs remain pickable on the head and base of a dense model after orbiting.
