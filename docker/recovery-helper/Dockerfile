# Sencho recovery helper.
#
# A purpose-built worker image for volume points: restic built from a pinned
# source commit, plus `sencho-recovery-probe`, on an empty root filesystem.
# Nothing else is in the image, so a container started from it can hold no
# shell, no package manager and no network client.
#
# Sencho publishes this digest and bakes it into the paired Sencho image; the
# runtime only ever starts a helper by digest. See docs/operations/
# volume-recovery-points.mdx and docs/internal/architecture/recovery-engine.md.

ARG GO_IMAGE=golang:1.27.3-alpine@sha256:d530cf60723abf1ffae0cd16bb546b379ec0550d2f3815e5b16ed69dbc00fba4

# restic 0.19.1, tag v0.19.1. The tag-to-commit match is checked below, so a
# moved tag or a wrong SHA fails the build instead of shipping different code.
ARG RESTIC_VERSION=0.19.1
ARG RESTIC_COMMIT=6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS restic-builder

ARG RESTIC_VERSION
ARG RESTIC_COMMIT
ARG TARGETARCH

RUN apk add --no-cache git

WORKDIR /src
RUN git init --quiet . \
 && git remote add origin https://github.com/restic/restic.git \
 && git fetch --quiet --depth 1 origin "${RESTIC_COMMIT}" \
 && git checkout --quiet FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${RESTIC_COMMIT}" \
 && test "$(cat VERSION)" = "${RESTIC_VERSION}"

# Dependency floors. Each is above the version restic v0.19.1 resolves, because
# that resolution carries a HIGH finding this image would otherwise ship. The
# versions match the floors the main Dockerfile already carries where they
# overlap, so one triage covers both binaries:
#   github.com/klauspost/compress v1.18.7  CVE-2026-63209 (dictionary integer overflow)
#   golang.org/x/crypto v0.57.0            CVE-2026-56854 (ssh source-address bypass)
#   golang.org/x/net v0.60.0               CVE-2026-46600, CVE-2026-78669 (dnsmessage, http2 DoS)
#   golang.org/x/text v0.42.0              CVE-2026-56851, CVE-2026-56852 (slice, UTF-8 DoS)
#   google.golang.org/grpc v1.84.0         CVE-2026-84304, CVE-2026-84445, GHSA-hrxh-6v49-42gf
# `go mod tidy` drops any floor restic does not actually import, so the binary
# gains no module it did not already have.
RUN go get github.com/klauspost/compress@v1.18.7 \
           golang.org/x/crypto@v0.57.0 \
           golang.org/x/net@v0.60.0 \
           golang.org/x/text@v0.42.0 \
           google.golang.org/grpc@v1.84.0 \
 && go mod tidy

# `-trimpath` and an empty build id keep the binary reproducible; no CGO means
# no libc in the final stage, which is what lets it run on `scratch`.
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
    go build -trimpath \
      -tags "selfupdate disable_grpc_modules" \
      -ldflags "-s -w -buildid=" \
      -o /out/restic ./cmd/restic

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS probe-builder

ARG TARGETARCH

WORKDIR /src
COPY probe/go.mod ./
COPY probe/main.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" go vet ./... \
 && CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags "-s -w -buildid=" -o /out/sencho-recovery-probe .

FROM scratch

ARG RESTIC_VERSION
ARG RESTIC_COMMIT

LABEL org.opencontainers.image.title="sencho-recovery-helper" \
      org.opencontainers.image.description="Restic worker for Sencho volume recovery points" \
      org.opencontainers.image.source="https://github.com/studio-saelix/sencho" \
      org.opencontainers.image.licenses="BSD-2-Clause" \
      org.opencontainers.image.version="${RESTIC_VERSION}" \
      org.opencontainers.image.revision="${RESTIC_COMMIT}" \
      dev.sencho.recovery.helper="1"

COPY --from=restic-builder /out/restic /restic
COPY --from=probe-builder /out/sencho-recovery-probe /sencho-recovery-probe

# The runtime starts the helper with an explicit profile (root, no added
# capability unless the profile names one) and a read-only root filesystem with
# a size-capped /tmp. These defaults only make a manual run behave the same way.
ENV TMPDIR=/tmp
USER 0:0
ENTRYPOINT ["/restic"]
