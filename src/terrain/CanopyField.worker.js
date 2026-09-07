import { bakeDenseCanopyMask } from './CanopyField.js';

self.onmessage = ({ data: { fields, placements } }) => {
  try {
    const result = fields.map(({ data, nx, nz, grid }) => bakeDenseCanopyMask(data, nx, nz, grid, placements));
    self.postMessage({ fields: result }, result.map(data => data.buffer));
  } catch (error) {
    self.postMessage({ error: error?.message || String(error) });
  }
};
