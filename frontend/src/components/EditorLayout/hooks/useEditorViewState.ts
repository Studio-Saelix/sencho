import { useEffect, useRef, useState } from 'react';
import type { ContainerInfo } from '../EditorView';

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
  const [copiedDigest, setCopiedDigest] = useState<string | null>(null);
  const copiedDigestTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copiedDigestTimerRef.current !== null) {
        window.clearTimeout(copiedDigestTimerRef.current);
      }
    };
  }, []);

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

  const [activeTab, setActiveTab] = useState<EditorTab>('compose');
  const [logsMode, setLogsMode] = useState<LogsMode>(readLogsMode);
  useEffect(() => {
    try { localStorage.setItem(LOGS_MODE_STORAGE_KEY, logsMode); } catch { /* ignore */ }
  }, [logsMode]);

  const [gitSourceOpen, setGitSourceOpen] = useState(false);
  const [gitSourcePendingMap, setGitSourcePendingMap] = useState<Record<string, boolean>>({});
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [backupInfo, setBackupInfo] = useState<BackupInfo>({ exists: false, timestamp: null });
  const [isEditing, setIsEditing] = useState(false);
  const [editingCompose, setEditingCompose] = useState(false);

  return {
    stackMisconfigScanning, setStackMisconfigScanning,
    copiedDigest, setCopiedDigest,
    copiedDigestTimerRef,
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
