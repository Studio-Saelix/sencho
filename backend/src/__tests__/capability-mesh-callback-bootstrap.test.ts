import { describe, it, expect, afterEach } from 'vitest';
import {
  getActiveCapabilities,
  applyPilotModeCapabilityFilter,
  enableCapability,
  disableCapability,
} from '../services/CapabilityRegistry';

describe('mesh_proxy_callback_bootstrap capability', () => {
  afterEach(() => {
    // Ensure the runtime override does not leak between tests.
    enableCapability('mesh_proxy_callback_bootstrap');
  });

  it('is registered in the default CAPABILITIES list', () => {
    expect(getActiveCapabilities()).toContain('mesh_proxy_callback_bootstrap');
  });

  it('is NOT filtered out in pilot mode (pilots can also be bootstrap targets)', () => {
    applyPilotModeCapabilityFilter();
    expect(getActiveCapabilities()).toContain('mesh_proxy_callback_bootstrap');
    enableCapability('host-console');
    enableCapability('self-update');
  });

  it('is stripped from the active capabilities list when the data plane is disabled', () => {
    disableCapability('mesh_proxy_callback_bootstrap');
    expect(getActiveCapabilities()).not.toContain('mesh_proxy_callback_bootstrap');
  });

  it('returns to the advertised list once enableCapability is called again', () => {
    disableCapability('mesh_proxy_callback_bootstrap');
    expect(getActiveCapabilities()).not.toContain('mesh_proxy_callback_bootstrap');
    enableCapability('mesh_proxy_callback_bootstrap');
    expect(getActiveCapabilities()).toContain('mesh_proxy_callback_bootstrap');
  });
});
