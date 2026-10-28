# Cross-compilation helper - provides xx-clang, xx-apk, etc.
# Runs on the BUILD platform; its binaries are copied into build stages below.
# Digest pinned to prevent silent base-image changes between scan and publish.
FROM --platform=$BUILDPLATFORM tonistiigi/xx@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6 AS xx

# Stage 1: Build Frontend
# Runs on the BUILD platform (amd64) - frontend has no native modules so the
# compiled output (JS/CSS/HTML) is entirely platform-agnostic.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package*.json frontend/.npmrc ./
RUN npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci

COPY frontend/ ./
# vite.config.ts reads the root package.json for the app version
COPY package.json /app/package.json
RUN npm run build

# Stage 2: Compile TypeScript
# Runs on the BUILD platform (amd64) - tsc output is platform-agnostic JS.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS backend-builder

WORKDIR /app/backend

RUN apk add --no-cache python3 make g++

COPY backend/package*.json backend/.npmrc ./
RUN npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5 && \
    npm ci

COPY backend/ ./
# prebuild hook (generate-version.js) reads the root package.json for the app version
COPY package.json /app/package.json
RUN npm run build

# Stage 3: Production dependencies (cross-compiled - NO QEMU execution)
# Runs on the BUILD platform (amd64) but compiles native modules
# (bcrypt, better-sqlite3, node-pty) for the TARGET platform using
# tonistiigi/xx + clang as the cross-compiler.
# This avoids the Node.js v20 SIGILL crash that occurs when npm runs
# under QEMU because QEMU lacks ARMv8.1 LSE atomic instruction support.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS prod-deps

# Copy xx cross-compilation tools into this stage
COPY --from=xx / /

ARG TARGETARCH
ARG BUILDARCH

WORKDIR /app

# Two paths depending on whether we are cross-compiling:
#
# Native (TARGETARCH == BUILDARCH, e.g. amd64 → amd64):
#   Standard g++ is used. xx-clang introduces sysroot flags that conflict with
#   node-gyp's header resolution on Alpine for same-platform builds, so we
#   bypass it entirely and let npm ci use the host compiler directly.
#
# Cross (TARGETARCH != BUILDARCH, e.g. amd64 → arm64):
#   xx-clang targets the foreign architecture without QEMU. The target sysroot
#   is populated via xx-apk:
#     g++           - libstdc++ headers/libs (all three native modules use C++)
#     musl-dev      - musl libc headers for the target arch
#     linux-headers - <pty.h> / <termios.h> required by node-pty
RUN if [ "$TARGETARCH" = "$BUILDARCH" ]; then \
      apk add --no-cache python3 make g++; \
    else \
      apk add --no-cache clang lld python3 make g++ && \
      xx-apk add --no-cache g++ musl-dev linux-headers; \
    fi

COPY backend/package*.json backend/.npmrc ./

# Native: plain npm ci - g++ compiles native modules for the host arch.
# Cross:  npm_config_arch tells prebuild-install/node-pre-gyp which pre-built
#         binary to attempt; CC/CXX/AR route compilation through xx-clang so
#         the output targets the foreign arch without any QEMU emulation.
RUN if [ "$TARGETARCH" = "$BUILDARCH" ]; then \
      npm ci --omit=dev; \
    else \
      npm_config_arch=$TARGETARCH \
        CC=xx-clang \
        CXX=xx-clang++ \
        AR=xx-ar \
        npm ci --omit=dev; \
    fi

