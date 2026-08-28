/**
 * Adapter contract between GitSourceService and the native git transport.
 *
 * Resolution is separated from fetch on purpose: every pull resolves the
 * configured ref to an immutable commit BEFORE any content is downloaded,
 * and the fetch verifies it landed on exactly that commit. That makes
 * immutable resolution structural rather than a convention callers have to
 * remember. The ref field carries branch names today; widening it to tags and
 * pinned SHAs later does not change either method's shape.
 */

export interface ResolveRequest {
    repoUrl: string;
    /** Branch names today; tags and pinned SHAs may widen this later. */
    ref: string;
    token?: string | null;
    /**
     * Total fetch budget in milliseconds. Note: the resolution round trip
     * (ls-remote) is internally capped at 10s regardless of this value, so
     * the worst-case wall clock is roughly clamp(resolve) + full clone, plus
     * up to a further 5s per timed-out invocation while the transport waits
     * for confirmed child-process termination before giving up.
     */
    timeoutMs?: number;
    /**
     * Caller-owned temp workspace root. Resolution authenticates too (a
     * private repo hides its refs from anonymous ls-remote), so it needs a
     * place for the credential helper.
     */
    workspaceRoot: string;
}

export interface FetchRequest extends ResolveRequest {
    /**
     * Commit produced by resolveRef; the fetched checkout is verified to be
     * exactly this commit before it can be used. `ref` locates what to fetch,
     * `commitSha` pins what may be trusted.
     */
    commitSha: string;
    /** Ceiling for the on-disk clone; enforced by the size watchdog. */
    maxBytes: number;
}

export interface FetchResult {
    commitSha: string;
    /** Checked-out working tree, ready for read-only inspection. */
    dir: string;
}

export interface ResolveResult {
    commitSha: string;
}

export interface GitTransport {
    resolveRef(req: ResolveRequest): Promise<ResolveResult>;
    fetchAtCommit(req: FetchRequest): Promise<FetchResult>;
}
