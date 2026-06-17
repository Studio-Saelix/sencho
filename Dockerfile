# Cross-compilation helper - provides xx-clang, xx-apk, etc.
# Runs on the BUILD platform; its binaries are copied into build stages below.
# Digest pinned to prevent silent base-image changes between scan and publish.
FROM --platform=$BUILDPLATFORM tonistiigi/xx@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx

# Stage 1: Build Frontend
# Runs on the BUILD platform (amd64) - frontend has no native modules so the
# compiled output (JS/CSS/HTML) is entirely platform-agnostic.
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5 AS frontend-builder

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
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5 AS backend-builder

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
FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5 AS prod-deps

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

# Stage 4a: Build Docker CLI from source against Go 1.26.3
#
# CLI v29.4.1 ships otel/sdk v1.43.0, resolving CVE-2026-39883 (BSD kenv) and
# CVE-2026-39882 (OTLP response OOM). It also carries the CVE-2025-15558 fix
# (Windows plugin search path LPE, fixed since v29.2.0). Building from source
# with Go 1.26.3 additionally eliminates Go stdlib CVEs present in the upstream
# static binary.
#
# Runs on the BUILD platform; GOARCH cross-compiles the static binary for TARGET.
# The fetch pulls only the v29.4.1 commit, minimising transfer size.
# docker/cli uses CalVer and ships vendor.mod instead of go.mod to avoid SemVer
# compliance requirements. We copy vendor.mod -> go.mod and build with -mod=vendor
# so all deps come from the vendored tree (no network access needed).
# Base image pinned by digest so the Go toolchain that compiles the static
# Docker CLI binary cannot change without an explicit Dependabot bump.
FROM --platform=$BUILDPLATFORM golang:1.26.4-alpine@sha256:f23e8b227fb4493eabe03bede4d5a32d04092da71962f1fb79b5f7d1e6c2a17f AS cli-builder

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
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
      -mod=vendor \
      -ldflags "-extldflags=-static \
        -X github.com/docker/cli/cli/version.Version=29.4.1 \
        -X github.com/docker/cli/cli/version.GitCommit=source-go1.26.3" \
      -o /build/docker \
      ./cmd/docker

# Stage 4b: Build Docker Compose from source against Go 1.26.3
#
# Compose v5.1.3 moved github.com/docker/docker from a direct require to an
# indirect dep (the direct surface is now moby/moby/api + moby/moby/client),
# but the docker/docker module is still pulled into the binary via buildkit
# and other transitive paths. Several daemon-side CVEs against docker/docker
# v28.5.2 (CVE-2026-34040, CVE-2026-33997, CVE-2026-41567, CVE-2026-41568,
# CVE-2026-42306) therefore still appear in scans of the compose binary;
# they are tracked as not_affected in security/vex/sencho.openvex.json
# because compose is the client and the vulnerable code paths are reached
# only by Docker Engine the daemon. Rebuilding with the patched Go
# toolchain eliminates Go stdlib CVEs from the binary's SBOM.
#
# Compose v5.1.3 still bundles otel/sdk v1.42.0 transitively via buildkit
# v0.29.0. The go get step below bumps otel to v1.43.0 to resolve
# CVE-2026-39883 (BSD kenv) and CVE-2026-39882 (OTLP response OOM) so that
# the compose binary scans completely clean.
#
# Compose v5.1.3 also pins github.com/containerd/containerd/v2 v2.2.3, which
# carries CVE-2026-46680 (runAsNonRoot evasion in containerd's runtime
# executor). The same go get step bumps containerd/v2 to v2.2.4 to clear it.
# v2.2.3 to v2.2.4 is a patch-level fix; the release notes name CVE-2026-46680
# as the headline item. The vulnerable code path is daemon-side and not reached
# by compose at all, so this is defense-in-depth rather than a live exposure.
# Base image pinned by digest (same image as cli-builder above) so both
# source builds share an identical, immutable Go toolchain.
FROM --platform=$BUILDPLATFORM golang:1.26.4-alpine@sha256:f23e8b227fb4493eabe03bede4d5a32d04092da71962f1fb79b5f7d1e6c2a17f AS compose-builder

