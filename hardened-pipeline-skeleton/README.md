# Hardened Build publishing skeleton

> Do not create `Studio-Saelix/sencho-hardened` until explicit authorization is given.

This local skeleton defines the intended publishing controls for the Admiral-only Hardened Build image channel. It is preparation material, not a publishing system and not a private-source product.

The Hardened Build image is a separately published container artifact. Sencho remains AGPLv3, and every release must make the corresponding source available under the AGPLv3 terms.

## Assurance statement

At publish time, the pipeline must establish that the image has zero known critical or high exploitable CVEs according to the approved scanner policy and OpenVEX assessment. This is a point-in-time statement, not a guarantee that no vulnerability will be discovered later.

Each published image must include:

- A multi-architecture manifest and immutable digest
- An SBOM
- Build provenance
- A Cosign signature and verification material
- OpenVEX statements for assessed findings
- A documented CVE remediation and republish process

## Channel separation

Community images continue through the public channels. Hardened Build inputs are immutable source revision, lockfile, base-image digest, policy revision, and architecture list. The resulting image is published only to `ghcr.io/studio-saelix/sencho-hardened` after all gates pass.

The workflow skeleton intentionally contains placeholders instead of live credentials, action revisions, or publishing configuration. Fill them only in an authorized private delivery repository.

See [PUBLISH_POLICY.md](PUBLISH_POLICY.md) for the release gate and remediation rules.
