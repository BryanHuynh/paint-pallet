import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import fs from 'node:fs';

const workerBinaryPath = path.resolve(__dirname, 'native/build/paint_pallet_worker.exe');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: fs.existsSync(workerBinaryPath) ? [workerBinaryPath] : [],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({ name: 'PaintPallet' }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
