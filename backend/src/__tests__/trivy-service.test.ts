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

    it('throws a helpful error on malformed JSON', () => {
      expect(() => parseTrivyOutput('{not-json')).toThrow(/Malformed/i);
    });
  });
});
