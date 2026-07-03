import { describe, it, expect } from 'vitest';
import {
  containerBelongsToComposeService,
  filterContainersByComposeService,
} from '../helpers/composeServiceMatch';

describe('composeServiceMatch', () => {
  it('matches by Service field from docker compose ps', () => {
    const c = { Id: 'abc', Service: 'mariadb', Names: ['/mariadb'] };
    expect(containerBelongsToComposeService(c, 'mariadb')).toBe(true);
    expect(containerBelongsToComposeService(c, 'phpmyadmin')).toBe(false);
  });

  it('matches by com.docker.compose.service label', () => {
    const c = {
      Id: 'abc',
      Names: ['/custom-name'],
      Labels: { 'com.docker.compose.service': 'mariadb' },
    };
    expect(containerBelongsToComposeService(c, 'mariadb')).toBe(true);
  });

  it('matches when container name equals service (container_name in compose)', () => {
    const c = { Id: 'abc', Service: '', Names: ['/mariadb'] };
    expect(containerBelongsToComposeService(c, 'mariadb')).toBe(true);
  });

  it('filterContainersByComposeService returns all replicas', () => {
    const containers = [
      { Id: '1', Service: 'app', Names: ['/web-app-1'] },
      { Id: '2', Service: 'app', Names: ['/web-app-2'] },
      { Id: '3', Names: ['/db'] },
    ];
    expect(filterContainersByComposeService(containers, 'app')).toHaveLength(2);
  });
});
