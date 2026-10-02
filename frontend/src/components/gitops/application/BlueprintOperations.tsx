import { useAuth } from '@/context/AuthContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import GitOpsAuthorityActions from '@/components/gitops/GitOpsAuthorityActions';
import GitOpsRolloutControls from '@/components/gitops/GitOpsRolloutControls';
import type { GitOpsPortfolioDetailResponse } from '@/types/gitopsPortfolio';

/**
 * The decisions and rollout controls for a Blueprint application: the outstanding
 * authority step, and for a Git-managed Blueprint the pause, resume, replan,
 * supersede, and rollback controls. Rendered inside the application sheet, so
 * deciding happens where the state is read. Renders nothing on a phone, for a
 * node-scoped Blueprint application (no `bp:` id), or when the server did not say
 * whether the Blueprint is enabled; a Direct application never reaches it,
 * because its actions live on its Git source sheet.
 *
 * Both Blueprint modes reach the authority block, not just the Git-managed one.
 * A demoted application still has a placement policy the placement decision
 * evaluates, so it needs the control that sets it; the Git-only actions inside
 * gate themselves on the target mode. The rollout controls beside them are a
 * different question and stay Git-only.
 */
export function BlueprintOperations({ data, refresh }: {
  data: GitOpsPortfolioDetailResponse;
  refresh: () => void;
}) {
  const { can } = useAuth();
  const isMobile = useIsMobile();
  const row = data.application;
  const id = row.id;
  const blueprintEnabled = data.blueprintEnabled;
  const canOperate = !isMobile
    && id.startsWith('bp:')
    && (row.targetMode === 'blueprint' || row.targetMode === 'inline_blueprint')
    && typeof blueprintEnabled === 'boolean';
  if (!canOperate) return null;
  return (
    <div className="flex flex-col gap-2">
      <GitOpsAuthorityActions
        applicationId={id}
        blueprintId={row.blueprintId}
        blueprintName={row.name}
        projection={data.projection}
        onChanged={refresh}
        can={can}
        blueprintEnabled={blueprintEnabled}
      />
      {row.targetMode === 'blueprint' && (
        <GitOpsRolloutControls
          applicationId={id}
          projection={data.projection}
          onChanged={refresh}
          can={can}
          blueprintEnabled={blueprintEnabled}
          rollbackGenerations={data.rollbackCandidates}
          nodeLabel={(nodeId) => row.targets.find(entry => entry.nodeId === nodeId)?.nodeName ?? `node ${nodeId}`}
        />
      )}
    </div>
  );
}
