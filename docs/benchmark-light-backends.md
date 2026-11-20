# Windows lighting benchmark

Windows 11 x64, 31.83 GiB system RAM, SSD, NVIDIA GeForce RTX 4080, driver 617.42. Run [benchmark-light-backends.mjs](../scripts/benchmark-light-backends.mjs) after building the native worker. Pass the local reference binary STL and generated near-limit binary STL as arguments. The script regenerates the two small fixtures itself.

Elapsed times include native processing, result file write and opening and reading the returned scores in the application process. Cold times start after importing the model. Repeat times change the light direction and reuse the acceleration structure. Both implementations return values indexed by original face ID.

| Fixture | Faces | Embree cold | DXR cold | Embree repeat | DXR repeat | Peak DXR dedicated |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Overhang | 4 | 2.7 ms | 276.2 ms | 1.1 ms | 1.3 ms | 83 MiB |
| Partition boundary | 2,205 | 12.2 ms | 232.6 ms | 4.9 ms | 5.3 ms | 83 MiB |
| Local reference | 8,766,580 | 2,219 ms | 1,517 ms | 496 ms | 76 ms | 1,005 MiB |
| Near 2 GiB generated torus | 42,946,560 | 9,198 ms | 6,472 ms | 1,049 ms | 258 ms | 4,594 MiB |

DXR cold setup, including upload and acceleration structure build, took 1,448 ms on the reference and 6,168 ms on the torus. Trace dispatch and readback took 6 ms and 28 ms on the reference on the first run, and 8 ms and 110 ms on the torus. DXGI reported a local budget of approximately 14.9 GiB.

The 35% and 75% committed cutoffs matched on all original face IDs in both small fixtures and the reference, and in the first torus direction. Two of 42,946,560 torus faces differed on the second direction. Across all supported integer cutoff values, the largest disagreement was five of 8,766,580 reference faces and three of 42,946,560 torus faces. The largest absolute exposure differences were 0.018 on the reference and 0.016 on the torus. These were the measurements after using double-precision centroid calculation in the shader.

Use DXR for scenes with eight million or more original faces, including assembled kits, when the hardware supports DXR 1.1, shader model 6.5, double-precision shader operations and sufficient local memory. Embree handles smaller scenes and GPU setup or execution failures. Simulated unsupported hardware, insufficient memory and GPU failure each returned the CPU benchmark masks. The renderer rejects completed exposure results from superseded light or assembly inputs.

The automatic backend selected DXR on this RTX 4080 for a 19-part assembly with 13,909,724 faces. The native cold run took 2.39 seconds on DXR and 2.58 seconds on Embree. DXR used about 1.51 GiB of dedicated memory and matched Embree's 32% midtone cutoff across the original faces.
