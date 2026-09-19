import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  PILOT_CA_CONTAINER_PATH,
  PILOT_CA_HOST_SOURCE,
  buildPilotEnrollmentCompose,
} from '../helpers/pilotEnrollmentCompose';

interface ComposeFile {
  name: string;
  services: {
    agent: {
      volumes: Array<string | { type: string; source: string; target: string }>;
      environment: Record<string, string>;
    };
  };
}

describe('buildPilotEnrollmentCompose', () => {
  it('omits the CA mount when no CA PEM is supplied', () => {
    const yaml = buildPilotEnrollmentCompose({
      primaryUrl: 'https://192.168.1.50:1852',
      token: 'enroll-token',
      composeDir: '/opt/docker/sencho',
    });
    const parsed = parseYaml(yaml) as ComposeFile;
    expect(parsed.services.agent.environment.SENCHO_PRIMARY_URL).toBe('https://192.168.1.50:1852');
    expect(parsed.services.agent.environment.SENCHO_PILOT_CA_FILE).toBeUndefined();
    expect(parsed.services.agent.volumes).not.toContain(
      `${PILOT_CA_HOST_SOURCE}:${PILOT_CA_CONTAINER_PATH}:ro`,
    );
  });

  it('bind-mounts the hub CA and sets SENCHO_PILOT_CA_FILE when a CA PEM is supplied', () => {
    const yaml = buildPilotEnrollmentCompose({
      primaryUrl: 'https://192.168.1.50:1852',
      token: 'enroll-token',
      composeDir: '/opt/docker/sencho',
      caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    });
    const parsed = parseYaml(yaml) as ComposeFile;
    expect(parsed.services.agent.environment.SENCHO_PILOT_CA_FILE).toBe(PILOT_CA_CONTAINER_PATH);
    expect(parsed.services.agent.volumes).toContain(
      `${PILOT_CA_HOST_SOURCE}:${PILOT_CA_CONTAINER_PATH}:ro`,
    );
  });
});
