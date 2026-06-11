import type { ParsedLogRow } from '@/components/log-rendering/composeLogParser';
import type { ActionVerb } from '@/context/DeployFeedbackContext';

// Classify the current operation phase from streamed compose output, returning a
// display label or null before any phase marker. The backend emits explicit
// `=== ... ===` phase banners during update (pull / recreate / prune), and docker
// compose emits `[+] Pulling/Creating/Starting` lines that the log parser tags as
// PULL/CREATE/START. Scanning newest-first returns the latest recognized phase,
// since phases run in sequence. Labels are action-aware: "Recreating containers"
// is update wording; deploy/install show "Creating containers".
export function classifyOperationPhase(rows: ParsedLogRow[], action: ActionVerb): string | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const { message, stage } = rows[i];
        if (message.includes('Pruned dangling images') || message.includes('Pruning')) {
            return 'Pruning images';
        }
        if (message.includes('Recreating containers')) {
            return 'Recreating containers';
        }
        if (stage === 'START') {
            return 'Starting containers';
        }
        if (stage === 'CREATE') {
            return action === 'update' ? 'Recreating containers' : 'Creating containers';
        }
        // The update banner and the parser's `[+] Pulling` tag cover the headline,
        // but compose v2's per-layer progress (`<service> Pulling`, `Downloading`,
        // `Extracting`, ...) arrives as plain lines; match them so the phase reads
        // "Pulling images" throughout the download rather than lagging behind.
        if (
            message.includes('Pulling latest images') ||
            message.includes('Pulling from') ||
            stage === 'PULL' ||
            /\b(Pulling|Downloading|Extracting|Verifying Checksum|Pull complete|Download complete|Pulled)\b/.test(message)
        ) {
            return 'Pulling images';
        }
        if (stage === 'BUILD') {
            return 'Building images';
        }
        if (message.includes('Backup created for atomic') || message.includes('Cleaning up existing containers')) {
            return 'Preparing';
        }
    }
    return null;
}
