/**
 * The bounded host-port enumeration every per-port rule and the source locator
 * share. The 256-port cap is what keeps a hostile `1-65535` range from blowing
 * up a report, and a rule and the locator must agree on exactly which ports it
 * counts or a finding can point at a declaration it never reported.
 */
import { describe, expect, it } from 'vitest';
import { claimsEnumeratedHostPort, enumeratedHostPorts } from '../helpers/composePortSpec';

describe('bounded host-port enumeration', () => {
  it('caps a long range at 256 ports', () => {
    const ports = enumeratedHostPorts({ startPort: 10000, endPort: 20000 });
    expect(ports).toHaveLength(256);
    expect(ports[0]).toBe(10000);
    expect(ports[255]).toBe(10255);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 10255)).toBe(true);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 10256)).toBe(false);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 9999)).toBe(false);
  });

  it('enumerates a short range exactly', () => {
    expect(enumeratedHostPorts({ startPort: 8080, endPort: 8082 })).toEqual([8080, 8081, 8082]);
    expect(claimsEnumeratedHostPort({ startPort: 8080, endPort: 8082 }, 8082)).toBe(true);
    expect(claimsEnumeratedHostPort({ startPort: 8080, endPort: 8082 }, 8083)).toBe(false);
  });

  it('claims nothing for a dynamic publication', () => {
    expect(enumeratedHostPorts({ startPort: 0, endPort: 0, dynamic: true })).toEqual([]);
    expect(claimsEnumeratedHostPort({ startPort: 0, endPort: 0, dynamic: true }, 8080)).toBe(false);
  });
});