# Stage 4a: Build Docker CLI from source against Go 1.27.3
#
# CLI v29.4.1 ships otel/sdk v1.43.0, resolving CVE-2026-39883 (BSD kenv) and
# CVE-2026-39882 (OTLP response OOM). Building against grpc v1.83.2 below
# transitively resolves otel to v1.44.0, which additionally clears
# CVE-2026-41178 (baggage header parsing dropped its raw-length cap, allowing
# resource exhaustion via an oversized header, present through v1.43.0). It
# also carries the CVE-2025-15558 fix (Windows plugin search path LPE, fixed
# since v29.2.0). Building from source with Go 1.27.3 additionally eliminates
# Go stdlib CVEs present in the upstream static binary.
#
# Runs on the BUILD platform; GOARCH cross-compiles the static binary for
# TARGET. The fetch pulls only the v29.4.1 commit, minimising transfer size.
# docker/cli uses CalVer and ships vendor.mod instead of go.mod to avoid
# SemVer compliance requirements. We copy vendor.mod -> go.mod, drop the
# committed vendor tree, bump golang.org/x/net to v0.60.0, golang.org/x/text
# to v0.42.0, google.golang.org/grpc to v1.83.2, and
# github.com/moby/go-archive to v0.3.0, and build with -mod=mod so the patched
# modules are resolved from the module proxy. x/net v0.53.0 is flagged for six
# HIGH advisories (CVE-2026-25680, -25681, -27136, -39821, -42502, -42506;
# x/net/html parsing and x/net/idna). x/net v0.55.0 is flagged for
# CVE-2026-46600 (dnsmessage denial of service), and v0.58.0 for
# CVE-2026-78669 (HTTP/2 SETTINGS-flood denial of service), fixed in v0.60.0,
# whose minimum golang.org/x/text is v0.42.0. x/text v0.37.0 is flagged for
# CVE-2026-56852 (norm.Iter infinite loop on crafted input). grpc v1.80.0 is
# flagged for GHSA-hrxh-6v49-42gf (xDS RBAC / HTTP/2), and grpc v1.82.1 for
# CVE-2026-84304 (unauthenticated peer OOM via fragmented HTTP/2 DATA frames
# buffered per-message). go-archive v0.2.0 is flagged for CVE-2026-17106
# (HIGH), where a crafted tar archive can write outside the extraction
# directory. go-jose v4.1.4 is flagged for CVE-2026-116587 (HIGH, denial of
# service while parsing JWKs that contain RSA keys), fixed in v4.1.6.
# Removing vendor/ keeps -mod=mod from reading the stale copy, and
# avoids `go mod tidy` (which does not run cleanly against docker/cli's
# vendor.mod manifest). This stage now fetches modules at build time rather
# than building fully offline.
# Base image pinned by digest so the Go toolchain that compiles the static
# Docker CLI binary cannot change without an explicit Dependabot bump. The
# 1.27.3 toolchain carries the stdlib fixes for CVE-2026-111943 (crypto/x509
# intermediate-certificate verification), CVE-2026-78667 (net/http
# Range-header denial of service) and CVE-2026-97031 (crypto/tls ECH denial
# of service).
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:d530cf60723abf1ffae0cd16bb546b379ec0550d2f3815e5b16ed69dbc00fba4 AS cli-builder

ARG TARGETARCH

RUN apk add --no-cache git

# Fetch by commit SHA rather than by mutable tag. The SHA below resolves to
# the docker/cli v29.4.1 release; recorded here for traceability since the
# raw SHA does not carry semantic information.
RUN git init /src/docker-cli && \
    cd /src/docker-cli && \
    git remote add origin https://github.com/docker/cli.git && \
    git fetch --depth=1 origin 407f3428e5c5a3a4088f9268bc7159f5e0f95bea && \
    git checkout FETCH_HEAD

WORKDIR /src/docker-cli

RUN mkdir -p /build

RUN cp vendor.mod go.mod && cp vendor.sum go.sum && \
    rm -rf vendor && \
    go get golang.org/x/net@v0.60.0 \
           golang.org/x/text@v0.42.0 \
           google.golang.org/grpc@v1.83.2 \
           github.com/moby/go-archive@v0.3.0 \
           github.com/go-jose/go-jose/v4@v4.1.6 && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
      -mod=mod \
      -ldflags "-extldflags=-static \
        -X github.com/docker/cli/cli/version.Version=29.4.1 \
        -X github.com/docker/cli/cli/version.GitCommit=source-go1.27.3" \
      -o /build/docker \
      ./cmd/docker

