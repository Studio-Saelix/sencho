import { describe, expect, it } from 'vitest';
import { stackOpenConnectionMessage, stackOpenRefusalMessage } from './stackOpenError';

describe('stackOpenRefusalMessage', () => {
  it('names a compose path the server refused', () => {
    const message = stackOpenRefusalMessage(
      'linked.yml',
      409,
      JSON.stringify({ error: 'Compose file path is not allowed' }),
    );
    expect(message).toBe('Could not open "linked". Compose file path is not allowed');
    expect(message).not.toContain('connection');
  });

  it('leaves other failures to the connection message', () => {
    expect(stackOpenRefusalMessage('web.yml', 500, JSON.stringify({ error: 'Failed to read stack' }))).toBeNull();
    expect(stackOpenRefusalMessage('web.yml', 409, 'not json')).toBeNull();
    expect(stackOpenConnectionMessage('web.yml')).toContain('Check your connection');
  });
});
