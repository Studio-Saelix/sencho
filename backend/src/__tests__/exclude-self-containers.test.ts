import { describe, it, expect } from 'vitest';
import { isPublishedSenchoImage } from '../helpers/excludeSelfContainers';

describe('isPublishedSenchoImage', () => {
  it('matches Docker Hub and GHCR release paths', () => {
    expect(isPublishedSenchoImage('saelix/sencho:latest')).toBe(true);
    expect(isPublishedSenchoImage('ghcr.io/studio-saelix/sencho:0.93.1')).toBe(true);
    expect(isPublishedSenchoImage('ghcr.io/studio-saelix/sencho-dev:dev')).toBe(true);
    expect(isPublishedSenchoImage('lscr.io/linuxserver/mariadb:latest')).toBe(false);
  });
});
