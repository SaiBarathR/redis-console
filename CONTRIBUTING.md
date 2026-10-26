# Contributing

Thanks for helping. Redis Console is a security tool first: a change that makes it nicer but weaker will not be
merged. Coding agents and humans follow the same rules, written down in [AGENTS.md](AGENTS.md). Read it before your
first change; the parts that matter most for humans are summarised here.

## Before you start

- Read the hard rules (AGENTS.md § 2), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and, for anything that changes
  behaviour, the relevant entry in [docs/DECISIONS.md](docs/DECISIONS.md). If you want to revisit a decision, open
  an issue first and say what new evidence you have.
- Security problems: don't open a public issue; follow [docs/SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability).

## Set up

Node ≥ 24.11, pnpm 11 (`corepack enable`), Docker. The README's [local quick start](README.md#try-it-locally-about-five-minutes)
gives you the sandbox (Redis 8 with per-role ACL users, Keycloak) and a running server. For hot reload, `pnpm dev` at
the root runs the server and the Vite dev server together (http://localhost:5173). Write only to sandbox databases.

## Make the change

- Work on a branch. Keep commits small and focused, prefixed with the area (`feat(web):`, `fix(server):`,
  `test(e2e):`, `docs:`).
- Changes to `packages/shared` (the API contract and the command rules) are logged in
  [docs/CONTRACT-CHANGES.md](docs/CONTRACT-CHANGES.md) and update both apps in the same change.
- A new route needs a row in the e2e role matrix; changed `data-testid`s update `apps/web/TESTIDS.md`.
- A new dependency needs a reason in the pull request. Exact versions only; no install scripts.
- Bug fixes come with a regression test that fails before the fix.
- Update the user guide, operations and architecture docs when behaviour changes.

## Check it

```bash
pnpm -r typecheck
pnpm test
pnpm test:e2e
```

For server changes touching Redis topology, also run the cluster, Sentinel and TLS suite (AGENTS.md § 7). For
anything a user can see, try it in a browser as viewer, operator and admin (AGENTS.md § 8) and say what you checked
in the pull request.

## Pull requests

Describe what changed and why, how you tested it (commands and counts, roles and databases you tried), and anything
left open. Reviews are done by someone (or some model) other than the author; findings are reproduced, fixed with a
test or answered with a reason, and recorded in [docs/REVIEW-LOG.md](docs/REVIEW-LOG.md) for review rounds.

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
