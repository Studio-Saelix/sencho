import axios, { type AxiosRequestConfig } from 'axios';
import YAML from 'yaml';
import { DatabaseService } from './DatabaseService';
import { CacheService } from './CacheService';
import { isDebugEnabled } from '../utils/debug';


interface TemplateEnv {
    name: string;
    label?: string;
    default?: string;
}

interface TemplateVolume {
    container: string;
    bind?: string;
    readonly?: boolean;
}

export interface Template {
    type?: number;
    title: string;
    description: string;
    logo?: string;
    image?: string;
    ports?: string[];
    volumes?: TemplateVolume[] | string[];
    env?: TemplateEnv[];
    categories?: string[];
    platform?: string;
    github_url?: string;
    docs_url?: string;
    architectures?: string[];
    stars?: number;
    source?: string;
    repository?: {
        url: string;
        stackfile: string;
    };
}

interface TemplatesResponse {
    version: string;
    templates: Template[];
}

// Shape of a single compose service block emitted for a deployed template.
// restart is always set; the other fields appear only when the template
// supplies them.
interface ComposeServiceDefinition {
    image?: string;
    restart: string;
    ports?: string[];
    volumes?: string[];
    env_file?: string[];
}

// Typed shapes for the LinuxServer.io API response
interface LsioPort { external?: number; internal: number; protocol?: string }
interface LsioVolume { path: string }
interface LsioEnvVar { name: string; desc?: string; default?: string }
interface LsioAppConfig { ports?: LsioPort[]; volumes?: LsioVolume[]; environment?: LsioEnvVar[] }
interface LsioApp {
    name: string;
    description?: string;
    logo?: string;
    github?: string;
    readme?: string;
    arch?: string[];
    stars?: number;
    config?: LsioAppConfig;
}
interface LsioApiResponse {
    data?: { repositories?: { linuxserver?: Record<string, LsioApp> } };
}

