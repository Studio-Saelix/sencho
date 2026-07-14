# Hardened Build publish policy

> Do not create `Studio-Saelix/sencho-hardened` until explicit authorization is given.

## Publish prerequisites

1. Build from an approved immutable source revision.
2. Pin all base images by digest and retain the resolved lockfile.
3. Produce the required architecture images before creating the manifest.
4. Scan each architecture image and evaluate findings against the approved OpenVEX policy.
5. Block publication when a known critical or high finding is exploitable and lacks an approved remediation decision.
6. Generate and attach SBOM and provenance records.
7. Sign the immutable manifest digest with Cosign.
8. Publish the matching AGPLv3 corresponding source notice with the release metadata.

## Advisory and remediation

An advisory can be recommended, cautionary, blocked, or unavailable. A blocked advisory prevents a new published tag. A newly disclosed issue in an already published image is triaged, recorded in OpenVEX where appropriate, remediated in a new immutable build, and communicated through the advisory channel.

Rollback repoints the supported tag to a prior signed digest only after confirming that its advisory state is suitable for use. Rollback does not overwrite an existing immutable digest.

## Evidence retained per publication

- Source revision, dependency lockfile digest, and base-image digests
- Scanner reports and OpenVEX version
- SBOM and provenance attestations
- Cosign signature verification output
- Publication timestamp, manifest digest, and advisory decision
