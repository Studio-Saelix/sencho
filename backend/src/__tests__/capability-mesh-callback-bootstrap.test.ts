import { describe, it, expect } from 'vitest';
import { getActiveCapabilities, applyPilotModeCapabilityFilter, enableCapability } from '../services/CapabilityRegistry';

describe('mesh_proxy_callback_bootstrap capability', () => {
  it('is registered in the default CAPABILITIES list', () => {
    expect(getActiveCapabilities()).toContain('mesh_proxy_callback_bootstrap');
  });

  it('is NOT filtered out in pilot mode (pilots can also be bootstrap targets)', () => {
    applyPilotModeCapabilityFilter();
    expect(getActiveCapabilities()).toContain('mesh_proxy_callback_bootstrap');
    enableCapability('host-console');
    enableCapability('self-update');
  });
});
