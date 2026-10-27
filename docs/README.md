# Documentation

## Using Redis Console

| Document | What's in it |
|---|---|
| [USER-GUIDE.md](USER-GUIDE.md) | Signing in, Redis basics, the key browser, editing, guided mode, the console and workbench, diagnostics, production confirmations, roles, blocked commands, a redis-cli cheat sheet. |

## Running it

| Document | What's in it |
|---|---|
| [INSTALL.md](INSTALL.md) | Deploying on any server: Docker, Compose, Kubernetes, Node with systemd, TLS proxy, identity providers, Redis ACL users, secrets, minimal config, first sign-in, hardening checklist, troubleshooting, and what was verified. |
| [OPERATIONS.md](OPERATIONS.md) | Full configuration reference, TLS to Redis, secret rotation (including the TOTP key), backup and restore, upgrades, logs and SIEM, limits. |
| [SECURITY.md](SECURITY.md) | Threat model, every control and the test that checks it, known limitations, reporting a vulnerability. |
| [RELEASE-NOTES-v0.4.md](RELEASE-NOTES-v0.4.md) | What changed in v0.4 and the upgrade notes. |
| [RELEASE-NOTES-v0.3.md](RELEASE-NOTES-v0.3.md) | What changed in v0.3 and the upgrade notes. |
| [RELEASE-NOTES-v0.2.md](RELEASE-NOTES-v0.2.md) | What changed in v0.2 and the upgrade notes. |

## Working on it

| Document | What's in it |
|---|---|
| [../AGENTS.md](../AGENTS.md) | The working rules for coding agents (and humans): hard rules, data safety, parallel work, test gates, live QA, review and fix rounds, releases. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | The short version for human contributors. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it works: request lifecycle, policy engine, connections, measured transport, jobs, auth, audit, web app, data-flow guarantees. |
| [DECISIONS.md](DECISIONS.md) | Why it works that way: the intent and one entry per major decision, with alternatives and evidence. |
| [DESIGN.md](DESIGN.md) | The interface design: palette, type, layout, key anatomy and the TTL fuse, environment marking. |
| [../apps/server/README.md](../apps/server/README.md) | Running and testing the server; its security model in detail. |
| [../apps/web/IMPLEMENTATION.md](../apps/web/IMPLEMENTATION.md), [../apps/web/TESTIDS.md](../apps/web/TESTIDS.md) | Web implementation notes; the stable `data-testid` interface. |
| [../tests/e2e/README.md](../tests/e2e/README.md) | The end-to-end and API security suite: what it starts, projects, options. |
| [CONTRACT-CHANGES.md](CONTRACT-CHANGES.md) | Every change to `packages/shared`, newest first. |

## History

These are records. They describe the project at the time they were written and are not updated afterwards; some
mention machine-specific databases and paths.

| Record | What's in it |
|---|---|
| [research/](research/README.md) | Reports 01–04 (why we built rather than adopted) and every review and verification report (05–25). |
| [REVIEW-LOG.md](REVIEW-LOG.md) | Every review finding's verdict (fixed, skipped with reason), commit and regression test, round by round. |
| [qa/](qa/) | Live QA records: v0.2 UI and console, measured replies, v0.2.1 key browser and key details. |
| [E2E-FINDINGS.md](E2E-FINDINGS.md) | Bugs found by the end-to-end suite (all fixed). |
| [V0.2-PLAN.md](V0.2-PLAN.md) | The v0.2 plan: goals, workstreams, ownership, the review loop. |
| [RI-PARITY-AUDIT.md](RI-PARITY-AUDIT.md), [RI-PARITY-PLAN.md](RI-PARITY-PLAN.md) | The side-by-side audit against Redis Insight and the plan that closed the gaps. |
| [CONTRACT-REQUESTS-web.md](CONTRACT-REQUESTS-web.md) | The web stream's contract requests during v0.1. |
