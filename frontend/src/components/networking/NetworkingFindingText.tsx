import type { NetworkingFinding } from '@/types/networking';

/** What a finding says and what to do about it: its message, then Doctor's remediation when it has one. */
export function NetworkingFindingText({ finding, showMessage = true }: { finding: NetworkingFinding; showMessage?: boolean }) {
  const remediation = finding.doctorFindings.find(entry => entry.remediation && entry.acknowledgement === undefined)?.remediation;
  return (
    <>
      <p className="text-sm font-medium text-stat-value">{finding.title}</p>
      {showMessage && <p className="text-xs text-stat-subtitle">{finding.message}</p>}
      {remediation && <p className="mt-0.5 text-xs text-stat-subtitle/80">{remediation}</p>}
    </>
  );
}
