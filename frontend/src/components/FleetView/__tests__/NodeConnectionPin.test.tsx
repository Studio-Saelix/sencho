import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NodeConnectionPin } from '../NodeConnectionPin';
import { nodeConnection } from '../nodeConnection';

describe('nodeConnection', () => {
  it('maps the local node to local whatever its mode says', () => {
    expect(nodeConnection('local')).toBe('local');
    expect(nodeConnection('local', 'pilot_agent')).toBe('local');
  });

  it('maps a pilot agent remote to pilot', () => {
    expect(nodeConnection('remote', 'pilot_agent')).toBe('pilot');
  });

  it('maps any other remote, including a missing mode, to proxy', () => {
    expect(nodeConnection('remote', 'proxy')).toBe('proxy');
    expect(nodeConnection('remote')).toBe('proxy');
    expect(nodeConnection('remote', null)).toBe('proxy');
  });
});

describe('NodeConnectionPin', () => {
  it('renders the star Local pin without a tooltip on the local node', () => {
    render(<NodeConnectionPin type="local" />);
    const pin = screen.getByText('★ Local');
    expect(pin).not.toHaveAttribute('title');
  });

  it('renders a Proxy pin that explains the connection', () => {
    render(<NodeConnectionPin type="remote" mode="proxy" />);
    expect(screen.getByText('Proxy')).toHaveAttribute('title', expect.stringMatching(/over its API/));
    expect(screen.queryByText('★ Local')).not.toBeInTheDocument();
  });

  it('renders a Pilot pin that explains the tunnel', () => {
    render(<NodeConnectionPin type="remote" mode="pilot_agent" />);
    expect(screen.getByText('Pilot')).toHaveAttribute('title', expect.stringMatching(/tunnel/));
  });

  it('passes positioning classes through', () => {
    render(<NodeConnectionPin type="remote" className="absolute top-3" />);
    expect(screen.getByText('Proxy')).toHaveClass('absolute', 'top-3');
  });
});
