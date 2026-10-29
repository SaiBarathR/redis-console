import { visibleText } from "../lib/format.ts";

/**
 * An identifier (audit action, database id, key prefix) that wraps after its separators before anything else:
 * `auth.totp.confirm` breaks as `auth.totp.` / `confirm` and `app:cache:` as `app:` / `cache:`, never leaving a
 * lone `:` or splitting a word. A single segment wider than its box still breaks (overflow-wrap) rather than spill.
 */
export function Ident({ text, className = "" }: { text: string; className?: string }) {
  const parts = visibleText(text).match(/[^.\-_:/]+[.\-_:/]*|[.\-_:/]+/g) ?? [];
  return (
    <code className={`ident ${className}`.trim()}>
      {parts.map((part, i) => (
        <span key={i}>{i > 0 && <wbr />}<span className="ident-part">{part}</span></span>
      ))}
    </code>
  );
}
