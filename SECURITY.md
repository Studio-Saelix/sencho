# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | No |

Sencho is self-hosted software. Always run the latest release to receive security patches.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

You can report security issues in two ways:

1. **Email:** Send details to **security@sencho.io**
2. **GitHub:** Use [private vulnerability reporting](https://github.com/studio-saelix/sencho/security/advisories/new) in the Security tab

In your report, include: steps to reproduce, impact assessment, and any suggested fixes.

You can expect an initial response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Security Considerations

Sencho manages Docker containers and has access to the Docker socket. When deploying:

- Always run behind a reverse proxy with TLS in production
- Use strong passwords and rotate JWT secrets
- Restrict network access to the Sencho port
- Review the [security configuration docs](https://docs.sencho.io) for hardening guidance

## Verifying Release Artifacts

Every published image is signed and carries verifiable supply-chain artifacts. See the full guide at [docs.sencho.io/operations/verifying-images](https://docs.sencho.io/operations/verifying-images).

Quick summary:

```bash
# Verify image signature (cosign keyless, Rekor logged)
cosign verify saelix/sencho:<tag> \
  --certificate-identity-regexp "https://github.com/Studio-Saelix/sencho/.*" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# Scan with VEX applied (zero unresolved HIGH/CRITICAL CVEs)
trivy image --vex sencho.openvex.json --severity HIGH,CRITICAL saelix/sencho:<tag>
```

CycloneDX SBOM (`sbom.cdx.json`), SPDX SBOM (`sbom.spdx.json`), and the VEX document (`sencho.openvex.json`) are attached to every GitHub Release as downloadable assets and as cosign attestations on the image digest.
