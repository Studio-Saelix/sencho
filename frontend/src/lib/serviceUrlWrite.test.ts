import { describe, expect, it, vi } from 'vitest';
import { commitServiceUrlWrite } from './serviceUrlWrite';

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
