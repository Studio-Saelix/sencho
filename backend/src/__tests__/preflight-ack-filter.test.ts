import { describe, it, expect } from 'vitest';
import type { PreflightAcknowledgement } from '../services/DatabaseService';
import { applyPreflightAcknowledgements, isPreflightAckActive } from '../utils/preflight-ack-filter';
import type { PreflightFinding } from '../services/preflight/types';

const baseFinding = (over: Partial<PreflightFinding> = {}): PreflightFinding => ({
  ruleId: 'uid-gid-risk',
  severity: 'warning',
  title: 'Check UID/GID alignment',
  message: 'test',
  service: 'web',
  ...over,
});

const baseAck = (over: Partial<PreflightAcknowledgement> = {}): PreflightAcknowledgement => ({
  id: 1,
  node_id: 1,
  stack_name: 'demo',
  rule_id: 'uid-gid-risk',
  service: 'web',
  reason: 'verified ownership',
  expiry_mode: 'forever',
  expires_at: null,
  anchor_rendered_hash: null,
  anchor_image_ref: null,
  created_by: 'admin',
  created_at: Date.now(),
  ...over,
});

describe('applyPreflightAcknowledgements', () => {
  const ctx = { renderedHash: 'hash-a', serviceImages: { web: 'nginx:1.2' } };

  it('marks a matching service-scoped ack as acknowledged', () => {
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [baseAck()], Date.now());
    expect(out[0].acknowledged).toBe(true);
    expect(out[0].acknowledgementId).toBe(1);
  });

  it('prefers a service-scoped ack over a rule-wide ack', () => {
    const ruleWide = baseAck({ id: 2, service: null });
    const serviceScoped = baseAck({ id: 3, service: 'web' });
    const out = applyPreflightAcknowledgements(
      [baseFinding()],
      ctx,
      [ruleWide, serviceScoped],
      Date.now(),
    );
    expect(out[0].acknowledgementId).toBe(3);
  });

  it('does not acknowledge when until_compose_change hash differs', () => {
    const ack = baseAck({ expiry_mode: 'until_compose_change', anchor_rendered_hash: 'old-hash' });
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [ack], Date.now());
    expect(out[0].acknowledged).toBe(false);
  });

  it('acknowledges when until_compose_change hash matches', () => {
    const ack = baseAck({ expiry_mode: 'until_compose_change', anchor_rendered_hash: 'hash-a' });
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [ack], Date.now());
    expect(out[0].acknowledged).toBe(true);
  });

  it('expires days mode after expires_at', () => {
    const now = 1_000_000;
    const ack = baseAck({ expiry_mode: 'days', expires_at: now - 1 });
    expect(isPreflightAckActive(ack, ctx, now)).toBe(false);
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [ack], now);
    expect(out[0].acknowledged).toBe(false);
  });

  it('honors until_image_change while image ref matches', () => {
    const ack = baseAck({
      expiry_mode: 'until_image_change',
      anchor_image_ref: 'nginx:1.2',
    });
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [ack], Date.now());
    expect(out[0].acknowledged).toBe(true);
  });

  it('re-surfaces until_image_change when image ref changes', () => {
    const ack = baseAck({
      expiry_mode: 'until_image_change',
      anchor_image_ref: 'nginx:1.0',
    });
    const out = applyPreflightAcknowledgements([baseFinding()], ctx, [ack], Date.now());
    expect(out[0].acknowledged).toBe(false);
  });
});
