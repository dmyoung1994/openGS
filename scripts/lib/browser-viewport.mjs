// Keep the visible Chrome window on-screen while preserving benchmark pixels.
export async function fitBrowserViewport(page, width, height, { benchmark = false } = {}) {
  const screen = await page.evaluate(() => ({
    left: window.screen.availLeft, top: window.screen.availTop,
    width: window.screen.availWidth, height: window.screen.availHeight,
  }));
  const client = await page.createCDPSession();
  const { windowId } = await client.send('Browser.getWindowForTarget');
  const bounds = {
    left: screen.left + 8, top: screen.top + 8,
    width: Math.min(width + 16, screen.width - 16),
    height: Math.min(height + 95, screen.height - 16), windowState: 'normal',
  };
  await client.send('Browser.setWindowBounds', { windowId, bounds });
  await page.setViewport(null);
  await client.send('Emulation.clearDeviceMetricsOverride');
  const native = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (benchmark) {
    // Puppeteer must know the fixed viewport too, or screenshot() restores
    // native window metrics and silently resizes the running renderer.
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
      scale: Math.min(1, native.width / width, native.height / height),
    });
  }
  // Emulation belongs to this CDP session; detaching clears benchmark metrics.
  if (!benchmark) await client.detach();
  return { screen, bounds, benchmark, renderViewport: benchmark ? { width, height } : native };
}
