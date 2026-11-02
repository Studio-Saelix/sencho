/**
 * Redacted networking + exposure summary for the Stack and Fleet Dossier
 * exports, derived from the /networking facts and /exposure intents. It carries
 * only network names, exposure intents, the detected answer, published port
 * labels (a number, a range, or auto-assigned), binding scope, and the tunnel
 * connector (provider and service name) that reaches a service; never an
 * env value or a label value, so nothing sensitive reaches the exported text.
 * A service with no known exposure path and one that could not be determined
 * both print a line, and a read that failed says so instead of looking like
 * "nothing to document". Pure and side-effect free.
 */
import { tunnelPathLabel } from '@/lib/tunnelExposure';
import type { ServiceTunnelExposure } from '@/types/networking';

export interface NetworkExposureService {
  name: string;
  /** The service's own declared intent, when it has an override. */
  intent: string | null;
  /** The stack intent it takes when it has no override of its own. */
  inherits: string | null;
  /** The detected answer; null when the node does not report detection. */
  detected: string | null;
  ports: string[];
  hostNetwork: boolean;
  tunnel: string | null;
}

export interface NetworkExposureSummary {
  /** The networking facts could not be read at all. */
  unreadable: boolean;
  /** The Compose model did not render, so no detection exists. */
  renderFailed: boolean;
  /** The exposure intents could not be read, so no intent is claimed either way. */
  intentsUnreadable: boolean;
  stackIntent: string | null;
  networks: { name: string; external: boolean; internal: boolean }[];
  services: NetworkExposureService[];
}

// Loose input shapes: the builder reads the raw parsed /networking and
// /exposure JSON, so it stays decoupled from the panel's local interfaces.
interface FactsPort { startPort: number; endPort: number; protocol: string; dynamic?: true; allInterfaces: boolean; loopbackOnly: boolean }
interface FactsService {
  name: string;
  publishedPorts?: FactsPort[];
  networkMode?: string;
  tunnel?: ServiceTunnelExposure;
  detected?: { answer?: unknown } | null;
}
interface FactsNetwork { name: string; external: boolean; internal: boolean }
export interface NetworkFactsInput { renderable?: boolean; networks?: FactsNetwork[]; services?: FactsService[] }
export interface ExposureIntentInput { service: string; intent: string }

function portLabel(p: FactsPort): string {
  // Docker assigns the host port at start, so no number exists to show.
  const range = p.dynamic ? 'auto-assigned' : p.startPort === p.endPort ? `${p.startPort}` : `${p.startPort}-${p.endPort}`;
  const scope = p.allInterfaces ? ' (all interfaces)' : p.loopbackOnly ? ' (loopback)' : '';
  return `${range}/${p.protocol}${scope}`;
}

function detectedAnswer(service: FactsService): string | null {
  const answer = service.detected?.answer;
  return typeof answer === 'string' ? answer : null;
}

/** Assemble the summary. A read that failed or a model that did not render is
 *  itself reported, never dropped, and an intent list that could not be read is
 *  reported rather than read as "nothing declared". */
export function buildNetworkExposureSummary(facts: NetworkFactsInput | null, intents: ExposureIntentInput[] | null): NetworkExposureSummary {
  const intentsUnreadable = intents === null;
  const stackIntent = intents?.find(i => i.service === '')?.intent ?? null;
  if (!facts) {
    return { unreadable: true, renderFailed: false, intentsUnreadable, stackIntent: null, networks: [], services: [] };
  }
  if (facts.renderable === false) {
    return { unreadable: false, renderFailed: true, intentsUnreadable, stackIntent, networks: [], services: [] };
  }
  const byService = new Map((intents ?? []).filter(i => i.service !== '').map(i => [i.service, i.intent]));
  const networks = (facts.networks ?? []).map(n => ({ name: n.name, external: n.external, internal: n.internal }));
  const services = (facts.services ?? []).map(s => ({
    name: s.name,
    intent: byService.get(s.name) ?? null,
    inherits: byService.has(s.name) ? null : stackIntent,
    detected: detectedAnswer(s),
    ports: (s.publishedPorts ?? []).map(portLabel),
    // network_mode: host publishes every container port on the host, so it is
    // exposure-relevant even with no declared ports.
    hostNetwork: s.networkMode === 'host',
    tunnel: s.tunnel ? tunnelPathLabel(s.tunnel) : null,
  }));
  return { unreadable: false, renderFailed: false, intentsUnreadable, stackIntent, networks, services };
}

/** Render the summary as a Markdown section, or null when there is nothing to show. */
export function networkExposureSection(summary: NetworkExposureSummary | null): string | null {
  if (!summary) return null;
  const parts = ['## Network exposure'];
  if (summary.unreadable) {
    parts.push('Network exposure could not be read for this stack.');
    return parts.join('\n\n');
  }
  if (summary.renderFailed) {
    parts.push('Detected exposure could not be determined (the Compose model did not render).');
    return parts.join('\n\n');
  }
  if (summary.intentsUnreadable) parts.push('Exposure intent could not be read for this stack.');
  if (summary.stackIntent) parts.push(`- **Stack intent:** ${summary.stackIntent}`);
  if (summary.networks.length > 0) {
    parts.push('### Networks', summary.networks.map(n => {
      const flags = [n.external && 'external', n.internal && 'internal'].filter(Boolean).join(', ');
      return `- ${n.name}${flags ? ` (${flags})` : ''}`;
    }).join('\n'));
  }
  if (summary.services.length > 0) {
    parts.push('### Services', summary.services.map(s => {
      const bits: string[] = [];
      if (!summary.intentsUnreadable) {
        if (s.intent) bits.push(`intent ${s.intent}`);
        else if (s.inherits) bits.push(`inherits ${s.inherits}`);
        else if (s.detected) bits.push('auto (detected)');
        else bits.push('no intent declared');
      }
      if (s.detected) bits.push(`detected: ${s.detected}`);
      if (s.hostNetwork) bits.push('host network (all ports exposed on host)');
      if (s.ports.length > 0) bits.push(`ports ${s.ports.join(', ')}`);
      if (s.tunnel) bits.push(`reachable ${s.tunnel}`);
      if (bits.length === 0) bits.push('exposure not reported');
      return `- **${s.name}:** ${bits.join('; ')}`;
    }).join('\n'));
  }
  return parts.join('\n\n');
}
