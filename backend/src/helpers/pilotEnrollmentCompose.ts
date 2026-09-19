export const PILOT_CA_HOST_SOURCE = './sencho-hub-ca.pem';
export const PILOT_CA_CONTAINER_PATH = '/etc/ssl/sencho-hub-ca.pem';

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function buildPilotEnrollmentCompose(input: {
  primaryUrl: string;
  token: string;
  composeDir: string;
  caPem?: string;
}): string {
  const caVolumeLines = input.caPem
    ? [`      - ${PILOT_CA_HOST_SOURCE}:${PILOT_CA_CONTAINER_PATH}:ro`]
    : [];
  const caEnvLines = input.caPem
    ? [`      SENCHO_PILOT_CA_FILE: ${yamlString(PILOT_CA_CONTAINER_PATH)}`]
    : [];

  // Top-level `name` plus `container_name` make the agent container's HOSTNAME
  // equal to `sencho-agent`, which is how SelfUpdateService locates its own
  // compose context to enable remote self-update.
  return [
    `name: sencho-agent`,
    `services:`,
    `  agent:`,
    `    image: saelix/sencho:latest`,
    `    container_name: sencho-agent`,
    `    restart: unless-stopped`,
    `    volumes:`,
    `      - /var/run/docker.sock:/var/run/docker.sock`,
    `      - sencho-agent-data:/app/data`,
    `      - type: bind`,
    `        source: ${yamlString(input.composeDir)}`,
    `        target: ${yamlString(input.composeDir)}`,
    ...caVolumeLines,
    `    environment:`,
    `      SENCHO_MODE: pilot`,
    `      SENCHO_PRIMARY_URL: ${yamlString(input.primaryUrl)}`,
    `      SENCHO_ENROLL_TOKEN: ${yamlString(input.token)}`,
    `      COMPOSE_DIR: ${yamlString(input.composeDir)}`,
    ...caEnvLines,
    ``,
    `volumes:`,
    `  sencho-agent-data:`,
    ``,
  ].join('\n');
}
