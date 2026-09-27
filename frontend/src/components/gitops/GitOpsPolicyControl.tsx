import { useCallback, useState, type ReactNode } from 'react';

import {
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Modal, ModalBody, ModalHeader } from '@/components/ui/modal';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast-store';
import {
  POLICY_DOMAIN_LABEL,
  POLICY_DOMAIN_SUBJECT,
  policyValueLabel,
  policyValueShortLabel,
} from '@/lib/gitopsAuthorityPolicy';
import {
  setGitOpsPlacementPolicy,
  setGitOpsRolloutAuthorizationPolicy,
  type GitOpsPlacementPolicy,
  type GitOpsRolloutAuthorizationPolicy,
} from '@/lib/gitopsAuthorityApi';
import type { AuthorityPolicyDomain, AuthorityPolicyRead } from '@/types/gitops';

type WritableDomain = Exclude<AuthorityPolicyDomain, 'source'>;

/**
 * The values each domain offers and the write each one goes through, held
 * together so the surfaces cannot drift into offering different values for the
 * same question, or offering a value the server would refuse. A control that
 * offered a value its endpoint rejected would be a dead affordance, which is
 * worse than not offering it.
 */
const DOMAIN_VALUES: Record<WritableDomain, readonly string[]> = {
  placement: ['operator', 'bounded_auto'],
  rollout_authorization: ['manual', 'automatic'],
};

const DOMAIN_WRITE: Record<
  WritableDomain,
  (applicationId: string, value: string) => Promise<void>
> = {
  placement: (applicationId, value) =>
    setGitOpsPlacementPolicy(applicationId, value as GitOpsPlacementPolicy),
  rollout_authorization: (applicationId, value) =>
    setGitOpsRolloutAuthorizationPolicy(applicationId, value as GitOpsRolloutAuthorizationPolicy),
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'The policy could not be changed';
}

export interface GitOpsPolicyControlProps {
  applicationId: string;
  domain: WritableDomain;
  /** The current read, so the dialog opens on what is configured now. */
  read: AuthorityPolicyRead;
  /** Refresh the surface after a write. */
  onChanged: () => void;
  /**
   * Whether this session may set the policy at all. Required in effect: a
   * surface that omits it renders the control disabled rather than offering a
   * write the server would refuse.
   */
  canWrite: boolean;
  /**
   * What opens the dialog, given the opener.
   *
   * A function rather than an element, so the caller composes it with whatever
   * its surface already uses. Wrapping the node here would nest a button inside
   * a button wherever the caller passed a real one, and rendering it as-is would
   * leave it inert.
   */
  trigger: (open: () => void) => ReactNode;
  /**
   * Render the trigger as a menu item instead, for a control that lives in an
   * overflow. One control rather than two, because two implementations of the
   * same values would be free to disagree about which ones exist.
   */
  inMenu?: boolean;
}

/**
 * The one control for "who decides this", shared by the surfaces that govern
 * placement and rollout.
 *
 * Placed next to the action its policy governs rather than gathered on a
 * settings page: a policy is read at the moment the operator is deciding whether
 * to act, and an operator who has to go looking for the control is an operator
 * who acts on the current setting without knowing it.
 *
 * A dialog rather than an inline switch, for two reasons. A segmented control
 * beside a row of action buttons competes with them for the same attention, and
 * the two values of each policy are a choice rather than a toggle: "operator" is
 * a decision about who acts, not about whether a policy is on, so a switch
 * would be a false binary. It also gives the mobile layout the same affordance
 * the rest of this control set uses, a stacked list of full-width targets.
 */
export default function GitOpsPolicyControl({
  applicationId,
  domain,
  read,
  onChanged,
  canWrite,
  trigger,
  inMenu = false,
}: GitOpsPolicyControlProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const current = read.configured;
  const known = DOMAIN_VALUES[domain].includes(current);

  // The dialog opens on what is configured now, not on whatever was selected
  // when it was last closed, so a write that landed elsewhere, or a refresh from
  // another surface, is reflected rather than silently overwritten.
  const [selected, setSelected] = useState(current);
  const openDialog = useCallback(() => {
    setSelected(current);
    setOpen(true);
  }, [current]);

  const options = DOMAIN_VALUES[domain].map((value) => ({
    value,
    label: policyValueShortLabel(domain, value),
  }));

  async function handleConfirm(): Promise<void> {
    if (!canWrite || pending || selected === current) {
      setOpen(false);
      return;
    }
    setPending(true);
    try {
      await DOMAIN_WRITE[domain](applicationId, selected);
      toast.success(`${POLICY_DOMAIN_LABEL[domain]} policy set to ${policyValueShortLabel(domain, selected)}`);
      setOpen(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  // Absent rather than disabled, matching every other gated affordance in this
  // surface: a session that may not write is not shown a control whose every
  // action would be refused. A control that renders disabled still invites the
  // click, and the refusal arrives as an error the operator did not cause.
  if (!canWrite) return null;

  return (
    <>
      {inMenu ? (
        <DropdownMenuItem
          onSelect={(event) => event.preventDefault()}
          onClick={openDialog}
          disabled={!canWrite}
          data-testid={`gitops-action-${domain}-policy`}
        >
          {trigger(openDialog)}
        </DropdownMenuItem>
      ) : trigger(openDialog)}

      <Modal open={open} onOpenChange={setOpen} size="sm">
        <ModalHeader
          kicker={`${POLICY_DOMAIN_LABEL[domain].toUpperCase()} · POLICY`}
          title={`${POLICY_DOMAIN_LABEL[domain]} policy`}
        />
        <ModalBody>
          <p className="mb-3 text-[13px] leading-relaxed text-foreground/80">
            {`Choose who decides ${POLICY_DOMAIN_SUBJECT[domain]}. This changes what the next decision may do. It does not change work already approved or in flight.`}
          </p>
          {known ? null : (
            // A value this build does not recognize is named rather than snapped
            // to a segment, because choosing one would silently replace whatever
            // the server is actually enforcing.
            <p className="mb-3 font-mono text-[11px] text-warning">
              {`This build does not recognize "${current}". Choosing a value will replace it.`}
            </p>
          )}
          <SegmentedControl
            value={known ? selected : null}
            onChange={(value) => setSelected(value)}
            options={options}
            ariaLabel={`${POLICY_DOMAIN_LABEL[domain]} policy: decides ${POLICY_DOMAIN_SUBJECT[domain]}`}
            disabled={!canWrite || pending}
            className="max-md:hidden"
          />
          <ul className="hidden flex-col gap-1.5 max-md:flex">
            {DOMAIN_VALUES[domain].map((value) => (
              <li key={value}>
                <button
                  type="button"
                  onClick={() => setSelected(value)}
                  aria-pressed={value === selected}
                  disabled={!canWrite || pending}
                  className={value === selected
                    ? 'w-full rounded-sm border border-foreground/40 bg-foreground/5 px-2.5 py-2 text-left font-mono text-[11px] text-foreground'
                    : 'w-full rounded-sm border border-transparent px-2.5 py-2 text-left font-mono text-[11px] text-stat-subtitle'}
                >
                  {policyValueLabel(domain, value)}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="rounded-md border border-card-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-foreground/80"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canWrite || pending || selected === current}
              data-testid="gitops-policy-confirm"
              className="rounded-md bg-brand px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-brand-foreground disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save policy'}
            </button>
          </div>
        </ModalBody>
      </Modal>
    </>
  );
}
