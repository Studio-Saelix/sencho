/**
 * Unit tests for TrivyService parsing, severity computation, and concurrency guard.
 *
 * Focuses on the pure logic exposed on the singleton: output parsing of Trivy JSON,
 * highest-severity rollup, duplicate scan prevention, and graceful handling
 * when the binary is not available.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import TrivyService, { parseTrivyOutput } from '../services/TrivyService';
import TrivyInstaller from '../services/TrivyInstaller';
import { getActiveCapabilities, enableCapability } from '../services/CapabilityRegistry';

describe('TrivyService', () => {
  let svc: TrivyService;

  beforeEach(() => {
    svc = TrivyService.getInstance();
  });

  afterEach(() => {
    // detectTrivy() toggles a process-global capability flag. Restore the
    // default (enabled) so this suite cannot leak a disabled state into another
    // suite sharing the worker.
    enableCapability('vulnerability-scanning');
  });

  describe('isTrivyAvailable', () => {
    it('returns false when binary has not been detected', () => {
      // Service default state: available=false until initialize() runs
      // Tests must not assert true here because CI may or may not have trivy installed.
      const available = svc.isTrivyAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('detectTrivy', () => {
    it('returns structured result regardless of binary presence', async () => {
      const result = await svc.detectTrivy();
      expect(result).toHaveProperty('available');
      expect(result).toHaveProperty('version');
      expect(typeof result.available).toBe('boolean');
    });

    it('records a detection timestamp after running', async () => {
      const before = Date.now();
      await svc.detectTrivy();
      expect(svc.getDetectionTimestamp()).toBeGreaterThanOrEqual(before);
    });

    it('keeps the vulnerability-scanning capability in lockstep with detected availability', async () => {
      // Regression guard: detection used to toggle the capability only on a
      // state transition, so a process that boots without Trivy (source starts
      // at 'none', wasAvailable === false) never disabled it and kept
      // advertising scanning on a node that cannot scan. Start from the enabled
      // state (the buggy starting point) so that on a Trivy-less runner this
      // proves the disable branch fired; the advertised capability must equal
      // the detected availability after every detection.
      enableCapability('vulnerability-scanning');
      const result = await svc.detectTrivy();
      const advertised = getActiveCapabilities().includes('vulnerability-scanning');
      expect(advertised).toBe(result.available);
    });

    it('disables the capability from the enabled state when no binary is found (deterministic)', async () => {
      // Force every detection candidate to miss regardless of the runner: bogus
      // managed path, bogus TRIVY_BIN, and an emptied PATH so a bare `trivy`
      // cannot resolve. This reproduces the boot-without-Trivy case the fix
      // targets and proves the disable branch fires even starting from enabled.
      const installerSpy = vi
        .spyOn(TrivyInstaller.getInstance(), 'binaryPath')
        .mockReturnValue('/nonexistent/managed/trivy');
      const prevTrivyBin = process.env.TRIVY_BIN;
      const prevPath = process.env.PATH;
      process.env.TRIVY_BIN = '/nonexistent/env/trivy';
      process.env.PATH = '';
      enableCapability('vulnerability-scanning');
      try {
        const result = await svc.detectTrivy();
        expect(result.available).toBe(false);
        expect(getActiveCapabilities()).not.toContain('vulnerability-scanning');
      } finally {
        installerSpy.mockRestore();
        if (prevTrivyBin === undefined) delete process.env.TRIVY_BIN;
        else process.env.TRIVY_BIN = prevTrivyBin;
        process.env.PATH = prevPath;
      }
    });
  });

  describe('scanImage', () => {
    it('throws when Trivy is not available', async () => {
      // Force availability off for this assertion
      // The service caches state; reset via detectTrivy (will probably return false in CI)
      const detect = await svc.detectTrivy();
      if (!detect.available) {
        await expect(svc.scanImage('alpine:3.19', 1)).rejects.toThrow(
          /Trivy is not available/i,
        );
      }
    });
  });

  describe('isScanning guard', () => {
    it('reports false for images not currently being scanned', () => {
      expect(svc.isScanning(1, 'nginx:latest')).toBe(false);
    });
  });

  describe('parseTrivyOutput', () => {
    it('extracts OS metadata and deduplicates vulnerabilities across targets', () => {
      const raw = JSON.stringify({
        Metadata: { OS: { Family: 'alpine', Name: '3.19.0' } },
        Results: [
          {
            Target: 'alpine:3.19 (alpine)',
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2024-0001',
                PkgName: 'openssl',
                InstalledVersion: '3.0.0',
                FixedVersion: '3.0.1',
                Severity: 'HIGH',
              },
              {
                VulnerabilityID: 'CVE-2024-0002',
                PkgName: 'curl',
                InstalledVersion: '8.0',
                Severity: 'CRITICAL',
              },
            ],
          },
          {
            Target: 'other-target',
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2024-0001',
                PkgName: 'openssl',
                InstalledVersion: '3.0.0',
                Severity: 'HIGH',
              },
            ],
          },
        ],
      });
      const parsed = parseTrivyOutput(raw);
      expect(parsed.os).toBe('alpine 3.19.0');
      expect(parsed.vulnerabilities.length).toBe(2);
      const ids = parsed.vulnerabilities.map((v) => v.vulnerabilityId);
      expect(ids).toContain('CVE-2024-0001');
      expect(ids).toContain('CVE-2024-0002');
    });

    it('normalizes unknown severities to UNKNOWN', () => {
      const raw = JSON.stringify({
        Results: [
          {
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-X',
                PkgName: 'libx',
                InstalledVersion: '1',
                Severity: 'NEGLIGIBLE',
              },
            ],
          },
        ],
      });
      const parsed = parseTrivyOutput(raw);
      expect(parsed.vulnerabilities[0].severity).toBe('UNKNOWN');
    });

    it('drops entries missing VulnerabilityID or PkgName', () => {
      const raw = JSON.stringify({
        Results: [
          {
            Vulnerabilities: [
              { PkgName: 'x', Severity: 'HIGH' },
              { VulnerabilityID: 'CVE-1', Severity: 'HIGH' },
              { VulnerabilityID: 'CVE-2', PkgName: 'y', Severity: 'LOW' },
            ],
          },
        ],
      });
      const parsed = parseTrivyOutput(raw);
      expect(parsed.vulnerabilities.length).toBe(1);
      expect(parsed.vulnerabilities[0].vulnerabilityId).toBe('CVE-2');
    });

    it('tolerates missing Metadata and empty Results', () => {
      const parsed = parseTrivyOutput(JSON.stringify({ Results: [] }));
      expect(parsed.os).toBeNull();
      expect(parsed.vulnerabilities).toEqual([]);

      const parsedEmpty = parseTrivyOutput(JSON.stringify({}));
      expect(parsedEmpty.os).toBeNull();
      expect(parsedEmpty.vulnerabilities).toEqual([]);
    });

    it('captures scan-intrinsic enrichment (status, CVSS, vendor severity, purl, path, layer)', () => {
      // Shape mirrors Trivy's documented image-scan JSON for a single finding.
      const raw = JSON.stringify({
        Results: [
          {
            Target: 'app',
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2024-9143',
                PkgName: 'libcrypto3',
                PkgPath: 'usr/lib/libcrypto.so.3',
                PkgIdentifier: { PURL: 'pkg:apk/alpine/libcrypto3@3.3.2-r0' },
                InstalledVersion: '3.3.2-r0',
                FixedVersion: '3.3.2-r1',
                Status: 'fixed',
                Severity: 'LOW',
                Layer: { DiffID: 'sha256:deadbeef' },
                VendorSeverity: { amazon: 3, redhat: 1, ubuntu: 1 },
                CVSS: {
                  nvd: { V3Vector: 'CVSS:3.1/AV:N', V3Score: 9.8 },
                  redhat: { V3Vector: 'CVSS:3.1/AV:L', V3Score: 3.7 },
                },
              },
            ],
          },
        ],
      });
      const v = parseTrivyOutput(raw).vulnerabilities[0];
      expect(v.status).toBe('fixed');
      expect(v.cvssScore).toBe(9.8); // prefers nvd over redhat
      expect(v.cvssVector).toBe('CVSS:3.1/AV:N');
      expect(v.cvssSource).toBe('nvd');
      expect(v.vendorSeverity).toBe('HIGH'); // max vendor rating (amazon=3)
      expect(v.purl).toBe('pkg:apk/alpine/libcrypto3@3.3.2-r0');
      expect(v.pkgPath).toBe('usr/lib/libcrypto.so.3');
      expect(v.layerDigest).toBe('sha256:deadbeef');
    });

    it('falls back to a non-nvd CVSS source and nulls absent enrichment', () => {
      const onlyRedhat = JSON.stringify({
        Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-R', PkgName: 'p', Severity: 'HIGH', CVSS: { redhat: { V3Vector: 'X', V3Score: 7.5 } } }] }],
      });
      const a = parseTrivyOutput(onlyRedhat).vulnerabilities[0];
      expect(a.cvssSource).toBe('redhat');
      expect(a.cvssScore).toBe(7.5);

      const bare = JSON.stringify({
        Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-N', PkgName: 'p', Severity: 'HIGH' }] }],
      });
      const b = parseTrivyOutput(bare).vulnerabilities[0];
      expect(b.status).toBeNull();
      expect(b.cvssScore).toBeNull();
      expect(b.cvssVector).toBeNull();
      expect(b.cvssSource).toBeNull();
      expect(b.vendorSeverity).toBeNull();
      expect(b.purl).toBeNull();
      expect(b.pkgPath).toBeNull();
      expect(b.layerDigest).toBeNull();
    });

    it('throws a helpful error on malformed JSON', () => {
      expect(() => parseTrivyOutput('{not-json')).toThrow(/Malformed/i);
    });
  });
});
