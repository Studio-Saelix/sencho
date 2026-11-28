import { describe, expect, it } from 'vitest';
import { COMPOSE_INPUTS_REFUSED_CODE, readComposeInputsRefusal } from './composeInputsRefusal';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('readComposeInputsRefusal', () => {
  it('returns the refusal text for a 409 carrying the refusal code', async () => {
    const res = json({ error: 'compose.yaml expands past the limit.', code: COMPOSE_INPUTS_REFUSED_CODE }, 409);
    expect(await readComposeInputsRefusal(res)).toBe('compose.yaml expands past the limit.');
  });

  it('returns null for a 409 without the refusal code (another conflict keeps its wording)', async () => {
    expect(await readComposeInputsRefusal(json({ error: 'busy' }, 409))).toBeNull();
    expect(await readComposeInputsRefusal(json({ error: 'busy', code: 'other' }, 409))).toBeNull();
  });

  it('returns the size reason for a 413', async () => {
    expect(await readComposeInputsRefusal(json({ error: 'Compose file too large to parse' }, 413)))
      .toBe('Compose file too large to parse');
    expect(await readComposeInputsRefusal(json({}, 413))).toBeNull();
    expect(await readComposeInputsRefusal(json({ error: '  ' }, 413))).toBeNull();
  });

  it('returns null for any other status even when the body carries the code', async () => {
    const body = { error: 'x', code: COMPOSE_INPUTS_REFUSED_CODE };
    expect(await readComposeInputsRefusal(json(body, 500))).toBeNull();
    expect(await readComposeInputsRefusal(json(body, 403))).toBeNull();
  });

  it('returns null for a body that is not JSON, empty, or lacks a text', async () => {
    expect(await readComposeInputsRefusal(new Response('<html>', { status: 409 }))).toBeNull();
    expect(await readComposeInputsRefusal(new Response('null', { status: 409 }))).toBeNull();
    expect(await readComposeInputsRefusal(json({ code: COMPOSE_INPUTS_REFUSED_CODE }, 409))).toBeNull();
    expect(await readComposeInputsRefusal(json({ error: '  ', code: COMPOSE_INPUTS_REFUSED_CODE }, 409))).toBeNull();
  });
});
