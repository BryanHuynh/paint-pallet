/// <reference types="vite/client" />
import type { PaintPalletApi } from '../shared/workerProtocol';

declare global {
  interface Window {
    paintPallet?: PaintPalletApi;
  }
}
