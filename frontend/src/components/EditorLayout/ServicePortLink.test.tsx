import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServicePortLink } from './ServicePortLink';
import type { ServiceUrlEntry } from '@/lib/serviceUrlResolve';

const entry: ServiceUrlEntry = {
  status: 'ready',
  nodeId: 1,
  stackName: 'web',
  renderable: true,
  serviceUrls: { api: 'https://api.example.com' },
  ports: { api: [{ host: '8080', proto: 'tcp' }] },
};

describe('ServicePortLink edit affordance', () => {
  it('does not invite a save for a service outside the open compose file', () => {
    const onEdit = vi.fn();
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['web']}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('This service is not in the open compose file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('offers a save when the service is in the open compose file', () => {
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['api']}
        onEdit={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: 'Set URL for api' })).toBeTruthy();
  });

  it('does not invite a save when another file sets the URL', () => {
    const onEdit = vi.fn();
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="api"
        entry={entry}
        node={null}
        canEdit
        sourceServices={['api']}
        lockedServices={new Set(['api'])}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('This URL is set in another compose file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });
});
