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
    middleware/   # Auth, tier gates, audit log, node context
    websocket/    # Upgrade handlers for log streaming, host console, proxy tunnels
frontend/
  src/
    components/   # Page-level and shared UI components
    context/      # Auth, node selection, and other React contexts
    hooks/        # Shared React hooks
    lib/          # apiFetch wrapper and other utilities
```

See the rest of this file for the most important contributor-facing standards (TypeScript, tier gates, PR process, code style). Architecture and module layout deep-dives live in the project documentation at [docs.sencho.io](https://docs.sencho.io).

## Development

- **Backend:** Node.js + Express + TypeScript in `backend/`
- **Frontend:** React 19 + Vite + TypeScript in `frontend/`
- **Tests:** `cd backend && npm test` (Vitest) and `npm run test:e2e` (Playwright)
- **Lint:** `npm run lint` in both `backend/` and `frontend/`
- **Type check:** Run `cd backend && npx tsc --noEmit` (and the frontend equivalent) before every commit. The CI build will reject type errors.

## TypeScript Standards

The project uses `strict: true`. Write code that compiles without `any` casts or `@ts-ignore`. If a library lacks types, import `@types/...` or use `unknown` with narrowing.

## Tier-Gated Features

Sencho has two tiers: Community and Admiral. We welcome contributions to both! Often, enterprise users will contribute features they need for their own infrastructure.

If your change adds a feature that belongs behind a tier gate, use the guards from `backend/src/middleware/tierGates.ts`:

```typescript
if (!requirePaid(req, res)) return;    // Admiral (paid) only
```

Call the guard at the top of the route handler with an early return. Both guards handle proxy-forwarded tier headers automatically.

**Note on Tiers and Monetization:** 
- **Community Tier:** If you contribute a feature to the free/Community tier, it stays in the Community tier. We will never take your community contribution and move it behind a paywall.
- **Commercial Tier:** By contributing to an Admiral feature, you acknowledge that your code will be part of Sencho's commercial offering. 

Before writing code for a new gated feature, please open an issue to discuss it with the maintainers. You will also be required to sign our Contributor License Agreement (CLA) when you open your first Pull Request.

## Pull Request Process

- All PRs target `main`
- Ensure CI passes before requesting review
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Update documentation if your change affects user-facing behavior
- Add tests for new functionality
- Keep PRs focused: one feature or fix per PR
- Do not edit `CHANGELOG.md` directly. It is generated from conventional-commit subjects by release-please. If a user-facing change needs more context, enrich the auto-opened Release PR description before merging.

## Reporting Bugs

Use the [bug report template](https://github.com/studio-saelix/sencho/issues/new?template=bug_report.yml). Include: deployment method, Sencho version, browser (for UI issues), steps to reproduce, and expected vs actual behavior.

## Code Style

- TypeScript with `strict: true`: no `any` casts or `@ts-ignore`
- ESLint 9 flat config for both backend and frontend
- Tailwind CSS + shadcn/ui for frontend styling
- Follow existing patterns in the codebase
