/** v0.4 arrays: browser helpers shared by the array inspector and the create-key form. */
import { bytesFromBin, type Bin } from "@rconsole/shared";

/**
 * The lines of a textarea as array values: one per line (LF or CRLF); a single trailing line break is not a value.
 * Base64 lines are checked here so a typo fails before anything is sent.
 */
export function lineValues(text: string, enc: "utf8" | "base64"): Bin[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length > 1000) throw new Error("At most 1,000 values at once.");
  return lines.map((data, i) => {
    const value: Bin = { enc, data };
    if (enc === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(`Line ${i + 1} is not valid base64.`);
    bytesFromBin(value);
    return value;
  });
}
