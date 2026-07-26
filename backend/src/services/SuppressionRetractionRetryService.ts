import { flushPendingSuppressionRetractions } from '../helpers/notificationSuppressionSync';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';

const INITIAL_DELAY_MS = 30_000;
const EVAL_INTERVAL_MS = 5 * 60_000;

/**
 * Background retry for durable mute-replica retractions that failed or were
 * deferred (offline Pilot/proxy, or remote lacking versioned retraction support).
 */
export class SuppressionRetractionRetryService {
  private static instance: SuppressionRetractionRetryService;
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  private constructor() {}

  static getInstance(): SuppressionRetractionRetryService {
    if (!SuppressionRetractionRetryService.instance) {
      SuppressionRetractionRetryService.instance = new SuppressionRetractionRetryService();
    }
    return SuppressionRetractionRetryService.instance;
  }

  start(): void {
    this.initialTimer = setTimeout(() => {
      void this.evaluate();
      this.intervalId = setInterval(() => void this.evaluate(), EVAL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Full sweep of all pending rows. */
  async evaluate(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      if (isDebugEnabled()) {
        console.debug('[SuppressionRetractionRetry:debug] Evaluating pending retractions');
      }
      await flushPendingSuppressionRetractions();
    } catch (err) {
      console.error(
        '[SuppressionRetractionRetry] evaluate error:',
        getErrorMessage(err, String(err)),
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /** Targeted flush when a Pilot tunnel or proxy node comes online. */
  async flushNode(nodeId: number): Promise<void> {
    try {
      await flushPendingSuppressionRetractions(nodeId);
    } catch (err) {
      console.error(
        `[SuppressionRetractionRetry] flushNode ${nodeId} failed:`,
        getErrorMessage(err, String(err)),
      );
    }
  }
}
