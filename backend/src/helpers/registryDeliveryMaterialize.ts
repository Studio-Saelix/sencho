import { promises as fsPromises } from 'fs';
import path from 'path';
import { FileSystemService } from '../services/FileSystemService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { isPathWithinBase } from '../utils/validation';

/**
 * Copy a prepared payload bundle into a stack directory before compose runs.
 * Used when hop-1 discovery stored the exact bytes the operation will execute.
 */
export async function materializePreparedSourceToStack(
  prepId: string,
  nodeId: number,
  stackName: string,
): Promise<void> {
  const store = PreparedSourceStore.getInstance();
  const payloadPath = store.peekPayloadPath(prepId);
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackDir = path.join(fsSvc.getBaseDir(), stackName);
  const baseDir = fsSvc.getBaseDir();
  if (!isPathWithinBase(stackDir, baseDir)) {
    throw new Error('Invalid stack path');
  }
  await fsPromises.mkdir(stackDir, { recursive: true, mode: 0o700 });

  const entries = await fsPromises.readdir(payloadPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(payloadPath, entry.name);
    const dest = path.join(stackDir, entry.name);
    if (!isPathWithinBase(dest, stackDir)) continue;
    if (entry.isDirectory()) {
      await copyTree(src, dest, stackDir);
      continue;
    }
    if (entry.isFile()) {
      await fsPromises.copyFile(src, dest);
      await fsPromises.chmod(dest, 0o600);
    }
  }
}

async function copyTree(srcDir: string, destDir: string, stackRoot: string): Promise<void> {
  await fsPromises.mkdir(destDir, { recursive: true, mode: 0o700 });
  const entries = await fsPromises.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (!isPathWithinBase(dest, stackRoot)) continue;
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
