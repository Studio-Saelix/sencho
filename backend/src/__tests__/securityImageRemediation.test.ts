import { describe, it, expect } from 'vitest';
import {
  classifyImageRemediation,
  buildUpdateServiceIndex,
} from '../services/securityImageRemediation';
import type { StackServiceStatus, StackUpdateDetail } from '../services/DatabaseService';

const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const FRESH_WINDOW = 4 * HOUR;

function service(partial: Partial<StackServiceStatus> & Pick<StackServiceStatus, 'service'>): StackServiceStatus {
  return {
    image: 'nginx:1.25',
    hasUpdate: false,
    checkStatus: 'ok',
    lastError: null,
    ...partial,
  };
}

function detail(
  services: StackServiceStatus[],
  opts: { checkedAt?: number; hasUpdate?: boolean; checkStatus?: 'ok' | 'partial' | 'failed' } = {},
): StackUpdateDetail {
  return {
    hasUpdate: opts.hasUpdate ?? services.some((s) => s.hasUpdate),
    checkStatus: opts.checkStatus ?? 'ok',
    lastError: null,
    checkedAt: opts.checkedAt ?? NOW - HOUR,
    services,
  };
}

describe('buildUpdateServiceIndex', () => {
  it('indexes declared image and runtimeImages through normalizeImageRef', () => {
    const index = buildUpdateServiceIndex({
      web: detail([
        service({
          service: 'app',
          image: 'docker.io/library/nginx',
          runtimeImages: ['nginx:1.25'],
        }),
      ]),
    });
    expect(index.has('nginx:latest')).toBe(true);
    expect(index.has('nginx:1.25')).toBe(true);
  });
});

describe('classifyImageRemediation', () => {
  it('counts confirmed updates only when hasUpdate and checkStatus are ok', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 3 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'ok' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts).toEqual({
      fixableWithImageUpdate: 3,
      fixableWaitingUpstream: 0,
      fixableUpdateUnknown: 0,
      updateChecksDisabled: false,
    });
  });

  it('treats sticky partial hasUpdate as uncertain, never update_available', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 2 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'partial' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWithImageUpdate).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(2);
    expect(facts.fixableWaitingUpstream).toBe(0);
  });

  it('treats not_checkable as uncertain, never waiting_upstream', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'myapp:local', count: 1 }],
      details: {
        web: detail([service({
          service: 'app',
          image: 'myapp:local',
          hasUpdate: false,
          checkStatus: 'not_checkable',
        })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWaitingUpstream).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(1);
  });

  it('authoritative negative becomes waiting_upstream when fresh', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 4 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: false, checkStatus: 'ok' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWaitingUpstream).toBe(4);
    expect(facts.fixableWithImageUpdate).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(0);
  });

  it('stale stack-level checkedAt yields uncertain, not waiting (R4)', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 1 }],
      details: {
        web: detail(
          [service({ service: 'app', image: 'nginx:1.25', hasUpdate: false, checkStatus: 'ok' })],
          { checkedAt: NOW - (FRESH_WINDOW + 1) },
        ),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWaitingUpstream).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(1);
  });

  it('digest-pinned finding does not match tag-declared service (uncertain)', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx@sha256:abc', count: 1 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: false, checkStatus: 'ok' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWaitingUpstream).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(1);
  });

  it('disabled checks put all package-fix findings in uncertain', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 5 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'ok' })]),
      },
      checksEnabled: false,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts).toEqual({
      fixableWithImageUpdate: 0,
      fixableWaitingUpstream: 0,
      fixableUpdateUnknown: 5,
      updateChecksDisabled: true,
    });
  });

  it('missing stack membership is uncertain', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'orphan:1', count: 2 }],
      details: {},
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableUpdateUnknown).toBe(2);
  });

  it('matches via runtimeImages when declared image differs', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25.3', count: 1 }],
      details: {
        web: detail([service({
          service: 'app',
          image: 'nginx:1.25',
          runtimeImages: ['nginx:1.25.3'],
          hasUpdate: true,
          checkStatus: 'ok',
        })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWithImageUpdate).toBe(1);
  });

  it('cron-sized freshness window still allows authoritative negatives', () => {
    // Daily cron → 2×24h = 48h window (clamped max). A check from 12h ago is fresh.
    const cronWindow = 48 * HOUR;
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 1 }],
      details: {
        web: detail(
          [service({ service: 'app', image: 'nginx:1.25', hasUpdate: false, checkStatus: 'ok' })],
          { checkedAt: NOW - 12 * HOUR },
        ),
      },
      checksEnabled: true,
      freshnessWindowMs: cronWindow,
      now: NOW,
    });
    expect(facts.fixableWaitingUpstream).toBe(1);
  });

  it('confirmed update on one stack wins over sibling partial sticky hasUpdate', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 1 }],
      details: {
        web: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'ok' })]),
        api: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'partial' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWithImageUpdate).toBe(1);
    expect(facts.fixableUpdateUnknown).toBe(0);
  });

  it('partial-only sticky hasUpdate stays uncertain', () => {
    const facts = classifyImageRemediation({
      findings: [{ image_ref: 'nginx:1.25', count: 1 }],
      details: {
        api: detail([service({ service: 'app', image: 'nginx:1.25', hasUpdate: true, checkStatus: 'partial' })]),
      },
      checksEnabled: true,
      freshnessWindowMs: FRESH_WINDOW,
      now: NOW,
    });
    expect(facts.fixableWithImageUpdate).toBe(0);
    expect(facts.fixableUpdateUnknown).toBe(1);
  });
});
