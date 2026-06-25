/**
 * Redacted networking + exposure summary for the Stack Dossier export, derived
 * from the /networking facts and /exposure intents. It carries only network
 * names, exposure intents, published port numbers, and binding scope; never an
 * env value or a label value, so nothing sensitive reaches the exported text.
 * Pure and side-effect free.
 */

export interface NetworkExposureSummary {
  stackIntent: string | null;
  networks: { name: string; external: boolean; internal: boolean }[];
  services: { name: string; intent: string | null; ports: string[]; hostNetwork: boolean }[];
}

// Loose input shapes: the builder reads the raw parsed /networking and
// /exposure JSON, so it stays decoupled from the panel's local interfaces.
interface FactsPort { startPort: number; endPort: number; protocol: string; allInterfaces: boolean; loopbackOnly: boolean }
interface FactsService { name: string; publishedPorts?: FactsPort[]; networkMode?: string }
interface FactsNetwork { name: string; external: boolean; internal: boolean }
export interface NetworkFactsInput { renderable?: boolean; networks?: FactsNetwork[]; services?: FactsService[] }
export interface ExposureIntentInput { service: string; intent: string }

function portLabel(p: FactsPort): string {
  const range = p.startPort === p.endPort ? `${p.startPort}` : `${p.startPort}-${p.endPort}`;
  const scope = p.allInterfaces ? ' (all interfaces)' : p.loopbackOnly ? ' (loopback)' : '';
  return `${range}/${p.protocol}${scope}`;
}

/** Assemble the summary, or null when there is nothing worth documenting. */
export function buildNetworkExposureSummary(facts: NetworkFactsInput | null, intents: ExposureIntentInput[]): NetworkExposureSummary | null {
  if (!facts || facts.renderable === false) return null;
  const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
  const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));
  const networks = (facts.networks ?? []).map(n => ({ name: n.name, external: n.external, internal: n.internal }));
  const services = (facts.services ?? []).map(s => ({
    name: s.name,
    intent: byService.get(s.name) ?? null,
    ports: (s.publishedPorts ?? []).map(portLabel),
    // network_mode: host publishes every container port on the host, so it is
    // exposure-relevant even with no declared ports.
    hostNetwork: s.networkMode === 'host',
  }));
  const empty = networks.length === 0 && stackIntent === null
    && services.every(s => s.ports.length === 0 && s.intent === null && !s.hostNetwork);
  return empty ? null : { stackIntent, networks, services };
}

/** Render the summary as a Markdown section, or null when there is nothing to show. */
export function networkExposureSection(summary: NetworkExposureSummary | null): string | null {
  if (!summary) return null;
  const parts = ['## Network exposure'];
  if (summary.stackIntent) parts.push(`- **Stack intent:** ${summary.stackIntent}`);
  if (summary.networks.length > 0) {
    parts.push('### Networks', summary.networks.map(n => {
      const flags = [n.external && 'external', n.internal && 'internal'].filter(Boolean).join(', ');
      return `- ${n.name}${flags ? ` (${flags})` : ''}`;
    }).join('\n'));
  }
  const services = summary.services.filter(s => s.ports.length > 0 || s.intent || s.hostNetwork);
  if (services.length > 0) {
    parts.push('### Services', services.map(s => {
      const bits: string[] = [];
      if (s.intent) bits.push(`intent ${s.intent}`);
      if (s.hostNetwork) bits.push('host network (all ports exposed on host)');
      if (s.ports.length > 0) bits.push(`ports ${s.ports.join(', ')}`);
      return `- **${s.name}:** ${bits.join('; ')}`;
    }).join('\n'));
  }
  return parts.join('\n\n');
}
