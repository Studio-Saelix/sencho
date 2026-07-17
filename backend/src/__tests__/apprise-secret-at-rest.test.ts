/**
 * Downgrade-safety: Apprise url/config must be encrypted at rest so a
 * pre-Apprise binary's SELECT * + unsanitized GET cannot return raw secrets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { serializePublicAgent, serializePublicNotificationRoute } from '../helpers/notificationChannels';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM notification_routes').run();
});

describe('Apprise secrets at rest (downgrade-safe)', () => {
  it('stores keyed agent secrets as ciphertext; SELECT * does not leak the notify key', () => {
    const db = DatabaseService.getInstance();
    const keySecret = 'SuperSecretKey99';

    db.upsertAgent(1, {
      type: 'apprise',
      url: `http://apprise.local/notify/${keySecret}`,
      enabled: true,
      config: '{}',
    });

    const raw = db.getDb().prepare('SELECT * FROM agents WHERE type = ?').get('apprise') as {
      url: string;
      config: string | null;
    };
    expect(raw.url).toMatch(/^enc:/);
    expect(raw.url).not.toContain(keySecret);
    expect(raw.url).not.toContain('apprise.local');
    expect(raw.config).toMatch(/^enc:/);

    const apprise = db.getAgents(1).find(a => a.type === 'apprise')!;
    expect(apprise.url).toBe(`http://apprise.local/notify/${keySecret}`);
    const pub = serializePublicAgent(apprise);
    expect(pub.secrets_redacted).toBe(true);
    expect(pub.url).toContain('<redacted>');
    expect(JSON.stringify(pub)).not.toContain(keySecret);
  });

  it('stores stateless destination URLs as ciphertext; SELECT * does not leak credentials', () => {
    const db = DatabaseService.getInstance();
    const destSecret = 'mailto://user:smtp-password@example.com';

    db.upsertAgent(1, {
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: JSON.stringify({ urls: destSecret }),
    });

    const raw = db.getDb().prepare('SELECT * FROM agents WHERE type = ?').get('apprise') as {
      url: string;
      config: string | null;
    };
    expect(raw.url).toMatch(/^enc:/);
    expect(raw.config).toMatch(/^enc:/);
    expect(raw.config).not.toContain(destSecret);
    expect(raw.config).not.toContain('smtp-password');

    const apprise = db.getAgents(1).find(a => a.type === 'apprise')!;
    expect(apprise.url).toBe('http://apprise.local/notify');
    expect(apprise.config).toBe(JSON.stringify({ urls: destSecret }));
    const pub = serializePublicAgent(apprise);
    expect(pub.secrets_redacted).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(destSecret);
  });

  it('encrypts Apprise route channel_url and config the same way', () => {
    const db = DatabaseService.getInstance();
    const keySecret = 'RouteKey_01';
    const now = Date.now();
    const route = db.createNotificationRoute({
      name: 'apprise-route',
      node_id: null,
      stack_patterns: [],
      label_ids: null,
      categories: null,
      channel_type: 'apprise',
      channel_url: `http://apprise.local/notify/${keySecret}`,
      config: '{}',
      priority: 0,
      enabled: true,
      created_at: now,
      updated_at: now,
    });

    const raw = db.getDb().prepare('SELECT * FROM notification_routes WHERE id = ?').get(route.id) as {
      channel_url: string;
      config: string | null;
    };
    expect(raw.channel_url).toMatch(/^enc:/);
    expect(raw.channel_url).not.toContain(keySecret);
    expect(raw.config).toMatch(/^enc:/);

    const loaded = db.getNotificationRoute(route.id)!;
    expect(loaded.channel_url).toBe(`http://apprise.local/notify/${keySecret}`);
    const pub = serializePublicNotificationRoute(loaded);
    expect(pub.secrets_redacted).toBe(true);
    expect(pub.channel_url).toContain('<redacted>');
    expect(JSON.stringify(pub)).not.toContain(keySecret);
  });

  it('does not encrypt Discord agent URLs (unchanged channel behavior)', () => {
    const db = DatabaseService.getInstance();
    const url = 'https://discord.com/api/webhooks/123/plaintext-token';
    db.upsertAgent(1, { type: 'discord', url, enabled: true });
    const raw = db.getDb().prepare('SELECT * FROM agents WHERE type = ?').get('discord') as { url: string };
    expect(raw.url).toBe(url);
    expect(raw.url.startsWith('enc:')).toBe(false);
    const pub = serializePublicAgent(db.getAgents(1).find(a => a.type === 'discord')!);
    expect(pub.secrets_redacted).toBe(false);
    expect(pub.url).toBe(url);
  });
});
