# Git transport live attestations

`docs/git-transport-attestations.yaml` retains the results of the live passes behind the "Live" rows of `docs/git-transport-support.yaml`. This file is the procedure that produces them, so a later pass can repeat it and compare.

A live pass proves one exact combination (host, transport, ref type, authentication, certificate trust, node path). It never extrapolates to a neighbouring combination.

## Before you start

- A Sencho instance running the revision that `implementation_baseline` names, signed in as an admin.
- For the node-path attestations, one proxy-mode node and one Pilot-agent node connected to that instance.
- Record the running image's digest (`docker image inspect <image> --format '{{index .RepoDigests 0}}'`).

## The request

Every attestation is one `POST /api/git-sources/browse` through the instance, with the node chosen by the `x-node-id` header:

```json
{ "repo_url": "https://host/owner/repo.git", "branch": "<branch, tag, or full commit SHA>", "auth_type": "none" }
```

For a Personal Access Token add `"auth_type": "token", "token": "<read-only token>"` and, for a private certificate authority, `"ca_bundle": "<PEM>"`. For SSH add `"auth_type": "deploy_key", "deploy_key": "<private key>", "ssh_known_hosts_entry": "<line>"`, taking the line from `POST /api/git-sources/ssh-host-key` with `{ "repo_url": "ssh://git@host:port/owner/repo.git" }`.

A pass succeeds when the response is HTTP 200 and `commitSha` is the commit the ref resolves to. A branch resolves to its tip, an annotated or lightweight tag to its target commit, and a full SHA to itself.

## Hosted hosts, public repositories

These need no account. Run each with `"auth_type": "none"` on the local node:

| Host | Repository | Refs |
|---|---|---|
| GitHub | `octocat/Hello-World` | branch `master`; that branch tip's commit SHA |
| GitLab | `gitlab-org/gitlab-test` | branch `master`; annotated tag `v1.0.0`; that tag's peeled commit SHA |
| Bitbucket | `atlassian_tutorial/helloworld` | branch `master`; that branch tip's commit SHA |

Repeat the GitHub branch request with `x-node-id` set to the proxy-mode node, then to the Pilot-agent node.

## Self-hosted hosts, disposable instances

Run Gitea and Forgejo at the versions named by `host_version` in the attestation file, each in a throwaway container:

1. Create a private certificate authority and a server certificate whose subject alternative name is the address Sencho will reach.
2. Start the forge over HTTPS with the built-in SSH server on its own port.
3. Create a user and a private repository with a `main` branch, an annotated tag `v1.0`, and a lightweight tag `v1.0-light`.
4. Create a read-only access token (repository read scope) and register a read-only deploy key.

Run six requests per forge:

| Transport | Authentication | Refs |
|---|---|---|
| HTTPS | token with the authority as `ca_bundle` | `main`, `v1.0`, the branch tip's commit SHA |
| SSH | deploy key and the probed host key | `main`, `v1.0-light`, the branch tip's commit SHA |

Remove the containers and certificates afterwards.

## Recording the result

1. In `docs/git-transport-attestations.yaml`, update each attestation's `id`, `date`, `source_commit` (the commit the instance runs), and `sencho_image_digest`. Record only structured pass or fail data and scrubbed commands: no tokens, keys, hostnames, or addresses beyond generic fixture identities.
2. Update every `attestation` reference and `implementation_baseline` in `docs/git-transport-support.yaml` to match.
3. From `backend/`, run `npm run matrix:render`, then `npx vitest run src/__tests__/git-support-matrix.test.ts`. The test fails when a claim's attestation was recorded against a different commit than `implementation_baseline`.
