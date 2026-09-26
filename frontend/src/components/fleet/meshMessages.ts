import type { MeshProbeResult } from '@/types/mesh';

/** The one next step a failure message points at. */
export type MeshFixAction = 'diagnostics' | 'route' | 'activity' | null;

export interface MeshHumanMessage {
    message: string;
    fix: MeshFixAction;
}

/**
 * Turn a probe failure into a sentence an operator can act on, plus the
 * single place to go next. Replaces toasts like "db.api.opsix.sencho
 * agent_dial: unreachable".
 */
export function describeProbeFailure(
    alias: string,
    result: Pick<MeshProbeResult, 'where' | 'code' | 'message'>,
    target?: { nodeName?: string; port?: number },
): MeshHumanMessage {
    const node = target?.nodeName ?? 'its node';
    switch (result.where) {
        case 'no_route':
            return {
                message: `${alias} is not published right now. Its stack is stopped or no longer in the mesh.`,
                fix: 'route',
            };
        case 'pilot_tunnel':
            return { message: `Could not reach ${node}. The connection to that node is down.`, fix: 'diagnostics' };
        case 'agent_resolve':
            return { message: `${node} does not publish ${alias}. The stack is not in the mesh on its node.`, fix: 'route' };
        case 'agent_dial':
            return { message: `Reached ${node}, but could not connect to the container behind ${alias}. Check that it is running.`, fix: 'route' };
        case 'target_port':
            return {
                message: target?.port
                    ? `The container behind ${alias} is not listening on port ${target.port}.`
                    : `The container behind ${alias} is not listening on its port.`,
                fix: 'route',
            };
        default:
            return { message: `${alias} failed its test${result.message ? `: ${result.message}` : '.'}`, fix: 'activity' };
    }
}

/** Button label for a fix action. */
export function fixActionLabel(fix: Exclude<MeshFixAction, null>): string {
    switch (fix) {
        case 'diagnostics': return 'Open diagnostics';
        case 'route': return 'Open route';
        case 'activity': return 'View activity';
    }
}

/**
 * Human message for a failed opt-in / opt-out / node toggle, from the HTTP
 * status and the backend's error text.
 */
export function describeMembershipError(httpStatus: number, backendError?: string | null): string {
    const detail = backendError?.trim();
    switch (httpStatus) {
        case 409:
            return detail
                ? `That port is already used by another meshed service (${detail}). Move one service to a different port, or leave this stack out.`
                : 'That port is already used by another meshed service. Move one service to a different port, or leave this stack out.';
        case 503:
            // 503 covers both "the data plane is down" and a failed push (a
            // stack operation lock, for example). Only claim the data plane
            // when the backend gave no more specific reason.
            return detail
                ? `Could not change mesh membership: ${detail}`
                : 'Mesh is not ready on this node. Check the banner at the top of this tab.';
        case 401:
        case 403:
            return 'Only an administrator can change mesh membership.';
        case 404:
            return detail ?? 'The stack or node no longer exists. Refresh and try again.';
        default:
            return detail
                ? `Mesh update failed: ${detail}`
                : `Mesh update failed (HTTP ${httpStatus}). The mesh activity log has details.`;
    }
}
