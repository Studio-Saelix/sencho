import path from 'path';
import { FileSystemService } from '../services/FileSystemService';
import { StackOpLockService } from '../services/StackOpLockService';
import { StackUpdateRecoveryService } from '../services/StackUpdateRecoveryService';
import { isValidStackName } from '../utils/validation';
import { invalidateNodeCaches } from './cacheInvalidation';
import {
  FLEET_SNAPSHOT_APPLY_FILENAMES,
  type FleetSnapshotApplyFilename,
} from '../utils/snapshot-capture';

export interface FleetSnapshotApplyFile {
  filename: FleetSnapshotApplyFilename;
  content: string;
}

/** Keep compose.yaml and .env; ignore any other snapshot filenames. */
export function selectFleetSnapshotApplyFiles(
  files: Array<{ filename: string; content: string }>,
): FleetSnapshotApplyFile[] {
  return files.filter((file): file is FleetSnapshotApplyFile =>
    FLEET_SNAPSHOT_APPLY_FILENAMES.some((name) => name === file.filename),
  );
}

export interface ApplyFleetSnapshotFilesInput {
  nodeId: number;
  stackName: string;
  files: FleetSnapshotApplyFile[];
  actor: string;
}

export interface ApplyFleetSnapshotFilesResult {
  capturedGenerationId: string | null;
}

type CodedError = Error & { code: string };

export function getCodedError(error: unknown): CodedError | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return undefined;
  }
  return error as CodedError;
}

export type FleetSnapshotApplyConflictCode = 'stack_op_in_progress' | 'HEALTH_GATE_OBSERVING';

export function fleetSnapshotApplyConflictCode(error: unknown): FleetSnapshotApplyConflictCode | undefined {
  const code = getCodedError(error)?.code;
  if (code === 'stack_op_in_progress' || code === 'HEALTH_GATE_OBSERVING') return code;
  return undefined;
}

function codedError(message: string, code: string): CodedError {
  return Object.assign(new Error(message), { code });
}

async function writeApplyFile(
  fsSvc: FileSystemService,
  stackName: string,
  file: FleetSnapshotApplyFile,
): Promise<void> {
  switch (file.filename) {
    case 'compose.yaml':
      await fsSvc.saveStackContent(stackName, file.content);
      return;
    case '.env':
      await fsSvc.saveEnvContent(stackName, file.content);
      return;
  }
}

/**
 * Capture-then-write used by Fleet snapshot restore on the node that owns the
 * stack. Takes the stack-op lock, then captures and writes. An existing Compose
 * project creates the current recovery generation before the first snapshot
 * file is written. Capture failure aborts with the live files unchanged. A
 * directory with no compose file is treated as a new stack and has no recovery
 * generation to roll back to.
 */
export async function applyFleetSnapshotFiles(
  input: ApplyFleetSnapshotFilesInput,
): Promise<ApplyFleetSnapshotFilesResult> {
  const { nodeId, stackName, files, actor } = input;
  if (!isValidStackName(stackName)) {
    throw codedError('Invalid stack name', 'INVALID_STACK_NAME');
  }
  if (files.length === 0) {
    throw codedError('No restoreable snapshot files', 'INVALID_SNAPSHOT_FILES');
  }

  const lock = await StackOpLockService.getInstance().runExclusive(
    nodeId,
    stackName,
    'backup',
    actor,
    async () => {
      const fsSvc = FileSystemService.getInstance(nodeId);
      const exists = await fsSvc.hasComposeFile(path.join(fsSvc.getBaseDir(), stackName));
      let capturedGenerationId: string | null = null;
      if (exists) {
        capturedGenerationId = (await StackUpdateRecoveryService.getInstance().captureCurrentBackup({
          nodeId,
          stackName,
          createdBy: actor,
        })).id;
      }
      for (const file of files) {
        await writeApplyFile(fsSvc, stackName, file);
      }
      invalidateNodeCaches(nodeId);
      return { capturedGenerationId };
    },
  );

  if (!lock.ran) {
    throw codedError(
      `Cannot restore "${stackName}": another operation (${lock.existing.action}) is already in progress.`,
      'stack_op_in_progress',
    );
  }
  return lock.result;
}
