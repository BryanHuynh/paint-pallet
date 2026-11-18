# Offline Windows release verification

The Electron Forge x64 Squirrel installer installs the app and native worker locally. This build is unsigned. The installer embeds the package and bundles the Embree runtime and compiled DXR shader.

The stress run used Windows 11 Pro build 26200, 31.83 GiB system RAM, an SSD and an RTX 4080. The installed renderer ran with network access disabled. The binary STL torus contained 42,946,560 faces. The multipart fixture split those same faces into four binary STL sources with a combined size just below 2 GiB.

| Installed-app check | Single STL | Four-part STL kit |
| --- | ---: | ---: |
| Original source bytes | 2,147,328,084 | 2,147,328,336 |
| Import and initial display | 13.36 s | 14.73 s |
| Import frame time, 95th percentile | 16.8 ms | 16.8 ms |
| Orbit frame time, 95th percentile | 16.7 ms | 16.8 ms |
| Light preview and apply | 5.19 s | 7.10 s |
| Guide preview and PDF export | 26.52 s | 29.47 s |
| Peak sampled native worker working set | 508 MiB | 6,488 MiB |
| Peak sampled combined working set | 6,048 MiB | 10,175 MiB |
| Derived geometry cache | 3,269,589,504 bytes | 3,271,780,912 bytes |

Import ends when the selected model or staged kit is available in the UI. The multipart light request includes all four attached sources. The assembly test attaches parts at their authored positions, paints an original surface and exports the matching view plus the installation sequence. The single model uses the automatic DXR path available on the test machine. The working-set figures sample the Electron processes, including Chromium's GPU process, and the native worker. Dedicated DXR allocation is reported separately in [the lighting benchmark](benchmark-light-backends.md).

Both workflows successfully canceled a replacement import after export. The prior models remained open and the canceled jobs left no extra mesh-cache entries. The rasterized PDF pages had the recipe table and three paint-pass pages. The assembly PDF also had the numbered install page.

Reproduce the runs with [benchmark-release.mjs](../scripts/benchmark-release.mjs) and the installed executable. [split-benchmark-stl.mjs](../scripts/split-benchmark-stl.mjs) takes a generated near-limit binary STL and creates the matching multipart stress fixture.

## Local acceptance runs

- The installed app sampled two images into one recipe, painted while the pointer was held down, filled an original connected surface, applied and manually edited lighting, duplicated a snapshot and kept its edge band during regeneration. A moved archive reopened in a fresh profile after its test input copies were removed. The active reference, both swatches, named regions, snapshots and edge coverage were present.
- The reference guide printed to PDF at Letter and A4. Both had the recipe table, numbered callouts, four matched views per pass and the edge pass. Proofs were rasterized and checked for alignment and legibility.
- The supplied kit contained 36 separate files totaling 1,232,342,024 bytes. The installed app made 32 attachments, including a nearby fit for the deliberately shifted base top, and kept three alternatives staged. It isolated and painted the head with assembled lighting, reopened the portable kit, and produced a 15-page A4 guide with the edited installation order, 32 marked steps, notes and three isolated head passes.
- The rectangular six-face fixture verified seating adjustment, staged and attached status, undo and redo, and restoration after removing the fixture sources. Separate tests covered cross-part occlusion, descendant motion, stale light masks, and rejecting competing or distant snap candidates.
- The five-page reference guide ran through the Windows Microsoft Print to PDF queue at both paper sizes. All five pages stayed within the page bounds. Physical printing and painting at a bench remain unverified.