// Static category map for LSIO apps (the LSIO API does not expose category metadata).
// Apps can belong to multiple categories. Unmapped apps fall back to ['Other'].
const LSIO_CATEGORY_MAP: Record<string, string[]> = {
    // Media Servers
    'plex': ['Media'],
    'jellyfin': ['Media'],
    'emby': ['Media'],
    'navidrome': ['Media'],
    'airsonic-advanced': ['Media'],
    'airsonic': ['Media'],
    'beets': ['Media'],
    'calibre': ['Media', 'Books'],
    'calibre-web': ['Media', 'Books'],
    'kavita': ['Media', 'Books'],
    'komga': ['Media', 'Books'],
    'mylar3': ['Media', 'Books'],
    'ubooquity': ['Media', 'Books'],
    'lazylibrarian': ['Media', 'Books'],
    'cops': ['Media', 'Books'],
    'photoprism': ['Media', 'Productivity'],
    'immich': ['Media', 'Productivity'],
    'piwigo': ['Media'],
    'lychee': ['Media'],
    'davos': ['Media'],
    'mstream': ['Media'],
    'koel': ['Media'],
    'grocy': ['Productivity'],
    // *arr Automation suite
    'sonarr': ['Automation', 'Media'],
    'radarr': ['Automation', 'Media'],
    'lidarr': ['Automation', 'Media'],
    'readarr': ['Automation', 'Media'],
    'bazarr': ['Automation', 'Media'],
    'whisparr': ['Automation', 'Media'],
    'prowlarr': ['Automation'],
    'jackett': ['Automation'],
    'nzbhydra2': ['Automation'],
    'overseerr': ['Automation', 'Media'],
    'ombi': ['Automation', 'Media'],
    'requestrr': ['Automation'],
    'tautulli': ['Monitoring', 'Media'],
    'organizr': ['Automation'],
    'recyclarr': ['Automation'],
    'notifiarr': ['Automation'],
    'unpackerr': ['Automation'],
    // Dashboards / Homepages
    'heimdall': ['Utilities'],
    'homer': ['Utilities'],
    'dasherr': ['Utilities'],
    'flame': ['Utilities'],
    'homarr': ['Utilities'],
    'dashdot': ['Monitoring'],
    // Downloaders
    'qbittorrent': ['Downloaders'],
    'transmission': ['Downloaders'],
    'deluge': ['Downloaders'],
    'sabnzbd': ['Downloaders'],
    'nzbget': ['Downloaders'],
    'aria2': ['Downloaders'],
    'jdownloader-2': ['Downloaders'],
    'pyload-ng': ['Downloaders'],
    'rutorrent': ['Downloaders'],
    'flood': ['Downloaders'],
    'medusa': ['Automation', 'Downloaders'],
    'sickchill': ['Automation', 'Downloaders'],
    // Monitoring
    'grafana': ['Monitoring'],
    'netdata': ['Monitoring'],
    'uptime-kuma': ['Monitoring'],
    'statping-ng': ['Monitoring'],
    'healthchecks': ['Monitoring'],
    'smokeping': ['Monitoring'],
    'librespeed': ['Monitoring'],
    'speedtest-tracker': ['Monitoring'],
    'scrutiny': ['Monitoring'],
    'prometheus': ['Monitoring'],
    'loki': ['Monitoring'],
    'influxdb': ['Monitoring'],
    // Networking / Reverse Proxy
    'nginx': ['Networking'],
    'swag': ['Networking'],
    'letsencrypt': ['Networking'],
    'ddclient': ['Networking'],
    'duckdns': ['Networking'],
    'wireguard': ['Networking', 'Security'],
    'openvpn-as': ['Networking', 'Security'],
    'netbootxyz': ['Networking'],
    'pihole': ['Networking'],
    'unbound': ['Networking'],
    'adguardhome': ['Networking'],
    'cloudflared': ['Networking'],
    'haproxy': ['Networking'],
    'traefik': ['Networking'],
    'nginx-proxy-manager': ['Networking'],
    'fail2ban': ['Networking', 'Security'],
    // Security / Auth
    'vaultwarden': ['Security'],
    'authelia': ['Security'],
    'lldap': ['Security'],
    'endlessh': ['Security'],
    'sshwifty': ['Security'],
    // Development / CI
    'gitea': ['Development'],
    'code-server': ['Development'],
    'drone': ['Development'],
    'drone-runner-docker': ['Development'],
    'registry': ['Development'],
    'jenkins': ['Development'],
    'gogs': ['Development'],
    'woodpecker-ci': ['Development'],
    'gitlab': ['Development'],
    'fleet': ['Development'],
    // Productivity / Self-hosted SaaS
    'nextcloud': ['Productivity'],
    'bookstack': ['Productivity', 'Documentation'],
    'dokuwiki': ['Productivity', 'Documentation'],
    'wikijs': ['Productivity', 'Documentation'],
    'paperless-ngx': ['Productivity'],
    'mealie': ['Productivity'],
    'freshrss': ['Productivity'],
    'miniflux': ['Productivity'],
    'wallabag': ['Productivity'],
    'trilium': ['Productivity'],
    'hedgedoc': ['Productivity'],
    'etherpad': ['Productivity'],
    'monica': ['Productivity'],
    'firefly-iii': ['Productivity'],
    'shlink': ['Productivity'],
    'yourls': ['Productivity'],
    'stirling-pdf': ['Productivity'],
    'syncthing': ['Productivity'],
    'tandoor': ['Productivity'],
    'linkwarden': ['Productivity'],
    'vikunja': ['Productivity'],
    // Utilities / Backup
    'duplicati': ['Utilities'],
    'restic': ['Utilities'],
    'rsnapshot': ['Utilities'],
    'mysql-workbench': ['Utilities'],
    'sqlitebrowser': ['Utilities'],
    'filezilla': ['Utilities'],
    'rdesktop': ['Utilities'],
    'webtop': ['Utilities'],
};

function getCategoriesForApp(name: string): string[] {
    return LSIO_CATEGORY_MAP[name.toLowerCase()] ?? ['Other'];
}

export class TemplateService {
    private static readonly CACHE_KEY = 'templates:all';
    private readonly CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    // Cap the registry response so a large or compromised custom registry
    // cannot exhaust backend memory by streaming an unbounded body.
    private static readonly MAX_REGISTRY_RESPONSE_BYTES = 25 * 1024 * 1024;
    private static readonly REGISTRY_FETCH_OPTIONS = {
        timeout: 20_000,
        maxContentLength: TemplateService.MAX_REGISTRY_RESPONSE_BYTES,
        maxBodyLength: TemplateService.MAX_REGISTRY_RESPONSE_BYTES,
    } satisfies AxiosRequestConfig;

    public clearCache(): void {
        CacheService.getInstance().invalidate(TemplateService.CACHE_KEY);
        console.log('[Templates] Cache invalidated');
    }

