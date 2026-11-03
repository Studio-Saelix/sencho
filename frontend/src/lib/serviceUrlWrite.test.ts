import { describe, expect, it, vi } from 'vitest';
import { commitServiceUrlWrite, planRetiredUrlRename, retiredRenameVerified, runRetiredRename } from './serviceUrlWrite';
import { parseServiceUrlResponse } from './serviceUrlResolve';

describe('commitServiceUrlWrite', () => {
  it('leaves the editor buffer alone when the save is refused', async () => {
    const apply = vi.fn();
    const result = await commitServiceUrlWrite(
      'services:\n  web:\n    labels:\n      io.sencho.url: "https://abandoned.example"\n',
      async () => ({ ok: false as const, conflict: true, code: 'compose_source_changed' }),
      apply,
    );
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies the patched buffer only after the save is accepted', async () => {
    const order: string[] = [];
    await commitServiceUrlWrite(
      'patched',
      async () => {
        order.push('save');
        return { ok: true as const };
      },
      () => {
        order.push('apply');
      },
    );
    expect(order).toEqual(['save', 'apply']);
  });
});

describe('planRetiredUrlRename', () => {
  const FILE = 'services:\n  web:\n    labels:\n      sencho.service.url: ${APP_URL}\n';
  const plan = (over: Partial<Parameters<typeof planRetiredUrlRename>[0]> = {}) =>
    planRetiredUrlRename({ content: FILE, originalContent: FILE, canEdit: true, service: 'web', ...over });

  it('returns the rewritten file for an editor with a clean buffer', () => {
    expect(plan()).toEqual({ ok: true, next: 'services:\n  web:\n    labels:\n      io.sencho.url: ${APP_URL}\n' });
  });

  it('refuses a user who cannot edit the stack before reading the file', () => {
    expect(plan({ canEdit: false })).toEqual({ ok: false, message: 'You cannot edit this stack.' });
  });

  it('refuses while the editor holds unsaved changes, so the save never carries them along', () => {
    expect(plan({ content: `${FILE}# edited\n` })).toMatchObject({ ok: false, message: expect.stringContaining('Save or discard your changes') });
  });

  it.each([
    ['a service another file defines', { service: 'api' }, 'That service is defined in another compose file.'],
    ['a label this file does not hold', { content: 'services:\n  web:\n    image: nginx\n', originalContent: 'services:\n  web:\n    image: nginx\n' }, 'The label is not in the open compose file.'],
    ['a shared labels block', { content: 'x: &l\n  sencho.service.url: a\nservices:\n  web:\n    labels: *l\n', originalContent: 'x: &l\n  sencho.service.url: a\nservices:\n  web:\n    labels: *l\n' }, 'cannot be renamed here'],
    ['text that is not YAML', { content: 'services: [\n', originalContent: 'services: [\n' }, 'read or updated as YAML'],
  ])('says why nothing is written for %s', (_name, over, message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = plan(over);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining(message) });
  });
});

describe('retiredRenameVerified', () => {
  function entry(entries: unknown[]) {
    return parseServiceUrlResponse(1, 'demo', true, {
      renderable: true, services: [], ports: {}, volumes: {}, networks: [], restart: null,
      serviceUrls: {}, serviceUrlEdit: {}, serviceUrlClear: {},
      senchoLabels: { renderable: true, services: { web: { links: [], order: null, hidden: false } }, entries },
    });
  }
  const retired = { service: 'web', key: 'sencho.service.url', state: 'unsupported', reason: 'x' };

  it('is true only when the node no longer reports the retired label for that service', () => {
    expect(retiredRenameVerified(entry([]), 'web')).toBe(true);
    expect(retiredRenameVerified(entry([retired]), 'web')).toBe(false);
    expect(retiredRenameVerified(entry([{ ...retired, service: 'api' }]), 'web')).toBe(true);
  });

  it('is false without a ready answer, rather than assuming the rename worked', () => {
    expect(retiredRenameVerified(null, 'web')).toBe(false);
    expect(retiredRenameVerified(parseServiceUrlResponse(1, 'demo', false, null), 'web')).toBe(false);
  });
});

