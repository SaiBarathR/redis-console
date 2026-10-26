import { useState, type ReactNode } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";

/**
 * Pane chrome shared by the Search and Memory analysis tools (extracted from Diagnostics.tsx). The other
 * Diagnostics tools keep their own copies so each tool can move independently.
 */

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

/** A horizontal share bar; `family` picks the Redis type hue (docs/DESIGN.md §2). */
export function ShareBar({
  share,
  label,
  family,
}: {
  share: number;
  label: string;
  family?: string;
}) {
  return (
    <div className="bar-cell">
      <span
        className={`share-bar ${family ? `t-${family}` : ""}`.trim()}
        aria-hidden="true"
      >
        <span
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, share))})` }}
        />
      </span>
      <span className="share">{label}</span>
    </div>
  );
}

export const percent = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : "—";
