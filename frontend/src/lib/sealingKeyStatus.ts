import { KeyRound, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, WifiOff } from 'lucide-react';
import type { StatusPathAnswer } from '@/components/ui/status-path';
import type { NodeSealingKeyView } from '@/hooks/useNodeSealingKey';

/**
 * ConfirmModal renders `description` only for screen readers, so the
 * consequence is also a visible body child; both read this one constant.
 */
export const RESET_PIN_CONSEQUENCE =
  'Resetting clears the pinned key this control instance uses to seal private registry credentials and sealed secrets for this node. '
  + 'The next contact pins whatever key the node presents then, so reset only if you know the node\'s key changed (a reinstall or a replaced data volume).';

/** Where every node prints its own fingerprint, for an out-of-band comparison. */
const STARTUP_LOG_HINT = 'Every node prints its fingerprint in its startup log, on the line that starts with "[Sealing]".';

export type SealingKeyAnswer = Pick<StatusPathAnswer, 'tone' | 'title' | 'line' | 'status' | 'icon'>;

/** The one toned line for a node's sealing key, per state. */
export function sealingKeyAnswer(view: NodeSealingKeyView, isAdmin: boolean): SealingKeyAnswer {
  if (view.kind === 'local') {
    return {
      tone: 'neutral',
      status: 'local',
      icon: KeyRound,
      title: 'This instance\'s sealing key',
      line: 'Compare this fingerprint with the one a control instance shows for this node before it is confirmed there.',
    };
  }
  switch (view.readiness) {
    case 'ready':
      return {
        tone: 'success',
        status: 'ready',
        icon: ShieldCheck,
        title: 'Ready for sealed delivery',
        line: 'The pinned key matches the key this node presents, and it was pinned over a confidential connection or confirmed by an Admin.',
      };
    case 'pin_unconfirmed':
      return {
        tone: 'warning',
        status: 'pin_unconfirmed',
        icon: ShieldQuestion,
        title: 'Confirm this fingerprint',
        line: isAdmin
          ? `This key was not seen over a confidential connection, so sealed secrets wait for your confirmation. Compare it with the node's own fingerprint first. ${STARTUP_LOG_HINT}`
          : `This key was not seen over a confidential connection, so sealed secrets wait until an Admin confirms it. ${STARTUP_LOG_HINT}`,
      };
    case 'key_mismatch':
      return {
        tone: 'destructive',
        status: 'key_mismatch',
        icon: ShieldAlert,
        title: 'Key changed since it was pinned',
        line: 'This node now presents a different sealing key, so nothing sealed is sent to it. Reset the pin only if you know the node was reinstalled or its data volume was replaced.',
      };
    case 'unsupported':
      return {
        tone: 'warning',
        status: 'unsupported',
        icon: ShieldAlert,
        title: 'This node cannot receive sealed secrets',
        line: 'Update Sencho on this node to a version that accepts sealed secrets, then open this sheet again.',
      };
    case 'unreachable':
      return {
        tone: 'warning',
        status: 'unreachable',
        icon: WifiOff,
        title: 'Node unreachable',
        line: 'Sencho could not reach this node to read its sealing key. Check that the node is online and its connection works, then retry.',
      };
    case 'key_invalid':
      return {
        tone: 'destructive',
        status: 'key_invalid',
        icon: ShieldX,
        title: 'Node answered without a usable key',
        line: 'The node answered, but not with a sealing key Sencho can use, so nothing sealed is sent to it. Check the node\'s logs, then retry.',
      };
  }
}