describe('runRetiredRename', () => {
  function entry(entries: unknown[]) {
    return parseServiceUrlResponse(1, 'demo', true, {
      renderable: true, services: [], ports: {}, volumes: {}, networks: [], restart: null,
      serviceUrls: {}, serviceUrlEdit: {}, serviceUrlClear: {},
      senchoLabels: { renderable: true, services: { web: { links: [], order: null, hidden: false } }, entries },
    });
  }
  const retired = { service: 'web', key: 'sencho.service.url', state: 'unsupported', reason: 'x' };
  const clean = () => entry([]);
  const stale = () => entry([retired]);

  function deps(over: Partial<Parameters<typeof runRetiredRename>[0]> = {}) {
    return {
      inFlight: { current: false },
      nextContent: 'next',
      service: 'web',
      save: vi.fn(async () => ({ ok: true as const })),
      applyContent: vi.fn(),
      isCurrent: () => true,
      refresh: vi.fn(async () => clean()),
      refetch: vi.fn(async () => clean()),
      ...over,
    };
  }

  it('shows the rewritten text in the editor only after the save is accepted, and reports the rename verified', async () => {
    const d = deps();
    await expect(runRetiredRename(d)).resolves.toEqual({ status: 'saved', verified: true, current: true });
    expect(d.applyContent).toHaveBeenCalledWith('next');
    expect(d.refetch).not.toHaveBeenCalled();
    expect(d.inFlight.current).toBe(false);
  });

  it('runs one rename at a time: a second call while the first save is pending writes nothing', async () => {
    let release: (value: { ok: true }) => void = () => undefined;
    let calls = 0;
    const save = vi.fn(() => (++calls === 1
      ? new Promise<{ ok: true }>(resolve => { release = resolve; })
      : Promise.resolve({ ok: true as const })));
    const d = deps({ save });
    const first = runRetiredRename(d);
    await expect(runRetiredRename(d)).resolves.toEqual({ status: 'busy' });
    expect(d.save).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await expect(first).resolves.toMatchObject({ status: 'saved', verified: true });
    // The guard is released, so the next rename runs.
    await expect(runRetiredRename(d)).resolves.toMatchObject({ status: 'saved' });
    expect(d.save).toHaveBeenCalledTimes(2);
  });

  it('releases the guard and leaves the editor alone when the save is refused or throws', async () => {
    const refused = deps({ save: vi.fn(async () => ({ ok: false as const, conflict: true, code: 'compose_source_changed' })) });
    await expect(runRetiredRename(refused)).resolves.toMatchObject({ status: 'save-refused', result: { code: 'compose_source_changed' } });
    expect(refused.applyContent).not.toHaveBeenCalled();
    expect(refused.inFlight.current).toBe(false);

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threw = deps({ save: vi.fn(async () => { throw new Error('network'); }) });
    await expect(runRetiredRename(threw)).resolves.toEqual({ status: 'save-threw' });
    expect(threw.inFlight.current).toBe(false);
  });

  it('reads the node again when the refresh was superseded, instead of calling the rename unverified', async () => {
    const d = deps({ refresh: vi.fn(async () => null), refetch: vi.fn(async () => clean()) });
    await expect(runRetiredRename(d)).resolves.toMatchObject({ status: 'saved', verified: true });
    expect(d.refetch).toHaveBeenCalledTimes(1);
  });

  it('never calls the rename done while the node still reports the retired label', async () => {
    await expect(runRetiredRename(deps({ refresh: vi.fn(async () => stale()) }))).resolves.toMatchObject({ verified: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = deps({ refresh: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(runRetiredRename(broken)).resolves.toMatchObject({ status: 'saved', verified: false });
    expect(broken.inFlight.current).toBe(false);
  });

  it('skips verification and reports a switched stack, so no toast names the wrong one', async () => {
    const d = deps({ isCurrent: () => false });
    await expect(runRetiredRename(d)).resolves.toEqual({ status: 'saved', verified: false, current: false });
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.applyContent).toHaveBeenCalledWith('next');
  });
});
