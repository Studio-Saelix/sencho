import { useEffect, useState } from 'react';
import type { ContainerInfo } from '../EditorView';
import type { EffectiveServiceSpec } from '@/types/effectiveServices';
import type { GitSourcePendingMap } from '@/lib/gitopsState';

export const LOGS_MODE_STORAGE_KEY = 'sencho.stackView.logsMode';

type LogsMode = 'structured' | 'raw';

type EditorTab = 'compose' | 'env' | 'files';

interface BackupInfo {
  exists: boolean;
  timestamp: number | null;
}

function readLogsMode(): LogsMode {
  if (typeof window === 'undefined') return 'structured';
  return (localStorage.getItem(LOGS_MODE_STORAGE_KEY) as LogsMode | null) ?? 'structured';
}

export function useEditorViewState() {
  const [stackMisconfigScanning, setStackMisconfigScanning] = useState(false);

  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [composeEtag, setComposeEtag] = useState<string | null>(null);
  const [envContent, setEnvContent] = useState<string>('');
  const [originalEnvContent, setOriginalEnvContent] = useState<string>('');
  const [envEtag, setEnvEtag] = useState<string | null>(null);
  const [envExists, setEnvExists] = useState<boolean>(false);
  const [envFiles, setEnvFiles] = useState<string[]>([]);
  const [selectedEnvFile, setSelectedEnvFile] = useState<string>('');
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [containersLoadStatus, setContainersLoadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [containersLoadError, setContainersLoadError] = useState<string | null>(null);
  // Declared-service facts for the loaded stack, from the effective Compose
  // model. Empty for a single-service stack, an older node without the
  // service-scoped-update capability, or a render failure; all three cases
  // fail closed to the legacy per-container layout (no declared-service
  // headers), so this array doubles as the multi-service gate.
  const [effectiveServices, setEffectiveServices] = useState<EffectiveServiceSpec[]>([]);
  // The declared service currently running a manual update/rebuild, so the
  // owning header can show a busy state. Only one at a time, mirroring the
  // single `loadingAction` for stack-level operations.
  const [serviceUpdateInProgress, setServiceUpdateInProgress] = useState<{ service: string; mode: 'update' | 'rebuild' } | null>(null);

  const [activeTab, setActiveTab] = useState<EditorTab>('compose');
  const [logsMode, setLogsMode] = useState<LogsMode>(readLogsMode);
  useEffect(() => {
    try { localStorage.setItem(LOGS_MODE_STORAGE_KEY, logsMode); } catch { /* ignore */ }
  }, [logsMode]);

  const [gitSourceOpen, setGitSourceOpen] = useState(false);
  // Keyed by the API's stack_name and read by the sidebar's file key, which
  // coincide for every stack the sidebar can show. A key being present means a
  // Git candidate is waiting; the value names which state it is waiting in.
  const [gitSourcePendingMap, setGitSourcePendingMap] = useState<GitSourcePendingMap>({});
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [backupInfo, setBackupInfo] = useState<BackupInfo>({ exists: false, timestamp: null });
  const [isEditing, setIsEditing] = useState(false);
  const [editingCompose, setEditingCompose] = useState(false);

  return {
    stackMisconfigScanning, setStackMisconfigScanning,
    content, setContent,
    originalContent, setOriginalContent,
    composeEtag, setComposeEtag,
    envContent, setEnvContent,
    originalEnvContent, setOriginalEnvContent,
    envEtag, setEnvEtag,
    envExists, setEnvExists,
    envFiles, setEnvFiles,
    selectedEnvFile, setSelectedEnvFile,
    containers, setContainers,
    containersLoadStatus, setContainersLoadStatus,
    containersLoadError, setContainersLoadError,
    effectiveServices, setEffectiveServices,
    serviceUpdateInProgress, setServiceUpdateInProgress,
    activeTab, setActiveTab,
    logsMode, setLogsMode,
    gitSourceOpen, setGitSourceOpen,
    gitSourcePendingMap, setGitSourcePendingMap,
    isFileLoading, setIsFileLoading,
    backupInfo, setBackupInfo,
    isEditing, setIsEditing,
    editingCompose, setEditingCompose,
  } as const;
}
