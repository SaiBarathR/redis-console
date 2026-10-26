import type { PreviewArg, PreviewCommand } from "@rconsole/shared";
import { displayBin } from "./format.ts";

/** Longest single argument rendered in a preview (keys are server-capped at 1 KiB; this is a hard guard). */
const ARG_DISPLAY_LIMIT = 4096;

/**
 * Text for one previewed argument, redis-cli style: arguments that are empty or contain whitespace or quotes are
 * double-quoted so argument boundaries stay unambiguous. Binary bytes appear as `\xHH`, invisible and
 * bidirectional controls as `\uXXXX`. A server-cut prefix (`bytes` set) is shown as `<prefix>… (<n> bytes)`.
 */
export function previewArgText(arg: PreviewArg): string {
  const text = displayBin(arg.v, ARG_DISPLAY_LIMIT);
  const quoted =
    text === "" || /[\s"']/.test(text)
      ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`
      : text;
  return arg.bytes !== undefined
    ? `${quoted}… (${arg.bytes.toLocaleString()} bytes)`
    : quoted;
}

/** One previewed command as a single copyable line. */
export function previewCommandText(command: PreviewCommand): string {
  const parts = command.argv.map(previewArgText);
  if (command.moreArgs) parts.push(`… +${command.moreArgs.toLocaleString()} more arguments`);
  return parts.join(" ");
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;
