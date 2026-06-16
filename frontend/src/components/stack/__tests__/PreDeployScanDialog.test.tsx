import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PreDeployScanDialog } from '../PreDeployScanDialog';
import type { PreDeployScanImage } from '@/types/security';

const images: PreDeployScanImage[] = [
  {
    imageRef: 'nginx:1.14',
    scan: {
      criticalCount: 31,
      highCount: 82,
      mediumCount: 1,
      lowCount: 4,
      highestSeverity: 'CRITICAL',
      scannedAt: Date.now() - 3_600_000,
    },
  },
  { imageRef: 'redis:7', scan: null },
];

describe('PreDeployScanDialog', () => {
  it('renders each image with its scan counts or a not-scanned note', () => {
    render(
      <PreDeployScanDialog open stackName="web" images={images} onCancel={vi.fn()} onDeploy={vi.fn()} />,
    );
    expect(screen.getByText('nginx:1.14')).toBeInTheDocument();
    expect(screen.getByText(/31 critical/)).toBeInTheDocument();
    expect(screen.getByText('redis:7')).toBeInTheDocument();
    expect(screen.getByText('not scanned')).toBeInTheDocument();
  });

  it('calls onDeploy when Deploy is clicked', () => {
    const onDeploy = vi.fn();
    render(
      <PreDeployScanDialog open stackName="web" images={images} onCancel={vi.fn()} onDeploy={onDeploy} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(onDeploy).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <PreDeployScanDialog open stackName="web" images={images} onCancel={onCancel} onDeploy={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
