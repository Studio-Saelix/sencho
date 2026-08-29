import { promises as fsPromises } from 'fs';
import path from 'path';
import { FileSystemService } from '../services/FileSystemService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { isValidStackName } from '../utils/validation';

export async function copyPreparedPayloadDirectory(srcDir: string, destDir: string): Promise<void> {
  const destRoot = path.resolve(destDir);
  await fsPromises.mkdir(destRoot, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.resolve(destRoot, entry.name);
    if (!dest.startsWith(destRoot + path.sep)) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, destRoot);
      continue;
    }
    if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}

/**
 * Copy a prepared payload bundle into a stack directory before compose runs.
 * Used when hop-1 discovery stored the exact bytes the operation will execute.
 */
export async function materializePreparedSourceToStack(
  prepId: string,
  nodeId: number,
  stackName: string,
): Promise<void> {
  if (!isValidStackName(stackName)) {
    throw new Error('Invalid stack name');
  }
  const store = PreparedSourceStore.getInstance();
  const payloadPath = store.peekPayloadPath(prepId);
  const fsSvc = FileSystemService.getInstance(nodeId);
  const baseResolved = path.resolve(fsSvc.getBaseDir());
  const stackDir = path.resolve(baseResolved, stackName);
  if (!stackDir.startsWith(baseResolved + path.sep)) {
    throw new Error('Invalid stack path');
  }
  await fsPromises.mkdir(stackDir, { recursive: true, mode: 0o700 });

  await copyPreparedPayloadDirectory(payloadPath, stackDir);
}

async function copyTree(srcDir: string, destDir: string, stackRoot: string): Promise<void> {
  await fsPromises.mkdir(destDir, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.resolve(destDir, entry.name);
    if (!dest.startsWith(stackRoot + path.sep)) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, stackRoot);
      continue;
    }
    if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}