ARG TARGETARCH

RUN apk add --no-cache git

# Fetch by commit SHA. The SHA below resolves to the docker/compose v5.1.3
# release; recorded here for traceability since the raw SHA does not carry
# semantic information.
RUN git init /src/docker-compose && \
    cd /src/docker-compose && \
    git remote add origin https://github.com/docker/compose.git && \
    git fetch --depth=1 origin 5b2badbda44f3410b2a6c58dff79def21fe8b13e && \
    git checkout FETCH_HEAD

WORKDIR /src/docker-compose

RUN mkdir -p /build

# Patch otel/sdk and exporters from v1.42.0 → v1.43.0 to clear CVE-2026-39883
# and CVE-2026-39882, and bump containerd/v2 from v2.2.3 → v2.2.4 to clear
# CVE-2026-46680. Both are targeted patch-level security bumps with no
# breaking API changes.
RUN --mount=type=cache,id=go-mod,sharing=locked,target=/go/pkg/mod \
    go get go.opentelemetry.io/otel@v1.43.0 \
           go.opentelemetry.io/otel/sdk@v1.43.0 \
           go.opentelemetry.io/otel/sdk/metric@v1.43.0 \
           go.opentelemetry.io/otel/metric@v1.43.0 \
           go.opentelemetry.io/otel/trace@v1.43.0 \
           go.opentelemetry.io/otel/exporters/otlp/otlptrace@v1.43.0 \
           go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc@v1.43.0 \
           go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.43.0 \
           go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc@v1.43.0 \
           go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp@v1.43.0 \
           github.com/containerd/containerd/v2@v2.2.4 && \
    go mod tidy

# Build target is ./cmd (the package main with plugin.Run), per docker/compose's
# Makefile. The directory ./cmd/compose is package compose (cobra command
# definitions only, not main). The module path moved from /v2 to /v5 in the
# v5 release, so the Version ldflag must reference /v5/internal.
RUN --mount=type=cache,id=go-mod,sharing=locked,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
      -trimpath \
      -ldflags "-s -w -extldflags=-static \
        -X github.com/docker/compose/v5/internal.Version=v5.1.3" \
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
FROM node:26-alpine@sha256:9c0e1e52125d6b67d505cf75b4880fcf1290ccea5c480849910e1d57b2cf72b5

# Daily cache-bust for the apk upgrade layer. CI passes the current date
# (YYYY-MM-DD) as a build-arg, so this RUN layer's hash changes at most
# once per calendar day. Without this, buildx reuses the cached layer
# indefinitely and a new Alpine package fix (e.g. an openssl CVE patched
# upstream in alpine 3.23) sits behind the stale cache until an unrelated
# change invalidates this line by coincidence. Default value lets local
# developers build without the arg; production CI always sets it.
ARG APK_CACHE_BUST=unset

# Upgrade all Alpine system packages and install runtime deps.
# Docker CLI and Compose are copied from source-built stages below,
# eliminating the curl dependency and all Go stdlib CVEs from the upstream
# static binaries. npm is removed because it is not needed at runtime;
# removing it also eliminates CVE-2026-33671 (picomatch ReDoS in npm).
RUN echo "apk cache bust: ${APK_CACHE_BUST}" && \
    apk upgrade --no-cache && \
    apk add --no-cache bash su-exec && \
    mkdir -p /usr/local/lib/docker/cli-plugins

# Copy the source-built Docker CLI and Compose plugin from their builder stages.
# These binaries were compiled with Go 1.26.3, resolving all Go stdlib CVEs that
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

# Health check - polls the public /api/health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://localhost:1852/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Entrypoint ensures /app/data is writable and execs the CMD as root by default,
# or drops to $SENCHO_USER via su-exec when that env var is set (see comment above).
# CMD provides the default arguments passed through to the entrypoint.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
