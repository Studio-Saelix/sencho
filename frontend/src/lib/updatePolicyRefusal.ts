import { toast } from '@/components/ui/toast-store';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from './events';
import { SENCHO_UPDATE_LABEL } from './senchoLabels';

/** The label named in every refusal, from the one frontend copy of the registry keys. */
export const UPDATE_POLICY_LABEL = SENCHO_UPDATE_LABEL;

export const UPDATE_POLICY_BLOCKED_CODE = 'update_policy_blocked';

const PREFIX = `Update blocked by ${UPDATE_POLICY_LABEL}:`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal a 409 carries, in the shape every update and pull surface shows. */
export interface UpdatePolicyRefusal {
  /** One sentence, carrying the label once. */
  message: string;
  /** The policy's own reason, or null when the body did not carry a usable one. */
  reason: string | null;
  serviceName: string | null;
}

function sentence(reason: string): string {
  const trimmed = reason.trim().replace(/\.+$/, '');
  return `${PREFIX} ${trimmed}.`;
}

/**
 * Read a `update_policy_blocked` 409 body. A body that is not a refusal, or one
 * with neither a message nor a reason to show, returns null so the caller falls
 * back to its generic failure copy instead of inventing a policy sentence.
 */
export function parseUpdatePolicyRefusal(body: unknown, status?: number): UpdatePolicyRefusal | null {
  if (status !== undefined && status !== 409) return null;
  if (!isRecord(body)) return null;
  if (body.code !== UPDATE_POLICY_BLOCKED_CODE) return null;
  const error = typeof body.error === 'string' ? body.error.trim() : '';
  const policy = isRecord(body.updatePolicy) ? body.updatePolicy : null;
  const policyReason = policy && typeof policy.reason === 'string' && policy.reason.trim() ? policy.reason.trim() : null;
  if (!error && !policyReason) return null;
  const serviceName = typeof body.serviceName === 'string' && body.serviceName ? body.serviceName : null;
  // The backend already sends the full sentence. Prefix only a bare reason, so
  // the toast never says the label twice.
  const message = error.startsWith(PREFIX) ? error : sentence(error || policyReason || 'the label refused it');
  return { message, reason: policyReason, serviceName };
}

/** The refusal from a raw response body, or null when the text is not a refusal. */
export function parseUpdatePolicyRefusalText(rawBody: string, status?: number): UpdatePolicyRefusal | null {
  try {
    return parseUpdatePolicyRefusal(JSON.parse(rawBody) as unknown, status);
  } catch {
    return null;
  }
}

export interface UpdatePolicyRefusalContext {
  nodeId: number | null;
  stackName: string;
  /** True inside the stack editor, where the Compose file is one click away. */
  inEditor: boolean;
  /** Opens the Compose file in place; absent outside the editor. */
  onOpenComposeFile?: () => void;
}

/** Opens the stack in the editor; the fallback destination when no Compose-file handler exists. */
export function openStackEditor(nodeId: number | null, stackName: string): void {
  if (nodeId === null) return;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId, stackName, destination: 'editor' },
  }));
}

/**
 * The one toast for a policy refusal, wherever an update or an image pull is
 * offered. The verb names where the label lives, because the label is the only
 * place the decision can be changed.
 */
export function toastUpdatePolicyRefusal(
  refusal: UpdatePolicyRefusal,
  context: UpdatePolicyRefusalContext,
): void {
  if (!context.inEditor) {
    toast.error(refusal.message, {
      action: { label: 'Open stack editor', onClick: () => openStackEditor(context.nodeId, context.stackName) },
    });
    return;
  }
  toast.error(refusal.message, {
    action: {
      label: 'Open Compose file',
      onClick: () => {
        if (context.onOpenComposeFile) context.onOpenComposeFile();
        else openStackEditor(context.nodeId, context.stackName);
      },
    },
  });
}
