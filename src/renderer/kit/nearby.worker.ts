import { solveNearbyFit, type SnapInput } from './nearbyFit';

self.addEventListener('message', (event: MessageEvent<SnapInput>) => {
  self.postMessage(solveNearbyFit(event.data));
});
