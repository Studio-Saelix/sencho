import { useState, useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Search, Rocket, Loader2, Info, ExternalLink, Star, ShieldCheck } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { apiFetch, withDeploySession } from '@/lib/api';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { CategorySidebar } from '@/components/appstore/CategorySidebar';
import { FeaturedHero } from '@/components/appstore/FeaturedHero';
import { TemplateTile } from '@/components/appstore/TemplateTile';
import type { Template } from '@/components/appstore/types';

function isValidPort(value: string): boolean {
    if (!value) return true;
    const num = Number(value);
    return Number.isInteger(num) && num >= 1 && num <= 65535;
}

interface PortInUseInfo {
    stack: string | null;
    container: string;
}

interface AppStoreViewProps {
    onDeploySuccess: (stackName: string) => void;
}

export function AppStoreView({ onDeploySuccess }: AppStoreViewProps) {
    const { can } = useAuth();
    const { activeNode } = useNodes();
    const { runWithLog } = useDeployFeedback();
    const [templates, setTemplates] = useState<Template[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
    const [isSheetOpen, setIsSheetOpen] = useState(false);
    const [stackName, setStackName] = useState('');
    const [envVars, setEnvVars] = useState<Record<string, string>>({});
    const [isDeploying, setIsDeploying] = useState(false);
    const [loading, setLoading] = useState(true);

    const [selectedCategory, setSelectedCategory] = useState<string>('All');
    const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});
    const [portVars, setPortVars] = useState<Record<string, string>>({});
    const [isDescExpanded, setIsDescExpanded] = useState(false);
    const [volVars, setVolVars] = useState<Record<string, string>>({});
    const [customEnvs, setCustomEnvs] = useState<Array<{ key: string; value: string }>>([]);
    const [newEnvKey, setNewEnvKey] = useState('');
    const [portsInUse, setPortsInUse] = useState<Record<string, PortInUseInfo>>({});
    const [newEnvVal, setNewEnvVal] = useState('');
    const [autoScan, setAutoScan] = useState(true);
    const [trivyAvailable, setTrivyAvailable] = useState(false);
    const [sheetTab, setSheetTab] = useState<'essentials' | 'advanced'>('essentials');

    // The template registry is node-scoped, so the catalogue (and Trivy
    // availability) must reload when the active node changes. The cancelled
    // flag drops a slow response from a previous node so it cannot overwrite
    // the current node's catalogue after a fast switch.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const res = await apiFetch('/templates');
                if (!res.ok) throw new Error('Failed to fetch templates');
                const data = await res.json();
                if (!cancelled) setTemplates(data || []);
            } catch (err) {
                if (!cancelled) toast.error(err instanceof Error ? err.message : 'Failed to load App Store');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        apiFetch('/security/trivy-status')
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (!cancelled && d) setTrivyAvailable(!!d.available); })
            .catch((err) => {
                console.error('Failed to fetch Trivy status:', err);
            });
        return () => { cancelled = true; };
    }, [activeNode?.id]);

    const handleSelectTemplate = (t: Template) => {
        const envsCopy = [...(t.env || [])];
        if (!envsCopy.find(e => e.name === 'PUID')) envsCopy.push({ name: 'PUID', label: 'User ID (PUID)', default: '1000' });
        if (!envsCopy.find(e => e.name === 'PGID')) envsCopy.push({ name: 'PGID', label: 'Group ID (PGID)', default: '1000' });
        if (!envsCopy.find(e => e.name === 'TZ')) {
            const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
            envsCopy.push({ name: 'TZ', label: 'Timezone', default: browserTz });
        }

        const templateCopy: Template = { ...t, env: envsCopy };
        setSelectedTemplate(templateCopy);

        const initEnvs: Record<string, string> = {};
        envsCopy.forEach(e => {
            initEnvs[e.name] = e.default || '';
        });
        setEnvVars(initEnvs);

        const initVols: Record<string, string> = {};
        t.volumes?.forEach((v) => {
            if (v.container) {
                initVols[v.container] = v.bind || `./${v.container.split('/').filter(Boolean).pop() || 'data'}`;
            }
        });
        setVolVars(initVols);
        setCustomEnvs([]);
        setNewEnvKey('');
        setNewEnvVal('');

        const initPorts: Record<string, string> = {};
        t.ports?.forEach(p => {
            const parts = p.split(':');
            if (parts.length > 1) {
                initPorts[p] = parts[0];
            }
        });
        setPortVars(initPorts);
        setIsDescExpanded(false);
        setSheetTab('essentials');

        const defaultName = t.title
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        setStackName(defaultName);

        setPortsInUse({});
        apiFetch('/ports/in-use').then(r => r.ok ? r.json() : {}).then(setPortsInUse).catch(err => console.error('[AppStore] Failed to fetch ports in use:', err));

        setIsSheetOpen(true);
    };

    const handleDeploy = async () => {
        if (!selectedTemplate) return;
        if (!stackName.trim()) {
            toast.error('Stack name is required');
            return;
        }

        const invalidPort = Object.entries(portVars).find(([, val]) => val && !isValidPort(val));
        if (invalidPort) {
            toast.error(`Invalid port: ${invalidPort[1]}. Ports must be between 1 and 65535.`);
            return;
        }

        try {
            const checkRes = await apiFetch('/stacks');
            if (checkRes.ok) {
                const existingStacks: string[] = await checkRes.json();
                if (existingStacks.includes(stackName.trim())) {
                    toast.error(`A stack named "${stackName.trim()}" already exists. Choose a different name.`);
                    return;
                }
            }
        } catch (checkErr) {
            console.warn('[AppStore] Pre-deploy duplicate check failed, proceeding:', checkErr);
        }

        setIsDeploying(true);

        const modifiedTemplate: Template = { ...selectedTemplate };
        if (modifiedTemplate.ports) {
            modifiedTemplate.ports = modifiedTemplate.ports.map(p => {
                const parts = p.split(':');
                if (parts.length > 1 && portVars[p]) {
                    return `${portVars[p]}:${parts[1]}`;
                }
                return p;
            });
        }

        if (modifiedTemplate.volumes) {
            modifiedTemplate.volumes = modifiedTemplate.volumes.map((v) => {
                if (v.container && volVars[v.container] !== undefined) {
                    return { ...v, bind: volVars[v.container] };
                }
                return v;
            });
        }

        const finalEnvVars = { ...envVars };
        customEnvs.forEach(ce => {
            if (ce.key.trim()) finalEnvVars[ce.key.trim()] = ce.value;
        });

        try {
            const result = await runWithLog({ stackName: stackName.trim(), action: 'install' }, async (started, ds) => {
                await started;
                const res = await apiFetch('/templates/deploy', withDeploySession(ds, {
                    method: 'POST',
                    body: JSON.stringify({
                        stackName: stackName.trim(),
                        template: modifiedTemplate,
                        envVars: finalEnvVars,
                        skip_scan: !autoScan,
                    }),
                }));
                const data = await res.json();
                if (!res.ok) return { ok: false, errorMessage: data.error || 'Failed to deploy template' };
                return { ok: true };
            });
            if (result.ok) {
                toast.success(`${selectedTemplate?.title} deployed successfully!`);
                setIsSheetOpen(false);
                onDeploySuccess(stackName.trim());
            } else {
                toast.error(result.errorMessage || 'Deployment failed');
            }
        } finally {
            setIsDeploying(false);
        }
    };

    const categoryEntries = useMemo(() => {
        const counts = new Map<string, number>();
        templates.forEach(t => {
            t.categories?.forEach(c => {
                counts.set(c, (counts.get(c) || 0) + 1);
            });
        });
        const sorted = Array.from(counts.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count }));
        return [{ name: 'All', count: templates.length }, ...sorted];
    }, [templates]);

    const filtered = useMemo(() => templates.filter(t => {
        const matchesCategory = selectedCategory === 'All' || t.categories?.includes(selectedCategory);
        const q = searchQuery.toLowerCase();
        const matchesSearch = !q ||
            t.title.toLowerCase().includes(q) ||
            t.description?.toLowerCase().includes(q) ||
            (t.categories && t.categories.join(' ').toLowerCase().includes(q));
        return matchesCategory && matchesSearch;
    }), [templates, selectedCategory, searchQuery]);

    const featuredTemplate = useMemo(() => {
        if (searchQuery) return null;
        return filtered.find(t => t.featured) || null;
    }, [filtered, searchQuery]);

    const gridTemplates = useMemo(() => {
        const base = featuredTemplate
            ? filtered.filter(t => t.title !== featuredTemplate.title)
            : filtered;
        return [...base].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    }, [filtered, featuredTemplate]);

    const essentialsConflicts = useMemo(() => {
        if (!selectedTemplate?.ports) return [];
        const seen = new Set<string>();
        const conflicts: Array<{ host: string; info: PortInUseInfo }> = [];
        for (const p of selectedTemplate.ports) {
            const parts = p.split(':');
            if (parts.length < 2) continue;
            const host = portVars[p] || parts[0];
            if (!host || seen.has(host)) continue;
            seen.add(host);
            const info = portsInUse[host];
            if (info) conflicts.push({ host, info });
        }
        return conflicts;
    }, [selectedTemplate, portVars, portsInUse]);

    return (
        <div className="flex flex-col h-full gap-5">
            <div className="flex items-center gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Search App Store..."
                        className="pl-8"
                        value={searchQuery}
                        onChange={(e) => { setSearchQuery(e.target.value); }}
                    />
                </div>
                <span className="text-xs text-stat-subtitle font-mono tabular-nums shrink-0">
                    {filtered.length} app{filtered.length !== 1 ? 's' : ''}
                </span>
            </div>

            <div className="flex flex-1 min-h-0 gap-5">
                {!loading && categoryEntries.length > 1 && (
                    <CategorySidebar
                        categories={categoryEntries}
                        selected={selectedCategory}
                        onSelect={setSelectedCategory}
                    />
                )}

                <ScrollArea className="flex-1">
                    {loading ? (
                        <div className="flex items-center justify-center h-48">
                            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : (
                        <div className="flex flex-col gap-5 pb-8 pr-4">
                            {featuredTemplate && (
                                <FeaturedHero
                                    template={featuredTemplate}
                                    category={selectedCategory !== 'All' ? selectedCategory : undefined}
                                    onOpen={handleSelectTemplate}
                                    imgError={!!featuredTemplate.logo && !!imgErrors[featuredTemplate.logo]}
                                    onImgError={() => featuredTemplate.logo && setImgErrors(prev => ({ ...prev, [featuredTemplate.logo!]: true }))}
                                />
                            )}

                            {gridTemplates.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                    {gridTemplates.map((t, idx) => (
                                        <TemplateTile
                                            key={`${t.title}-${idx}`}
                                            template={t}
                                            onSelect={handleSelectTemplate}
                                            imgError={!!t.logo && !!imgErrors[t.logo]}
                                            onImgError={() => t.logo && setImgErrors(prev => ({ ...prev, [t.logo!]: true }))}
                                        />
                                    ))}
                                </div>
                            ) : !featuredTemplate ? (
                                <div className="py-12 text-center text-muted-foreground">
                                    <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                    {templates.length === 0 ? (
                                        <p>Registry returned no templates. Check your registry URL in Settings.</p>
                                    ) : (
                                        <p>No apps found matching "{searchQuery}"</p>
                                    )}
                                </div>
                            ) : null}
                        </div>
                    )}
                </ScrollArea>
            </div>

            <SystemSheet
                open={isSheetOpen}
                onOpenChange={setIsSheetOpen}
                crumb={['App store', selectedTemplate?.title ?? 'Template']}
                name={selectedTemplate?.title ?? 'Template'}
                meta={selectedTemplate
                    ? [
                        selectedTemplate.architectures?.join(', '),
                        selectedTemplate.stars !== undefined ? `★ ${selectedTemplate.stars.toLocaleString()}` : null,
                        activeNode?.type === 'remote' ? `→ ${activeNode.name}` : null,
                    ].filter(Boolean).join(' · ')
                    : ''}
                tabs={selectedTemplate ? [
                    { id: 'essentials', label: 'Essentials' },
                    { id: 'advanced', label: 'Advanced' },
                ] : undefined}
                activeTab={sheetTab}
                onTabChange={(id) => setSheetTab(id as 'essentials' | 'advanced')}
                primaryAction={selectedTemplate ? {
                    label: isDeploying ? 'Deploying…' : `Deploy ${selectedTemplate.title}`,
                    icon: isDeploying ? Loader2 : Rocket,
                    onClick: handleDeploy,
                    disabled: isDeploying || !stackName.trim() || !can('stack:create'),
                } : undefined}
                footerContext={isDeploying ? 'This may take a few minutes for large images.' : undefined}
                size="md"
            >
                {selectedTemplate && (
                    <>
                        <SheetSection title="About">
                            <div className="flex items-start gap-4">
                                <div className="w-16 h-16 rounded bg-muted/50 p-1 flex-shrink-0 flex items-center justify-center overflow-hidden border">
                                    {selectedTemplate.logo && !imgErrors[selectedTemplate.logo] ? (
                                        <img src={selectedTemplate.logo} alt={selectedTemplate.title} className="w-full h-full object-contain" onError={() => setImgErrors(prev => ({ ...prev, [selectedTemplate.logo!]: true }))} />
                                    ) : (
                                        <Rocket className="w-8 h-8 text-muted-foreground" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={isDescExpanded ? 'text-sm text-stat-subtitle' : 'line-clamp-3 text-sm text-stat-subtitle'}>
                                        {selectedTemplate.description}
                                    </p>
                                    <button
                                        type="button"
                                        className="text-xs text-primary cursor-pointer hover:underline mt-1 inline-block"
                                        onClick={() => setIsDescExpanded(!isDescExpanded)}
                                    >
                                        {isDescExpanded ? 'Read less' : 'Read more'}
                                    </button>

                                    {(selectedTemplate.architectures || selectedTemplate.stars !== undefined || selectedTemplate.github_url || selectedTemplate.docs_url) && (
                                        <div className="mt-3 space-y-2">
                                            {selectedTemplate.architectures && selectedTemplate.architectures.length > 0 && (
                                                <div className="flex flex-wrap gap-1">
                                                    {selectedTemplate.architectures.map(arch => (
                                                        <Badge variant="outline" key={arch} className="text-[10px] px-1.5 py-0">
                                                            {arch}
                                                        </Badge>
                                                    ))}
                                                </div>
                                            )}
                                            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                                {selectedTemplate.stars !== undefined && (
                                                    <div className="flex items-center gap-1">
                                                        <Star className="w-3 h-3 fill-muted-foreground" />
                                                        <span className="tabular-nums">{selectedTemplate.stars?.toLocaleString()}</span>
                                                    </div>
                                                )}
                                                {selectedTemplate.github_url && (
                                                    <a href={selectedTemplate.github_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-foreground transition-colors">
                                                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>
                                                        <span>Source</span>
                                                    </a>
                                                )}
                                                {selectedTemplate.docs_url && (
                                                    <a href={selectedTemplate.docs_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-foreground transition-colors">
                                                        <ExternalLink className="w-3 h-3" />
                                                        <span>Docs</span>
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </SheetSection>

                        {sheetTab === 'essentials' && (
                            <SheetSection title="Stack name">
                                <div className="space-y-2">
                                    <Label htmlFor="stackName" className="font-semibold">
                                        Stack Name <span className="text-destructive">*</span>
                                    </Label>
                                    <Input
                                        id="stackName"
                                        value={stackName}
                                        onChange={(e) => setStackName(e.target.value)}
                                        placeholder="e.g. my-app"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        This determines the directory name and docker project name.
                                    </p>
                                </div>

                                {essentialsConflicts.length > 0 ? (
                                    <div role="status" aria-live="polite" className="mt-3 relative overflow-hidden rounded-md border border-warning/30 bg-warning/8 pl-4 pr-3 py-2.5">
                                        <span className="absolute inset-y-0 left-0 w-[3px] bg-warning/70 animate-pulse" aria-hidden />
                                        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                                            Port conflict
                                        </div>
                                        <ul className="mt-1 space-y-0.5 text-xs leading-snug text-stat-value">
                                            {essentialsConflicts.map(({ host, info }) => (
                                                <li key={host}>
                                                    Port <span className="font-mono">{host}</span> is in use by{' '}
                                                    <span className="text-brand">{info.stack ?? 'an external app'}</span>.
                                                </li>
                                            ))}
                                        </ul>
                                        <p className="mt-1.5 text-xs text-stat-subtitle">
                                            Switch to the Advanced tab to remap.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-stat-subtitle">
                                        Deploy with defaults: the template's recommended ports, volumes, and environment variables.
                                        Use the Advanced tab to customize.
                                    </div>
                                )}
                            </SheetSection>
                        )}

                        {sheetTab === 'advanced' && (
                            <>
                                {selectedTemplate.ports && selectedTemplate.ports.length > 0 && (
                                    <SheetSection title="Ports (Host : Container)">
                                        <div className="space-y-3">
                                            {selectedTemplate.ports.map((p, idx) => {
                                                const parts = p.split(':');
                                                if (parts.length < 2) return null;
                                                const hostPort = portVars[p] || '';
                                                const conflict = hostPort ? portsInUse[hostPort] : undefined;
                                                return (
                                                    <div key={idx} className="flex items-center space-x-2">
                                                        <Input
                                                            value={hostPort}
                                                            onChange={(e) => {
                                                                const val = e.target.value.replace(/[^0-9]/g, '');
                                                                setPortVars(prev => ({ ...prev, [p]: val }));
                                                            }}
                                                            className={cn('w-24 text-center font-mono', hostPort && !isValidPort(hostPort) && 'border-destructive')}
                                                        />
                                                        <span className="text-muted-foreground font-mono">: {parts[1]}</span>
                                                        {conflict && (
                                                            <>
                                                                <span className="text-xs text-warning font-mono">
                                                                    in use by{' '}
                                                                    <span className="text-brand">{conflict.stack ?? 'an external app'}</span>
                                                                </span>
                                                                <span className="w-2 h-2 rounded-full bg-warning animate-pulse" aria-hidden />
                                                            </>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </SheetSection>
                                )}

                                {selectedTemplate.volumes && selectedTemplate.volumes.length > 0 && (
                                    <SheetSection title="Volumes (Host : Container)">
                                        <div className="space-y-3">
                                            {selectedTemplate.volumes.map((v, idx) => {
                                                const containerPath = v.container;
                                                if (!containerPath) return null;
                                                return (
                                                    <div key={idx} className="space-y-1.5">
                                                        <Label className="text-xs text-muted-foreground font-mono">Container: {containerPath}</Label>
                                                        <Input
                                                            value={volVars[containerPath] !== undefined ? volVars[containerPath] : ''}
                                                            onChange={(e) => setVolVars(prev => ({ ...prev, [containerPath]: e.target.value }))}
                                                            placeholder="/path/to/host/dir"
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </SheetSection>
                                )}

                                {selectedTemplate.env && selectedTemplate.env.length > 0 && (
                                    <SheetSection title="Environment variables">
                                        <div className="space-y-3">
                                            {selectedTemplate.env.map((e, idx) => (
                                                <div key={idx} className="space-y-1.5">
                                                    <Label htmlFor={`env-${e.name}`} className="text-sm">
                                                        {e.label || e.name}
                                                    </Label>
                                                    <Input
                                                        id={`env-${e.name}`}
                                                        value={envVars[e.name] !== undefined ? envVars[e.name] : ''}
                                                        onChange={(ev) => setEnvVars(prev => ({ ...prev, [e.name]: ev.target.value }))}
                                                        placeholder={e.default || `Enter value for ${e.name}`}
                                                    />
                                                    <p className="text-[10px] text-muted-foreground font-mono">
                                                        {e.name}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>
                                    </SheetSection>
                                )}

                                <SheetSection title="Custom variables">
                                    <div className="space-y-3">
                                        {customEnvs.map((ce, idx) => (
                                            <div key={idx} className="flex gap-2">
                                                <Input value={ce.key} readOnly className="w-1/3 bg-muted font-mono text-xs" />
                                                <Input value={ce.value} readOnly className="flex-1 bg-muted font-mono text-xs" />
                                                <Button variant="ghost" size="icon" className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground" onClick={() => setCustomEnvs(prev => prev.filter((_, i) => i !== idx))}>-</Button>
                                            </div>
                                        ))}
                                        <div className="flex gap-2">
                                            <Input placeholder="KEY" value={newEnvKey} onChange={e => setNewEnvKey(e.target.value)} className="w-1/3 font-mono text-xs" />
                                            <Input placeholder="VALUE" value={newEnvVal} onChange={e => setNewEnvVal(e.target.value)} className="flex-1 font-mono text-xs" />
                                            <Button variant="secondary" onClick={() => {
                                                if (newEnvKey.trim()) {
                                                    if (selectedTemplate?.env?.find(e => e.name === newEnvKey.trim())) {
                                                        toast.warning(`"${newEnvKey.trim()}" already exists in template defaults. The custom value will override it.`);
                                                    }
                                                    setCustomEnvs(prev => [...prev, { key: newEnvKey, value: newEnvVal }]);
                                                    setNewEnvKey('');
                                                    setNewEnvVal('');
                                                }
                                            }}>+</Button>
                                        </div>
                                    </div>
                                </SheetSection>

                                {trivyAvailable && (
                                    <SheetSection title="Security">
                                        <div className="flex items-center gap-2">
                                            <Checkbox
                                                id="auto-scan"
                                                checked={autoScan}
                                                onCheckedChange={(checked) => setAutoScan(!!checked)}
                                            />
                                            <Label
                                                htmlFor="auto-scan"
                                                className="text-sm text-muted-foreground cursor-pointer flex items-center gap-1.5"
                                            >
                                                <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                Scan images for vulnerabilities after deploy
                                            </Label>
                                        </div>
                                    </SheetSection>
                                )}
                            </>
                        )}
                    </>
                )}
            </SystemSheet>
        </div>
    );
}