    public async getTemplates(): Promise<Template[]> {
        try {
            // getOrFetch serves the last-known-good catalogue when the fetcher
            // rejects and a (now-expired) cache entry exists, so the mapped
            // errors below surface only on a cold or freshly cleared cache.
            // That is deliberate: a transient registry failure keeps the
            // catalogue usable. The response size cap still protects memory in
            // every case, since axios aborts before buffering the full body.
            return await CacheService.getInstance().getOrFetch<Template[]>(
                TemplateService.CACHE_KEY,
                this.CACHE_DURATION_MS,
                async () => {
                    const settings = DatabaseService.getInstance().getGlobalSettings();
                    // Default to a reliable LSIO Portainer v2 template registry if not set
                    const registryUrl = settings.template_registry_url || 'https://api.linuxserver.io/api/v1/images?include_config=true';

                    console.log(`[Templates] Fetching from registry: ${registryUrl}`);
                    const debug = isDebugEnabled();

                    let registryHost = '';
                    try { registryHost = new URL(registryUrl).hostname.toLowerCase(); } catch { /* invalid URL, treated as non-LSIO */ }
                    if (registryHost === 'api.linuxserver.io') {
                        const response = await axios.get<LsioApiResponse>(registryUrl, TemplateService.REGISTRY_FETCH_OPTIONS);
                        // Official LSIO API Schema Mapping
                        const lsioApps = response.data?.data?.repositories?.linuxserver ?? {};

                        const templates: Template[] = Object.values(lsioApps).map((app: LsioApp) => ({
                            type: 1,
                            title: app.name,
                            description: app.description || '',
                            logo: app.logo || `https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/${app.name}-logo.png`,
                            image: `lscr.io/linuxserver/${app.name}:latest`,
                            github_url: app.github,
                            docs_url: app.readme,
                            architectures: app.arch,
                            stars: app.stars,
                            categories: getCategoriesForApp(app.name),
                            source: 'linuxserver',
                            // Map configs if available, otherwise default to empty arrays
                            ports: (app.config?.ports ?? []).map((p: LsioPort) => `${p.external || p.internal}:${p.internal}/${p.protocol || 'tcp'}`),
                            volumes: (app.config?.volumes ?? []).map((v: LsioVolume) => {
                                const folderName = v.path.split('/').filter(Boolean).pop() || 'data';
                                return {
                                    container: v.path,
                                    bind: `./${folderName}`
                                };
                            }),
                            env: (app.config?.environment ?? []).map((e: LsioEnvVar) => ({
                                name: e.name,
                                label: e.desc || e.name,
                                default: e.default || ''
                            }))
                        }));

                        console.log(`[Templates] Fetched ${templates.length} templates from LSIO`);
                        if (debug) console.debug('[Templates:debug] LSIO sample:', templates.slice(0, 5).map(t => t.title));
                        return templates;
                    }

                    // Legacy Portainer v2 Format (Fallback for custom registries)
                    // The Portainer v2 spec includes a native `categories` field; pass it through.
                    const response = await axios.get<TemplatesResponse>(registryUrl, TemplateService.REGISTRY_FETCH_OPTIONS);
                    const templates = (response.data.templates || [])
                        .filter((t: Template) => !!t.image && t.type === 1)
                        .map((t: Template) => ({ ...t, source: 'custom' }));

                    console.log(`[Templates] Fetched ${templates.length} templates from custom registry`);
                    return templates;
                },
            );
        } catch (error) {
            console.error('[Templates] Failed to fetch from registry:', error);
            // Match the stable axios error code first; fall back to the
            // message text in case a transport reports the cap differently.
            const oversized = axios.isAxiosError(error)
                && (error.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED'
                    || /maxContentLength|maxBodyLength/i.test(error.message ?? ''));
            if (oversized) {
                throw new Error('Could not fetch templates from registry (response exceeded the size limit)', { cause: error });
            }
            throw new Error('Could not fetch templates from registry', { cause: error });
        }
    }

    public generateComposeFromTemplate(template: Template, serviceName: string): string {
        const service: ComposeServiceDefinition = { restart: 'unless-stopped' };

        if (template.image) {
            service.image = template.image;
        }

        if (template.ports && template.ports.length > 0) {
            service.ports = [...template.ports];
        }

        if (template.volumes && template.volumes.length > 0) {
            const volumes: string[] = [];
            for (const vol of template.volumes) {
                if (typeof vol === 'string') {
                    // Pass string volumes through verbatim; the YAML emitter
                    // handles any escaping the raw value needs.
                    volumes.push(vol);
                } else if (vol.container) {
                    const containerPath = vol.container;
                    const containerFolder = containerPath.split('/').filter(Boolean).pop() || 'data';
                    const hostPath = vol.bind ? vol.bind : `./${containerFolder}`;
                    const options = vol.readonly ? ':ro' : '';
                    volumes.push(`${hostPath}:${containerPath}${options}`);
                }
            }
            if (volumes.length > 0) {
                service.volumes = volumes;
            }
        }

        if (template.env && template.env.length > 0) {
            service.env_file = ['.env'];
        }

        // Serialize through the YAML emitter so registry-supplied values are
        // escaped correctly instead of interpolated raw into hand-built lines.
        return YAML.stringify({ services: { [serviceName]: service } }, { lineWidth: 0 });
    }

    public generateEnvString(envVars: Record<string, string>): string {
        return Object.entries(envVars)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
    }
}

export const templateService = new TemplateService();
