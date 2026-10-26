import { useState, type ReactNode } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { cliArg, visibleText } from "../../lib/format.ts";

/* Shared pieces of the Diagnostics tool panes (also used by the tools drawer). */
/** Pane header for a tool: title, a factual note, and the tool's actions. */
export function ToolHead({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="pane-head">
      <h2>{title}</h2>
      {meta && <span className="meta">{meta}</span>}
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

/** A button that runs an async action and reports failures to the pane (no form chrome). */
export function InlineAction({
  label,
  onRun,
  onError,
  danger = false,
  subtle = false,
  testId,
  disabled = false,
  title,
}: {
  label: string;
  onRun: () => Promise<unknown>;
  onError: (error: unknown) => void;
  danger?: boolean;
  /** Row actions: outlined instead of solid so a column of them stays quiet. */
  subtle?: boolean;
  testId?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={danger ? (subtle ? "row-danger" : "danger") : undefined}
      disabled={disabled || busy}
      data-testid={testId}
      title={title}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        onError(undefined);
        void onRun()
          .catch(onError)
          .finally(() => setBusy(false));
      }}
    >
      {busy && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
      {label}
    </button>
  );
}

export function RefreshButton({
  onClick,
  busy,
  label = "Refresh",
}: {
  onClick: () => void;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button type="button" className="ghost" onClick={onClick} disabled={busy}>
      <RefreshCw size={13} aria-hidden="true" className={busy ? "spin" : ""} />
      {label}
    </button>
  );
}

/** Seconds as a compact duration: 42s, 12m 5s, 3h 4m, 2d 6h. */
export function durationLabel(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
export const msLabel = (ms: number) =>
  ms >= 1000 ? durationLabel(Math.round(ms / 1000)) : `${ms} ms`;

/**
 * A command line as redis-cli would show it: the command emphasised, arguments quoted when needed.
 * Long lines (scripts, big payloads) are clamped to two lines with a toggle to show all of it.
 */
export function CommandLine({ argv }: { argv: string[] }) {
  const [open, setOpen] = useState(false);
  const [name = "", ...args] = argv;
  const text = args
    .map(cliArg)
    .join(" ");
  const long = text.length > 140;
  return (
    <span className="command-cell">
      <code className={`command-line ${long && !open ? "clamped" : ""}`}>
        <span className="cmd">{visibleText(name)}</span>
        {args.length > 0 && " "}
        {visibleText(text.slice(0, 5000))}
        {text.length > 5000 && <span className="muted"> …</span>}
      </code>
      {long && (
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : `Show all ${argv.length} arguments`}
        </button>
      )}
    </span>
  );
}

export const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour12: false,
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
