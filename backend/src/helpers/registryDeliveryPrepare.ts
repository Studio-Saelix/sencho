import os from 'os';
import path from 'path';
import { promises as fsPromises } from 'fs';
import type { Template } from '../services/TemplateService';
import { templateService } from '../services/TemplateService';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { hashDeliverySourceDir, hashProjectSource } from './registryDeliveryHashes';
import type { RegistryDeliveryDiscoverRequest } from '../services/RegistryDeliveryService';
import type { CreateStackFromGitInput } from '../services/GitSourceService';

export interface PreparedSourceResult {
  prepId: string;
  sourceHash: string;
}

export async function prepareRequestGeneratedSource(input: {
  stackName: string;
  template: Template;
  envVars?: Record<string, string>;
}): Promise<PreparedSourceResult> {
  const composeYaml = templateService.generateComposeFromTemplate(input.template, input.stackName);
  const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-regprep-'));
  try {
    await fsPromises.writeFile(path.join(stagingDir, 'compose.yaml'), composeYaml, { mode: 0o600 });
    if (input.envVars && Object.keys(input.envVars).length > 0) {
      const envString = templateService.generateEnvString(input.envVars);
      await fsPromises.writeFile(path.join(stagingDir, '.env'), envString, { mode: 0o600 });
    }
    const sourceHash = hashProjectSource(stagingDir);
    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'request-generated',
      sourceHash,
      stagingDir,
    );
    return { prepId: entry.prepId, sourceHash };
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function prepareRestoreCandidateFromBackup(
  stackName: string,
  nodeId: number,
): Promise<PreparedSourceResult> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const backupInfo = await fsSvc.getBackupInfo(stackName);
  if (!backupInfo.exists) {
    throw new Error('No backup available for restore preparation');
  }
  const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-regprep-'));
  try {
    await fsSvc.copyBackupSlotToDir(stackName, stagingDir);
    const sourceHash = hashDeliverySourceDir(stagingDir);
    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'restore-candidate',
      sourceHash,
      stagingDir,
    );
    return { prepId: entry.prepId, sourceHash };
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function prepareRestoreCandidateFromRecoveryGeneration(
  stackName: string,
  nodeId: number,
  generationId: string,
): Promise<PreparedSourceResult> {
  const { RollbackGenerationStore } = await import('../services/RollbackGenerationStore');
  const stagingDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-regprep-'));
  try {
    await RollbackGenerationStore.copyPresentFilesToDir(nodeId, stackName, generationId, stagingDir);
    const sourceHash = hashDeliverySourceDir(stagingDir);
    const entry = await PreparedSourceStore.getInstance().prepareFromDirectory(
      'restore-candidate',
      sourceHash,
      stagingDir,
    );
    return { prepId: entry.prepId, sourceHash };
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function prepareRestoreCandidateForStack(
  stackName: string,
  nodeId: number,
): Promise<PreparedSourceResult> {
  const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
  const currentGen = StackUpdateRecoveryService.getInstance().getCurrent(nodeId, stackName);
  if (currentGen?.id) {
    return prepareRestoreCandidateFromRecoveryGeneration(stackName, nodeId, currentGen.id);
  }
  return prepareRestoreCandidateFromBackup(stackName, nodeId);
}

function gitInputFromDiscover(request: RegistryDeliveryDiscoverRequest): CreateStackFromGitInput | null {
  const git = request.git;
  if (!git || typeof git !== 'object') return null;
  const record = git as Record<string, unknown>;
  const stackName = typeof request.stack === 'string' ? request.stack : typeof record.stackName === 'string' ? record.stackName : '';
  const repoUrl = typeof record.repo_url === 'string' ? record.repo_url : typeof record.repoUrl === 'string' ? record.repoUrl : '';
  const branch = typeof record.branch === 'string' ? record.branch : '';
  const composePaths = Array.isArray(record.compose_paths)
    ? record.compose_paths.filter((p): p is string => typeof p === 'string')
    : typeof record.compose_path === 'string'
      ? [record.compose_path]
      : [];
  if (!stackName || !repoUrl || !branch || composePaths.length === 0) {
    return null;
  }
  return {
    stackName,
    repoUrl,
    branch,
    composePaths,
    contextDir: typeof record.context_dir === 'string' ? record.context_dir : null,
    syncEnv: record.sync_env === true,
    envPath: typeof record.env_path === 'string' ? record.env_path : null,
    authType: record.auth_type === 'token' ? 'token' : 'none',
    token: typeof record.token === 'string' ? record.token : null,
    autoApplyOnWebhook: record.auto_apply_on_webhook === true,
    autoDeployOnApply: record.auto_deploy_on_apply === true,
  };
}

export async function prepareGitCandidateSource(
  request: RegistryDeliveryDiscoverRequest,
): Promise<PreparedSourceResult> {
  if (request.gitApply === true && request.stack) {
    const { GitSourceService } = await import('../services/GitSourceService');
    return GitSourceService.getInstance().prepareRegistryDeliveryFromPending(request.stack);
  }
  const input = gitInputFromDiscover(request);
  if (!input) {
    throw new Error('Git candidate discovery is missing required fields');
  }
  const { GitSourceService } = await import('../services/GitSourceService');
  return GitSourceService.getInstance().prepareRegistryDeliveryFromGit(input);
}

export async function prepareSourceForDiscover(
  request: RegistryDeliveryDiscoverRequest,
): Promise<PreparedSourceResult | null> {
  switch (request.sourceKind) {
    case 'request-generated': {
      const stackName = typeof request.stackName === 'string'
        ? request.stackName
        : typeof request.stack === 'string'
          ? request.stack
          : '';
      if (!stackName || !request.template || typeof request.template !== 'object') {
        throw new Error('Template discovery is missing stackName or template');
      }
      return prepareRequestGeneratedSource({
        stackName,
        template: request.template as Template,
        envVars: request.envVars as Record<string, string> | undefined,
      });
    }
    case 'restore-candidate': {
      const stack = request.stack;
      if (!stack) throw new Error('Restore discovery requires stack');
      const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
      return prepareRestoreCandidateForStack(stack, nodeId);
    }
    case 'git-candidate':
      return prepareGitCandidateSource(request);
    case 'live-project':
    case 'body-content':
      return null;
    default:
      throw new Error(`Unsupported registry delivery source kind: ${request.sourceKind}`);
  }
}