# Stage 4b: Build Docker Compose from source against Go 1.27.3
#
# Compose v5.6.0 requires Go 1.26.8 or newer, which the pinned 1.27.3 toolchain
# satisfies. That toolchain also carries the stdlib fixes for CVE-2026-111943
# (crypto/x509 intermediate-certificate verification), CVE-2026-78667 (net/http
# Range-header denial of service) and CVE-2026-97031 (crypto/tls ECH denial of
# service), so the binary's SBOM carries no Go stdlib CVEs.
#
# The v5.6.0 tag lifts almost every module floor this stage used to carry by
# hand. Its own go.mod resolves otel/sdk v1.46.0 (CVE-2026-39883,
# CVE-2026-39882, CVE-2026-41178), google.golang.org/grpc v1.84.0
# (GHSA-hrxh-6v49-42gf, CVE-2026-84304, CVE-2026-84445), moby/go-archive
# v0.3.3 (CVE-2026-17106), moby/buildkit v0.33.1 (CVE-2026-61711), and
# containerd/containerd/v2 v2.4.1 (CVE-2026-46680, the CVE-2026-53488 / 53489 /
# 53492 cluster, CVE-2026-95837, CVE-2026-95838), so the go get step below no
# longer pins any of them.
#
# Six VEX statements written for earlier Compose tags no longer describe what
# this stage builds. Five cover daemon-side advisories against
# github.com/docker/docker v28.5.2 (CVE-2026-34040, CVE-2026-33997,
# CVE-2026-41567, CVE-2026-41568, CVE-2026-42306): v5.6.0 drops that module
# from the graph, with moby/moby/api v1.56.1 and moby/moby/client v0.6.1 as the
# direct API surface, so those statements are deleted. The sixth,
# GHSA-pmwq-pjrm-6p5r, was waiting on an upstream tag that pulled
# in-toto-golang v0.11.0 rather than v0.10.0; v5.6.0 is that tag, so its
# statement now records the fix (status: fixed) instead of a not_affected
# triage.
#
# Three floors remain, because v5.6.0 still resolves earlier versions of them:
# golang.org/x/net v0.60.0, from v0.58.0, for CVE-2026-46600 (dnsmessage denial
# of service) and CVE-2026-78669 (HTTP/2 SETTINGS-flood denial of service);
# golang.org/x/text v0.42.0, from v0.41.0, for CVE-2026-56852 (norm.Iter
# infinite loop on crafted input); and golang.org/x/crypto v0.57.0, from
# v0.56.0, for CVE-2026-56854 (SSH host-key verification bypass). x/net v0.60.0
# requires exactly those x/text and x/crypto minimums, which is why the three
# move together.
# Base image pinned by digest (same image as cli-builder above) so both
# source builds share an identical, immutable Go toolchain.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:d530cf60723abf1ffae0cd16bb546b379ec0550d2f3815e5b16ed69dbc00fba4 AS compose-builder

ARG TARGETARCH

RUN apk add --no-cache git

# Fetch by commit SHA. The SHA below resolves to the docker/compose v5.6.0
# release; recorded here for traceability since the raw SHA does not carry
# semantic information.
RUN git init /src/docker-compose && \
    cd /src/docker-compose && \
    git remote add origin https://github.com/docker/compose.git && \
    git fetch --depth=1 origin 42f48072bbf92ee9b0e43f9fdf2008d03546e7ca && \
    git checkout FETCH_HEAD

WORKDIR /src/docker-compose

RUN mkdir -p /build

# Carry three floors above what v5.6.0 resolves: golang.org/x/net v0.60.0
# (CVE-2026-46600, CVE-2026-78669), golang.org/x/text v0.42.0
# (CVE-2026-56852), and golang.org/x/crypto v0.57.0 (CVE-2026-56854). x/net
# v0.60.0's own go.mod requires those exact x/text and x/crypto minimums.
# Every other floor this stage used to carry is now resolved by the tag itself.
RUN --mount=type=cache,id=go-mod,sharing=locked,target=/go/pkg/mod \
    go get golang.org/x/text@v0.42.0 \
           golang.org/x/net@v0.60.0 \
           golang.org/x/crypto@v0.57.0 && \
    go mod tidy

# Build target is ./cmd (the package main with plugin.Run), per docker/compose's
# Makefile. The directory ./cmd/compose is package compose (cobra command
# definitions only, not main). The module path moved from /v2 to /v5 in the
# v5 release, so the Version ldflag must reference /v5/internal.
RUN --mount=type=cache,id=go-mod,sharing=locked,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
      -trimpath \
      -ldflags "-s -w -extldflags=-static \
        -X github.com/docker/compose/v5/internal.Version=v5.6.0" \
      -o /build/docker-compose \
      ./cmd

# Sanity check: fail the stage immediately if go build did not produce an ELF
# executable. Catches the failure mode where -o file points to a non-main
# package and Go writes an ar-format archive that passes COPY + chmod but is
# not exec-able by the kernel, surfacing only as an opaque plugin-not-found
# error from the Docker CLI plugin manager hundreds of build steps later.
# `od -tx1` is used instead of `-c` because busybox and GNU coreutils render
# `-c` with different field padding; hex output is stable across both.
RUN test -f /build/docker-compose \
 && magic=$(dd if=/build/docker-compose bs=1 count=4 status=none | od -An -tx1 | tr -d ' \n') \
 && [ "$magic" = "7f454c46" ]

# Stage 5: Production runtime
# Runs on the TARGET platform - no compilation happens here.
#
# Vulnerability scanning uses the external `trivy` CLI. It is not installed
# in this image; operators who want the feature install Trivy on the host
# and mount the binary into the container, or run a sidecar. See
# docs/operations/trivy-setup.mdx for the supported integration paths.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797

