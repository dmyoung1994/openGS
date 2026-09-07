const viewportStates = new WeakMap();

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
  const displayScale = benchmark ? Math.min(1, native.width / width, native.height / height) : 1;
  const metrics = benchmark ? { width, height, deviceScaleFactor: 1, mobile: false, scale: displayScale } : null;
  if (benchmark) {
    // Puppeteer must know the fixed viewport too, or screenshot() restores
    // native window metrics and silently resizes the running renderer.
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await client.send('Emulation.setDeviceMetricsOverride', metrics);
  }
  // Emulation belongs to this CDP session; detaching clears benchmark metrics.
  if (!benchmark) await client.detach();
  let state = viewportStates.get(page);
  if (!state) {
    state = {};
    const screenshot = page.screenshot.bind(page);
    // Chrome's surface capture resets display scaling without changing the CSS
    // viewport. Restore the fitted presentation after every capture, even failures.
    page.screenshot = async (...args) => {
      try { return await screenshot(...args); }
      finally {
        if (state.metrics && state.displayScale < 1) {
          // Identical metrics do not refresh Chrome's post-capture display
          // transform. A subpixel scale change forces restoration while
          // keeping CSS and renderer dimensions fixed throughout.
          await state.client.send('Emulation.setDeviceMetricsOverride', {
            ...state.metrics, scale: state.displayScale * (1 - 1e-6),
          });
          await state.client.send('Emulation.setDeviceMetricsOverride', state.metrics);
        }
      }
    };
    viewportStates.set(page, state);
  }
  Object.assign(state, { displayScale, client, metrics });
  return { screen, bounds, benchmark, renderViewport: benchmark ? { width, height } : native };
}

// CDP pointer coordinates use the scaled display, unlike DOM client rectangles.
// Use real mouse input at the element centre without changing benchmark pixels.
export async function clickBrowserElement(page, selector) {
  const point = await page.$eval(selector, element => {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Cannot click an invisible element.');
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const scale = viewportStates.get(page)?.displayScale ?? 1;
  await page.mouse.click(point.x * scale, point.y * scale);
}
