/**
 * MobileReadinessCard is the one-up phone card for the Updates readiness board.
 * Its Apply button must stay disabled when the update is blocked (major bump),
 * while in flight, or when no schedule covers the stack; enabled only when a
 * covering schedule exists and the preview loaded without a block.
 */
import { it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileReadinessCard, type StackCard } from '../AutoUpdateReadinessView';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    autoUpdateEnabled: true,
    scheduledTask: null,
    preview: {
      stack_name: 'nextcloud',
      images: [],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.5',
        semver_bump: 'patch',
        update_kind: 'tag',
        blocked: false,
        blocked_reason: null,
      },
      rollback_target: null,
      changelog: 'Fixes. Security patch.',
    },
    ...over,
  };
}

const apply = () => screen.getByRole('button', { name: /Apply now/i });

it('enables Apply when a covering schedule exists and the update is not blocked', () => {
  render(<MobileReadinessCard card={card()} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('disables Apply when the update is blocked (major bump)', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'gitea', images: [], rollback_target: null, changelog: 'Breaking.',
          summary: {
            has_update: true, primary_image: 'gitea', current_tag: '1.21', next_tag: '1.22',
            semver_bump: 'major', update_kind: 'tag', blocked: true, blocked_reason: 'Major version bump',
          },
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(apply()).toBeDisabled();
});

it('disables Apply when no schedule covers the stack', () => {
  render(<MobileReadinessCard card={card({ autoUpdateEnabled: false })} onApply={vi.fn()} />);
  expect(apply()).toBeDisabled();
});
