import { describe, expect, it } from 'vitest';
import { serviceUrlFromLabelValue, serviceUrlFromLabels } from '../helpers/serviceUrlLabel';

describe('serviceUrlFromLabelValue', () => {
  it('accepts an absolute http or https URL', () => {
    expect(serviceUrlFromLabelValue('https://app.example.com')).toBe('https://app.example.com');
    expect(serviceUrlFromLabelValue(' http://app.example.com:3031/web ')).toBe('http://app.example.com:3031/web');
  });

  it('rejects userinfo, other schemes, and empty hosts', () => {
    expect(serviceUrlFromLabelValue('https://user:secret@app.example.com')).toBeNull();
    expect(serviceUrlFromLabelValue('ftp://app.example.com')).toBeNull();
    expect(serviceUrlFromLabelValue('javascript:alert(1)')).toBeNull();
    expect(serviceUrlFromLabelValue('/relative')).toBeNull();
    expect(serviceUrlFromLabelValue('')).toBeNull();
    expect(serviceUrlFromLabelValue('https:app.example.com')).toBeNull();
    expect(serviceUrlFromLabelValue('https:/app.example.com')).toBeNull();
  });
});

describe('serviceUrlFromLabels', () => {
  it('reads the allowlisted key from a map or a list and ignores other values', () => {
    expect(serviceUrlFromLabels({
      'sencho.service.url': 'https://app.example.com',
      'traefik.http.routers.web.rule': 'Host(`secret.example.com`)',
    })).toBe('https://app.example.com');
    expect(serviceUrlFromLabels([
      'traefik.enable=true',
      'sencho.service.url=https://app.example.com/path',
    ])).toBe('https://app.example.com/path');
  });

  it('omits an invalid allowlisted value', () => {
    expect(serviceUrlFromLabels({ 'sencho.service.url': 'not a url' })).toBeNull();
    expect(serviceUrlFromLabels(['sencho.service.url'])).toBeNull();
  });
});
