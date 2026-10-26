/**
 * Compare-and-set expectations (web review v0.2 r3): every edit that replaces existing data tells the server what
 * the editor opened (the Redis type plus the SHA-256 of the exact bytes), and the server writes only if Redis still
 * holds exactly that. See `EditExpect` in the shared contract.
 */
import { bytesFromBin, sha256Hex, type Bin, type EditConflict, type EditExpect, type KeyDetails } from "@rconsole/shared";

export const digestBin = (bin: Bin) => sha256Hex(bytesFromBin(bin));
/** JSON documents are compared as the UTF-8 text `JSON.GET key` returned (`KeyValue.json`). */
export const digestText = (text: string) => sha256Hex(new TextEncoder().encode(text));

export const sameBin = (a: Bin, b: Bin) => a.enc === b.enc && a.data === b.data;

/** Key-level expectation (rename, delete): the type, plus the bytes of a fully read string or JSON document. */
export function keyExpect(details: KeyDetails): EditExpect {
  const value = details.value;
  if (value.type === "string" && !value.truncated) return { type: details.type, sha256: digestBin(value.value) };
  if (value.type === "json" && !value.truncated) return { type: details.type, sha256: digestText(value.json) };
  return { type: details.type };
}

/**
 * What a refresh revealed about the key an editor opened (`base`), as a conflict the editor must resolve before it
 * can save: another type, or other bytes of the string or document it edits. Collections only compare the type here;
 * the element an editor changes is compared by the server.
 */
export function observedConflict(base: KeyDetails, current: KeyDetails): EditConflict | undefined {
  if (current.type !== base.type || current.value.type !== base.value.type)
    return { reason: "type", expected: { type: base.type }, current: { type: current.type } };
  const b = base.value, c = current.value;
  if (b.type === "string" && c.type === "string") {
    if (sameBin(b.value, c.value) && b.truncated === c.truncated) return undefined;
    return {
      reason: "value",
      expected: { type: base.type, sha256: digestBin(b.value) },
      current: {
        type: current.type,
        value: c.value,
        ...(c.truncated ? { truncated: true, totalBytes: c.totalBytes } : { expect: { type: current.type, sha256: digestBin(c.value) } }),
      },
    };
  }
  if (b.type === "json" && c.type === "json") {
    if (b.json === c.json && b.truncated === c.truncated) return undefined;
    return {
      reason: "value",
      expected: { type: base.type, sha256: digestText(b.json) },
      current: {
        type: current.type,
        value: { enc: "utf8", data: c.json },
        ...(c.truncated ? { truncated: true } : { expect: { type: current.type, sha256: digestText(c.json) } }),
      },
    };
  }
  return undefined;
}
