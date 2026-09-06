import { bakeZoneMap } from './ZoneMap.js';

self.onmessage = ({ data: { zones, bounds } }) => {
  try {
    const packed = bakeZoneMap(zones, bounds);
    self.postMessage({ packed }, [...new Set(Object.values(packed)
      .filter(value => ArrayBuffer.isView(value)).map(value => value.buffer))]);
  } catch (error) {
    self.postMessage({ error: error?.message || String(error) });
  }
};
