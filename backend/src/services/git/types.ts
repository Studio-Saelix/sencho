/**
 * Adapter contract between GitSourceService and the native git transport.
 *
 * Resolution is separated from fetch on purpose: every pull resolves the
 * configured ref to an immutable commit BEFORE any content is downloaded,
 * and the fetch verifies it landed on exactly that commit. That makes
 * immutable resolution structural rather than a convention callers have to
 * remember.
 *
 * The configured ref is a free string: a branch name, a tag name, or a full
 * commit SHA. Only a full 40/64-hex SHA is unambiguous on its own, so the
 * transport resolves a bare name by asking the remote which namespace it
 * lives in (branch, then tag) and returns the concrete kind it resolved
 * through. That resolved kind is what callers record next to the immutable
 * SHA, so "tag v1 -> <sha>" and "branch v1 -> <sha>" stay distinguishable in
 * persisted revision state.
 */

export type RefKind = 'branch' | 'tag' | 'sha';

/** Deploy-key authentication material for SSH transports. */
export interface SshDeployKeyAuth {
    privateKey: string;
    knownHostsEntry: string;
}

export interface ResolveRequest {
    repoUrl: string;
    /** Configured ref: a branch name, a tag name, or a full 40/64-hex commit SHA. */
    ref: string;
    token?: string | null;
    sshAuth?: SshDeployKeyAuth | null;
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
    /**
     * The kind resolveRef resolved `ref` through. It drives the fetch
     * strategy: a branch or tag both ride `--branch <ref>` (git detaches at the
     * named ref's commit either way), and a pinned SHA needs a third path
     * (`git init` + `git fetch <sha>` + detached checkout), because `--branch`
     * cannot take a bare SHA.
     */
    refKind: RefKind;
    /** Ceiling for the on-disk clone; enforced by the size watchdog. */
    maxBytes: number;
}

export interface FetchResult {
    commitSha: string;
    /** Checked-out working tree, ready for read-only inspection. */
    dir: string;
}

export interface ResolveResult {
    /** The immutable commit the configured ref resolved to. */
    commitSha: string;
    /**
     * The namespace the configured ref resolved through. A bare name may be a
     * branch or a tag, so this is resolved by the remote, not guessed. A full
     * 40/64-hex SHA self-resolves with no network round-trip, so it always
     * reports `sha`.
     */
    kind: RefKind;
}

export interface GitTransport {
    resolveRef(req: ResolveRequest): Promise<ResolveResult>;
    fetchAtCommit(req: FetchRequest): Promise<FetchResult>;
}
