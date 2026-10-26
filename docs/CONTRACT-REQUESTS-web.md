# Web contract integration

## Integrated and verified

- Response envelopes and `Me.mustEnrollTotp`; password/TOTP CSRF-token rotation.
- `zKeyQuery`, newest-first stream cursors, list/zset offsets, `full=true`, and collection truncation flags.
- Generic HTTP 428 confirmation for all JSON writes, including typed text, reason, impact samples, cancellation and a single retry.
- Typed Redis errors inside successful HTTP responses are errors in guided actions and creation forms; console/workbench render them as typed results.
- Login and pending-TOTP routes are deliberately pre-auth CSRF-token exemptions in the server; the browser still sends the header and same-origin credentials on all non-GETs. All authenticated mutations use `/auth/me`'s current token.
- Development config explicitly allows localhost/127.0.0.1 port 5173 so Vite can proxy `/api` to the required public origin on 4300.

## No blocking contract requests

The current shared package supports the implemented frontend. Extra module creation (TimeSeries, Bloom, Cuckoo, vector sets) uses the contracted binary-safe `/cli` endpoint rather than introducing unreviewed typed operations.

## Advisory: app policy versus Redis ACL capability

`CommandDoc.allowed` reports the app policy, while configured Redis ACLs can still refuse a command. In the supplied sandbox, `VADD` is denied for `rc-operator` despite a write policy classification; the admin tier succeeds. Search index listing likewise needs additional viewer/operator ACL grants, as documented in `CONTRACT-CHANGES.md`. The UI displays the refusal and retains the form, and does not bypass ACLs. A future optional capability hint could make these denials visible before execution. No shared types or sandbox ACLs were changed by the web agent.


## Round 2 integration status

The breaking body-only reads from `feat/server` are integrated: key/scan/stream/TimeSeries/channel reads are POST bodies and Pub/Sub consumes a new opaque single-use subscription ID per attempt. The old query-string reads are not used. The newly required `ConfirmationChallenge.preview` type is merged, but its UI rendering remains deferred per the round 2 user brief; the dialog currently renders summary, impact and frontend target context.

Future backend additions: profiler/ACL capabilities, configured logical database index metadata/switching, per-node topology data, durable snippets, and role-enforced audited file export. These are not implemented via client-only gates or raw connection controls.
