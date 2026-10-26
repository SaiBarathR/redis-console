# Research and review record

The evidence behind the project's decisions, in the order it was produced. Each review was written by a different model
from the one that wrote the code; every finding's verdict (fixed / skipped with reason) is in `../REVIEW-LOG.md`.
Evidence files the reports mention (screenshots, logs, JSON) stayed with the reviewers and are not published.
Hashes refer to the private development history, and dataset and machine names were redacted before publication
([../GENERALIZATION-NOTES.md](../GENERALIZATION-NOTES.md#publication)).

| # | Report | What it decided or found |
|---|---|---|
| 01 | `01-oss-alternatives-audit.md` | Code-level audit of open-source Redis GUIs: none safe to adopt as-is (browser-chosen hosts, no SSO/RBAC, bypassable command blocklists). |
| 02 | `02-secure-architecture.md` | Feature inventory of Redis Insight, threat model and the secure architecture this project follows. |
| 03a–d | `03a-web-guis.md` … `03d-adaptable-and-ideas.md` | Wider sweep: web GUIs, multi-DB platforms, access gateways, ideas worth borrowing. |
| 04 | `04-shortlist.md` | Consolidated shortlist and the build-our-own recommendation. |
| 05–06 | `05-web-review.md`, `06-server-review.md` | v0.1 reviews (frontend, backend). |
| 07–21 | `07-v02-…` … `21-v02-web-verify.md` | v0.2 review rounds: server rounds 1–5 and final, web/console rounds 1–3 and final, and fix verifications. |
| 22 | `22-ri-parity-audit.md` | Side-by-side audit against Redis Insight: 27 gaps, "keep ours" list, intentional differences. |
| 23–25 | `23-v021-server-review.md` … `25-v021-web-verify.md` | Reviews of the Redis Insight parity work and their fix verification. |
| 26 | `26-v03-totp-review.md` | v0.3 review of the TOTP key ring, recovery codes and host admin CLI (M1 server lock, L2 replay counter; both fixed, see REVIEW-LOG). |

Screenshots and reproduction scripts referenced by the reports were kept outside the repository (they contain real
development data). Report 01 refers to cloned third-party repositories that are not included.
