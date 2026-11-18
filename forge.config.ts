import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';
import fs from 'node:fs';

export const WORKER_BINARY_PATH = path.resolve(
  __dirname,
  'native/build/paint_pallet_worker.exe',
);

export const APP_ICON_BASE_PATH = path.resolve(
  __dirname,
  'assets/paint-pallet-logo',
);
export const APP_ICON_ICO_PATH = `${APP_ICON_BASE_PATH}.ico`;
export const APP_ICON_PNG_PATH = `${APP_ICON_BASE_PATH}.png`;

export function assertWorkerBinaryPresent(workerPath = WORKER_BINARY_PATH): string {
  if (!fs.existsSync(workerPath)) {
    throw new Error(
      `Missing required x64 native worker binary at ${workerPath}. Run "npm run build:worker" before packaging.`,
    );
  }
  return workerPath;
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: APP_ICON_BASE_PATH,
    extraResource: [
      WORKER_BINARY_PATH,
      ...['embree4.dll', 'tbb12.dll', 'tbbmalloc.dll', 'embree-notices'].map(
        (name) => path.join(path.dirname(WORKER_BINARY_PATH), name),
      ),
      path.resolve(__dirname, 'native/vendor/meshoptimizer/meshoptimizer-LICENSE.md'),
      APP_ICON_ICO_PATH,
      APP_ICON_PNG_PATH,
    ],
  },
  hooks: {
    prePackage: async () => {
      assertWorkerBinaryPresent();
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'PaintPallet',
      setupIcon: APP_ICON_ICO_PATH,
    }),
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
