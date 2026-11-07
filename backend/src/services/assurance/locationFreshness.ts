/**
 * A persisted authored location is a fact about one run: the file held that
 * text at that line when the run read it. Once the file changes, the range no
 * longer names what the finding reports, so the link is dropped until the next
 * run rather than opening an unrelated line. The finding itself stays; only
 * the coordinates go.
 *
 * The check reads each located file once per call and compares its sha256 with
 * the digest stored beside the range. A missing digest (a row stored before
 * this check existed), an unreadable file, or a digest mismatch all count as
 * "not proven unchanged", which is the same answer as "changed": no link.
 */
import { FileSystemService } from '../FileSystemService';
import { sha256Hex } from '../../utils/hashing';
import { MAX_COMPOSE_PARSE_BYTES } from '../composeSource/parseComposeDocument';
import type { AssuranceFinding, AssuranceLocation } from './finding';

/** Keep the logical source path, drop every field that pointed into a range. */
function withoutAuthoredRange(location: AssuranceLocation): AssuranceLocation | undefined {
  return location.path === undefined ? undefined : { path: location.path };
}

async function currentFileHash(nodeId: number, stackName: string, file: string): Promise<string | null> {
  try {
    const read = await FileSystemService.getInstance(nodeId).readStackFile(stackName, file, MAX_COMPOSE_PARSE_BYTES);
    if (read.content === undefined || read.binary || read.oversized) return null;
    return sha256Hex(read.content);
  } catch {
    // Unreadable is not unchanged: the range cannot be proven current.
    return null;
  }
}

/**
 * Strip the authored range from every finding whose located file is not
 * provably identical to the content the run stored a digest for.
 */
export async function dropStaleStoredLocations(
  nodeId: number,
  stackName: string,
  findings: readonly AssuranceFinding[],
): Promise<AssuranceFinding[]> {
  const hashes = new Map<string, Promise<string | null>>();
  const fileHash = (file: string): Promise<string | null> => {
    let pending = hashes.get(file);
    if (!pending) {
      pending = currentFileHash(nodeId, stackName, file);
      hashes.set(file, pending);
    }
    return pending;
  };

  return Promise.all(findings.map(async (finding) => {
    const location = finding.location;
    if (location?.file === undefined) return finding;
    if (location.fileHash !== undefined && await fileHash(location.file) === location.fileHash) return finding;
    return { ...finding, location: withoutAuthoredRange(location) };
  }));
}
