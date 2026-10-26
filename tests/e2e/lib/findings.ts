/**
 * Confirmed, documented bugs (docs/E2E-FINDINGS.md). A test that hits one is marked
 * `test.fail()` so the suite stays green while the bug is open, and turns red ("expected to fail,
 * but passed") as soon as it is fixed, which is the signal to remove the marker.
 */
import { test } from '@playwright/test';

/** Open findings. Fixed ones are removed here (see the history in docs/E2E-FINDINGS.md). */
export const FINDINGS = {
  'F-05': 'TOTP seeds are stored unencrypted in the SQLite data directory',
  'F-06': 'User editor: username pattern attribute is an invalid regular expression under the v flag (console error when the field is validated; client-side validation disabled)',
  'F-07': 'Diagnostics offers the Profiler on prod-tagged databases although the server always refuses it there',
} as const;
export type FindingId = keyof typeof FINDINGS;

export function knownBug(id: FindingId, when = true): void {
  if (!when) return;
  test.info().annotations.push({ type: 'finding', description: `${id}: ${FINDINGS[id]}` });
  test.fail(true, `${id}: ${FINDINGS[id]}`);
}
