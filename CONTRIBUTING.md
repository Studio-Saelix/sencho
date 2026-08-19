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
- Fill in the pull request template (summary, type of change, testing performed).
- The CLA Assistant check must pass. First-time contributors are prompted to sign [CLA.md](CLA.md).
- Ensure CI passes before requesting review
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Update documentation if your change affects user-facing behavior
- Add tests for new functionality
- Keep PRs focused: one feature or fix per PR
- Do not include secrets, tokens, credentials, or real hostnames/IPs in the diff, commits, or PR description.
- Do not edit `CHANGELOG.md` directly. It is generated from conventional-commit subjects by release-please. If a user-facing change needs more context, enrich the auto-opened Release PR description before merging.

## Reporting Bugs

Use the [bug report template](https://github.com/studio-saelix/sencho/issues/new?template=bug_report.yml). Include: deployment method, Sencho version, browser (for UI issues), steps to reproduce, and expected vs actual behavior.

## Code Style

- TypeScript with `strict: true`: no `any` casts or `@ts-ignore`
- ESLint 9 flat config for both backend and frontend
- Tailwind CSS + shadcn/ui for frontend styling
- Follow existing patterns in the codebase
