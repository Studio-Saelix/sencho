import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';

export interface ComposeDiscovery {
  composeDir: string;
  stackCount: number;
  adoptCandidateCount: number;
  adoptCandidatesTruncated: boolean;
}

export type ComposeDiscoveryProbe =
  | {
      composeDir: string;
      readable: true;
      discovery: ComposeDiscovery;
    }
  | {
      composeDir: string;
      readable: false;
      discovery: null;
      error: string;
    };

export async function probeComposeDiscovery(nodeId: number): Promise<ComposeDiscoveryProbe> {
  const { FileSystemService } = await import('./FileSystemService');
  const fsSvc = FileSystemService.getInstance(nodeId);
  const composeDir = fsSvc.getBaseDir();

  try {
    const stat = await fs.stat(composeDir);
    if (!stat.isDirectory()) {
      return {
        composeDir,
        readable: false,
        discovery: null,
        error: 'Compose path is not a directory.',
      };
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        composeDir,
        readable: false,
        discovery: null,
        error: 'Compose directory does not exist.',
      };
    }
    return {
      composeDir,
      readable: false,
      discovery: null,
      error: 'Compose directory is not readable.',
    };
  }

  try {
    await fs.access(composeDir, fsConstants.R_OK);
    await fs.readdir(composeDir);
  } catch {
    return {
      composeDir,
      readable: false,
      discovery: null,
      error: 'Compose directory is not readable.',
    };
  }

  const stackNames = await fsSvc.getStacks();
  const { count, truncated } = await fsSvc.countImportCandidates(100);

  return {
    composeDir,
    readable: true,
    discovery: {
      composeDir,
      stackCount: stackNames.length,
      adoptCandidateCount: count,
      adoptCandidatesTruncated: truncated,
    },
  };
}
