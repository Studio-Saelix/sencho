import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServicePortLink } from './ServicePortLink';
import type { ServiceUrlEntry } from '@/lib/serviceUrlResolve';
import type { Node } from '@/context/NodeContext';

const entry: ServiceUrlEntry = {
  status: 'ready',
  nodeId: 1,
  stackName: 'web',
  renderable: true,
  serviceUrls: { api: 'https://api.example.com' },
  serviceUrlEdit: { api: 'root' },
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
        lockedServices={new Map([['api', 'other']])}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('This URL is set in another compose file.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('explains an unverifiable source instead of inviting a save', () => {
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
        lockedServices={new Map([['api', 'unknown']])}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByLabelText('Sencho cannot verify which compose file sets this URL.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set URL for api' })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('shows the plain port when a remote node has no host and no override', () => {
    const pilot: ServiceUrlEntry = {
      status: 'ready',
      nodeId: 3,
      stackName: 'web',
      renderable: true,
      serviceUrls: {},
      serviceUrlEdit: {},
      ports: { web: [{ host: '8080', proto: 'tcp' }] },
    };
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        serviceName="web"
        entry={pilot}
        node={{ type: 'remote', api_url: '' } as Node}
        canEdit={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('8080')).toBeTruthy();
    expect(screen.queryByText('Service URL unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers a retry only after the service URL list failed to load', () => {
    render(
      <ServicePortLink
        portLabel="8080"
        publicPort={8080}
        entry={{ ...entry, status: 'unavailable', serviceUrls: {}, renderable: false, ports: {} }}
        node={{ type: 'remote', api_url: '' } as Node}
        canEdit={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('Service URL unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
