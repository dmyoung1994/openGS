import { WebGPUBackend } from 'three/webgpu';
import { selectEnvironmentDeviceTier, environmentTierSnapshot } from './EnvironmentDeviceTier.js';

const SOFTWARE_ADAPTER = /swiftshader|software|llvmpipe|lavapipe/i;

// Three's stock backend intentionally accepts whatever adapter the browser returns.
// This simulator has a stricter contract: WebGPU hardware or an explicit failure.
// Retaining the adapter also lets diagnostics prove which device produced a report.
export class StrictWebGPUBackend extends WebGPUBackend {
  async init(renderer) {
    if (this.parameters.device === undefined) {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        throw new Error('WebGPU is unavailable; no alternate renderer exists.');
      }
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: this.parameters.powerPreference,
        forceFallbackAdapter: false,
        featureLevel: 'compatibility',
        xrCompatible: renderer.xr.enabled,
      });
      if (!adapter) throw new Error('Unable to acquire a WebGPU hardware adapter.');

      const info = adapter.info || null;
      const adapterText = info
        ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ')
        : '';
      if (adapter.isFallbackAdapter === true || SOFTWARE_ADAPTER.test(adapterText)) {
        throw new Error(`Software/fallback WebGPU adapters are not supported${adapterText ? ` (${adapterText})` : ''}.`);
      }

      const descriptor = { requiredFeatures: [...adapter.features] };
      if (this.parameters.requiredLimits) descriptor.requiredLimits = this.parameters.requiredLimits;
      const device = await adapter.requestDevice(descriptor);
      this.adapter = adapter;
      this.adapterInfo = info;
      this.isFallbackAdapter = adapter.isFallbackAdapter ?? null;
      this.environmentTier = selectEnvironmentDeviceTier({
        adapterLimits: adapter.limits,
        deviceLimits: device.limits,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigator.deviceMemory,
      });
      this.environmentTierSnapshot = environmentTierSnapshot(this.environmentTier);
      this.parameters.device = device;
    }

    return super.init(renderer);
  }
}
