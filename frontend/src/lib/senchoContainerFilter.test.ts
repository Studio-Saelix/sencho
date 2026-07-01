import { describe, it, expect } from 'vitest';
import { excludeLikelySenchoContainers, isLikelySenchoManagementContainer } from '../lib/senchoContainerFilter';

describe('senchoContainerFilter', () => {
  it('detects sencho management containers by name and image', () => {
    expect(isLikelySenchoManagementContainer({ Id: '1', Names: ['/sencho'], Image: 'saelix/sencho:latest' })).toBe(true);
    expect(isLikelySenchoManagementContainer({ Id: '2', Names: ['/sencho-agent'] })).toBe(true);
    expect(isLikelySenchoManagementContainer({ Id: '3', Names: ['/mariadb'], Image: 'lscr.io/linuxserver/mariadb:latest' })).toBe(false);
  });

  it('excludeLikelySenchoContainers keeps user containers', () => {
    const rows = excludeLikelySenchoContainers([
      { Id: '1', Names: ['/sencho'], Image: 'ghcr.io/studio-saelix/sencho:dev' },
      { Id: '2', Names: ['/mariadb'], Image: 'lscr.io/linuxserver/mariadb:latest' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].Names).toEqual(['/mariadb']);
  });
});
