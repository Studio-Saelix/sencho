import { describe, it, expect, vi } from 'vitest';
import { buildServiceUrl, openServiceUrl } from './serviceUrl';

describe('buildServiceUrl', () => {
  it('uses the browser host for a local node', () => {
    expect(
      buildServiceUrl({ node: { type: 'local' }, publicPort: 8080, browserHost: 'box.lan' }),
    ).toBe('http://box.lan:8080');
  });

  it('uses the browser host when no node is given', () => {
    expect(buildServiceUrl({ publicPort: 3000, browserHost: 'localhost' })).toBe(
      'http://localhost:3000',
    );
  });

  it('derives the host from a remote node api_url', () => {
    expect(
      buildServiceUrl({
        node: { type: 'remote', api_url: 'http://192.168.1.50:1852' },
        publicPort: 8989,
        browserHost: 'box.lan',
      }),
    ).toBe('http://192.168.1.50:8989');
  });

  it('prefers an explicit public host over the node host', () => {
    expect(
      buildServiceUrl({
        node: { type: 'remote', api_url: 'http://192.168.1.50:1852' },
        publicPort: 8080,
        publicHost: 'apps.example.com',
      }),
    ).toBe('http://apps.example.com:8080');
  });

  it('normalizes a public host given as a full URL', () => {
    expect(
      buildServiceUrl({ publicPort: 8080, publicHost: 'https://apps.example.com:9999' }),
    ).toBe('http://apps.example.com:8080');
  });

  it('defaults to http', () => {
    expect(buildServiceUrl({ publicPort: 8080, browserHost: 'host' })).toBe('http://host:8080');
  });

  it('uses https when the published port is 443', () => {
    expect(buildServiceUrl({ publicPort: 443, browserHost: 'host' })).toBe('https://host:443');
  });

  it('uses https when the container port is 443 but the host port differs', () => {
    expect(
      buildServiceUrl({ publicPort: 8443, privatePort: 443, browserHost: 'host' }),
    ).toBe('https://host:8443');
  });

  it('returns null for a remote node with no api_url (pilot agent)', () => {
    expect(
      buildServiceUrl({ node: { type: 'remote', api_url: '' }, publicPort: 8080, browserHost: 'host' }),
    ).toBeNull();
  });

  it('returns null for a remote node with a malformed api_url', () => {
    expect(
      buildServiceUrl({ node: { type: 'remote', api_url: 'not a url' }, publicPort: 8080, browserHost: 'host' }),
    ).toBeNull();
  });

  it('returns null for an out-of-range port', () => {
    expect(buildServiceUrl({ publicPort: 0, browserHost: 'host' })).toBeNull();
    expect(buildServiceUrl({ publicPort: 65536, browserHost: 'host' })).toBeNull();
  });

  it('keeps an IPv6 api_url host bracketed', () => {
    expect(
      buildServiceUrl({ node: { type: 'remote', api_url: 'http://[::1]:1852' }, publicPort: 8080 }),
    ).toBe('http://[::1]:8080');
  });

  it('appends a known service path keyed by the container port', () => {
    expect(
      buildServiceUrl({ publicPort: 12345, privatePort: 32400, browserHost: 'host' }),
    ).toBe('http://host:12345/web');
  });

  it('appends a known service path keyed by the published port', () => {
    expect(buildServiceUrl({ publicPort: 32400, browserHost: 'host' })).toBe(
      'http://host:32400/web',
    );
  });

  it('appends no path for a port not in the registry', () => {
    expect(buildServiceUrl({ publicPort: 8080, privatePort: 80, browserHost: 'host' })).toBe(
      'http://host:8080',
    );
  });

  it('does not borrow a path from the published port when the container port is known', () => {
    // 32400 is registered as Plex's container port; a non-Plex service whose
    // container port (80) happens to be published on host port 32400 must not
    // inherit /web.
    expect(buildServiceUrl({ publicPort: 32400, privatePort: 80, browserHost: 'host' })).toBe(
      'http://host:32400',
    );
  });
});

describe('openServiceUrl', () => {
  it('clicks a transient anchor with safe new-tab attributes', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.target).toBe('_blank');
      expect(this.rel).toBe('noopener noreferrer');
      expect(this.href).toBe('http://host:8080/');
    });
    openServiceUrl('http://host:8080');
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('a')).toBeNull();
    click.mockRestore();
  });
});
