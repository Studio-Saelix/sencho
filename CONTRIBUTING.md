# Contributing to Sencho

Thank you for your interest in contributing to Sencho!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/sencho.git`
3. Create a branch: `git checkout -b feature/your-feature`
4. Install dependencies:
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```
5. Start the dev servers:
   ```bash
   cd backend && npm run dev    # Express + nodemon on :1852
   cd frontend && npm run dev   # Vite on :5173
   ```

## Project Layout

```
backend/
  src/
    routes/       # One router per feature group (stacks, nodes, fleet, ...)
    services/     # Business logic singletons (ComposeService, DockerController, ...)
    middleware/   # Auth, audit log, node context
    websocket/    # Upgrade handlers for log streaming, host console, proxy tunnels
frontend/
  src/
    components/   # Page-level and shared UI components
    context/      # Auth, node selection, and other React contexts
    hooks/        # Shared React hooks
    lib/          # apiFetch wrapper and other utilities
```

See the rest of this file for the most important contributor-facing standards (TypeScript, PR process, code style). Architecture and module layout deep-dives live in the project documentation at [docs.sencho.io](https://docs.sencho.io).

## Development

- **Backend:** Node.js + Express + TypeScript in `backend/`
- **Frontend:** React 19 + Vite + TypeScript in `frontend/`
- **Tests:** `cd backend && npm test` (Vitest) and `npm run test:e2e` (Playwright)
- **Lint:** `npm run lint` in both `backend/` and `frontend/`
- **Type check:** Run `cd backend && npx tsc --noEmit` (and the frontend equivalent) before every commit. The CI build will reject type errors.

## TypeScript Standards

The project uses `strict: true`. Write code that compiles without `any` casts or `@ts-ignore`. If a library lacks types, import `@types/...` or use `unknown` with narrowing.

## Contributing to Community

This public repository is the AGPLv3 **Community** product. Contributions here stay under AGPLv3 for the Community product. We will not take a Community contribution and move it behind a paid gate.

You will be required to sign our Contributor License Agreement (CLA) when you open your first Pull Request.

## Trademarks

Sencho and Studio Saelix names and logos are trademarks. AGPLv3 does not grant trademark rights. See [TRADEMARKS.md](TRADEMARKS.md).

## Pull Request Process

- All PRs target `main`
- Fill in the pull request template (summary, type of change, compatibility, testing performed).
- The CLA Assistant check must pass. First-time contributors are prompted to sign [CLA.md](CLA.md).
- Ensure CI passes before requesting review
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, and make the PR title one too. Squash-merging uses the title as the commit subject, so a title that is not a conventional commit drops the change from the release notes entirely.
- For a dependency PR that clears a security advisory, use `security(deps):` or `fix(deps):` rather than the default `chore(deps):`. `chore` and `security` are both valid types, but only the latter two reach the changelog, and `chore(deps)` on an advisory means operators never learn the release carries the fix.
- Update documentation if your change affects user-facing behavior
- Add tests for new functionality
- Keep PRs focused: one feature or fix per PR
- Do not include secrets, tokens, credentials, or real hostnames/IPs in the diff, commits, or PR description.
- Do not edit `CHANGELOG.md`, `.release-please-manifest.json`, or a package version directly. release-please owns all three. To correct or add context to an entry after the change is merged, add a `BEGIN_COMMIT_OVERRIDE` block to that PR's body and let the next release-please run regenerate the notes from it. An override is read like a commit, so it must not introduce a marker below either.
- Do not write `!` before the colon in a commit subject or the pull request title, a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer, or a `Release-As:` line unless the change is approved for a version transition.
- If your pull request depends on another one, say so in the body and merge it only after the dependency has merged.

## Versioning

Sencho is pre-1.0. While the version is `0.98.x`, a compatible change ships as the next patch, and a patch can carry a feature. That is a deliberate deviation from strict semver, stated plainly so nobody has to guess: `0.98.1` may add a screen, a setting, or an endpoint.

| Change | Version |
|---|---|
| `feat:`, `fix:`, `perf:`, `security:`, `revert:` | next patch (`0.98.N`) |
| `feat!:` or a `BREAKING CHANGE:` footer, approved by a maintainer | next minor (`0.99.0`) |
| `Release-As: 1.0.0`, approved by a maintainer | `1.0.0` |

A maintainer approves a version transition by applying the `version-transition-approved` label to the pull request. Without that label, the pull request fails the `Version transition is approved` check and cannot merge. After `1.0.0` these pre-1.0 rules stop applying on their own and ordinary semver resumes.

The operator-facing version of this policy is in the [upgrade guide](https://docs.sencho.io/operations/upgrade#version-policy).

Merging to `main` is the release decision: your change ships in the next patch. Keep unfinished work on its branch. If it has to land early, it must be off by default, with no migration and no change to any common path.

An open, draft, or failing pull request never blocks a release. A release stops only for a confirmed severe problem that is already on `main`, and the remedy is to fix or revert it, not to hold the release.

If `main` is unsafe and a production fix cannot wait for the next patch, cut a `release/0.98` branch from the latest tag at that moment, run release-please against that branch, and retire the branch once the fix is out. Nothing is automated for this path; it exists so the normal single-line flow does not have to be bent under pressure.

Do not put a version number or a milestone name in code, documentation, or UI text. The version lives in `.release-please-manifest.json`, `CHANGELOG.md`, and the release notes.

## Reporting Bugs

Use the [bug report template](https://github.com/studio-saelix/sencho/issues/new?template=bug_report.yml). Include: deployment method, Sencho version, browser (for UI issues), steps to reproduce, and expected vs actual behavior.

## Code Style

- TypeScript with `strict: true`: no `any` casts or `@ts-ignore`
- ESLint 9 flat config for both backend and frontend
- Tailwind CSS + shadcn/ui for frontend styling
- Follow existing patterns in the codebase
