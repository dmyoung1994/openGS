// Keep image decode, canvas readback and the 96 MiB array pack off the UI thread.
self.onmessage = async ({ data: { urls } }) => {
  try {
    if (!Array.isArray(urls) || urls.length !== 6) throw new Error('Six turf maps are required.');
    const blobs = await Promise.all(urls.map(async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Required turf texture failed to load: ${url} (${response.status})`);
      return response.blob();
    }));
    const width = 2048, height = 2048, layerBytes = width * height * 4;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Turf texture canvas is unavailable.');
    const packed = [0, 1].map(() => ({ data: new Uint8Array(layerBytes * 3), width, height, depth: 3 }));
    for (let index = 0; index < blobs.length; index++) {
      const bitmap = await createImageBitmap(blobs[index]);
      try {
        if (bitmap.width !== width || bitmap.height !== height) {
          throw new Error('Turf texture arrays require three authored 2048x2048 layers.');
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        packed[index % 2].data.set(context.getImageData(0, 0, width, height).data,
          Math.floor(index / 2) * layerBytes);
      } finally { bitmap.close(); }
    }
    self.postMessage({ packed }, packed.map(pack => pack.data.buffer));
  } catch (error) { self.postMessage({ error: error?.message || String(error) }); }
};
