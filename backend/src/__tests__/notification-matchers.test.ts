import { describe, it, expect } from 'vitest';
import {
  matchesNotificationFilters,
  ruleNeedsStackLabels,
  appliesToBell,
  appliesToExternal,
} from '../helpers/notificationMatchers';
import type { NotificationMatchContext } from '../helpers/notificationMatchers';

const baseCtx: NotificationMatchContext = {
  localNodeId: 1,
  stackName: 'my-app',
  category: 'monitor_alert',
  level: 'error',
  stackLabelIds: [10],
};

describe('notificationMatchers', () => {
  it('matches when all non-empty filters pass', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: null,
      stack_patterns: ['my-app'],
      label_ids: [10],
      categories: ['monitor_alert'],
      levels: ['error'],
    })).toBe(true);
  });

  it('rejects when node_id does not match', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: 2,
      stack_patterns: [],
      label_ids: null,
      categories: null,
    })).toBe(false);
  });

  it('rejects when stack pattern does not match', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: null,
      stack_patterns: ['other'],
      label_ids: null,
      categories: null,
    })).toBe(false);
  });

  it('rejects when category does not match', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: null,
      stack_patterns: [],
      label_ids: null,
      categories: ['deploy_success'],
    })).toBe(false);
  });

  it('rejects when level does not match', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: null,
      stack_patterns: [],
      label_ids: null,
      categories: null,
      levels: ['info'],
    })).toBe(false);
  });

  it('matches any when all matchers empty', () => {
    expect(matchesNotificationFilters(baseCtx, {
      node_id: null,
      stack_patterns: [],
      label_ids: null,
      categories: null,
      levels: null,
    })).toBe(true);
  });

  it('detects when stack labels are needed', () => {
    expect(ruleNeedsStackLabels([{ node_id: null, stack_patterns: [], label_ids: [1], categories: null }])).toBe(true);
    expect(ruleNeedsStackLabels([{ node_id: null, stack_patterns: [], label_ids: null, categories: null }])).toBe(false);
  });

  it('applies_to helpers', () => {
    expect(appliesToBell('bell')).toBe(true);
    expect(appliesToBell('external')).toBe(false);
    expect(appliesToExternal('external')).toBe(true);
    expect(appliesToExternal('bell')).toBe(false);
    expect(appliesToBell('both')).toBe(true);
    expect(appliesToExternal('both')).toBe(true);
  });
});