# Daily cache-bust for the apk upgrade layer. CI passes the current date
# (YYYY-MM-DD) as a build-arg, so this RUN layer's hash changes at most
# once per calendar day. Without this, buildx reuses the cached layer
# indefinitely and a new Alpine package fix (e.g. an openssl CVE patched
# upstream in alpine 3.23) sits behind the stale cache until an unrelated
# change invalidates this line by coincidence. Default value lets local
# developers build without the arg; production CI always sets it.
ARG APK_CACHE_BUST=unset

# Upgrade all Alpine system packages and install runtime deps.
# git is required at runtime: Git Sources clones through the native git
# client. Docker CLI and Compose are copied from source-built stages below,
# eliminating the curl dependency and all Go stdlib CVEs from the upstream
# static binaries. npm is removed because it is not needed at runtime;
# removing it also eliminates CVE-2026-33671 (picomatch ReDoS in npm).
#
# pcre2 arrives as a transitive dependency of git, so it is not present in the
# base image and `apk upgrade` alone decides its version. The floor is here
# because the daily cache-bust key is a date: a fix that lands in Alpine's repo
# during the day is invisible to any build that reuses a `apk upgrade` layer
# cached earlier the same day, and the scanned image kept shipping the previous
# pcre2 (CVE-2026-103111, fixed in 10.49-r0). Naming the floor rebuilds this
# layer and keeps a stale cache from serving a version below the fix again.
#
# libexpat arrives the same way, as a transitive dependency of git, and a
# reused layer serves it stale for the same reason. Its floor is named for the
# same purpose: CVE-2026-77214 (heap over-read in XML_ParseBuffer, HIGH, fixed
# in 2.9.0-r0) was published while this layer's cache from earlier the same day
# still held 2.8.5-r0, so the scan failed on an image the cache had pinned.
RUN echo "apk cache bust: ${APK_CACHE_BUST}" && \
    apk upgrade --no-cache && \
    apk add --no-cache bash su-exec git tini 'openssh-client>=10.3_p1-r1' 'pcre2>=10.49-r0' 'libexpat>=2.9.0-r0' && \
    mkdir -p /usr/local/lib/docker/cli-plugins

# Copy the source-built Docker CLI and Compose plugin from their builder stages.
# These binaries were compiled with Go 1.27.3, resolving all Go stdlib CVEs that
# were present in the upstream static release binaries.
COPY --from=cli-builder /build/docker /usr/local/bin/docker
COPY --from=compose-builder /build/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
RUN chmod +x /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-compose

# Remove npm and npx from the runtime image. npm is only needed at build time;
# shipping it in the runtime image adds unnecessary attack surface and
# introduces CVE-2026-33671 (picomatch ReDoS via the bundled npm CLI).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

WORKDIR /app

# Copy cross-compiled production node_modules from the prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./

# Copy compiled TypeScript output (platform-agnostic JS)
COPY --from=backend-builder /app/backend/dist ./dist

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./public

# Set environment to production
ENV NODE_ENV=production

# Pre-create the sencho user and group so the SENCHO_USER=sencho opt-out path
# in docker-entrypoint.sh works out of the box. The default runtime is root;
# this user only becomes relevant when an operator explicitly sets
# SENCHO_USER at runtime to drop privileges.
RUN addgroup -S sencho && adduser -S -G sencho sencho \
  && mkdir -p /app/data \
  && chown -R sencho:sencho /app

# Sencho runs as root by default. Docker management tools like Portainer,
# Dockge, Komodo, and Yacht all ship this way because mounting
# /var/run/docker.sock is already equivalent to root-on-host; a non-root
# container user buys essentially no extra isolation while breaking
# filesystem operations against bind mounts that user stacks have chowned.
#
# Operators who need a non-root container (compliance scanners, rootless
# Docker with UID mapping, organisational policy) can set SENCHO_USER=sencho
# at runtime. The entrypoint handles the privilege drop, data-volume
# ownership, and Docker socket GID matching in that path.
#
# USER directive intentionally absent so the entrypoint controls the runtime
# user. Static security scanners (Trivy, Docker Scout) may flag this as
# "running as root" which is the documented and intended default.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Strip Windows CRLF line endings that can sneak in on Windows dev machines
# even with .gitattributes eol=lf, then make executable. A shell script with
# \r in tokens like "fi\r" will fail with "unexpected end of file" in Alpine.
RUN sed -i 's/\r//' /usr/local/bin/docker-entrypoint.sh \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 1852

# Health check - polls /api/health every 30s. The compiled probe is required
# because an inline HTTP one-liner cannot speak TLS when native TLS is on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

# Tini owns PID 1 so orphaned Git transport helpers are reaped after a
# process-group kill. The entrypoint still prepares /app/data before execing
# the application command.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
