import { JsonNumber } from "../lib/json.ts";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { AlertCircle, Check, Copy, LoaderCircle, X } from "lucide-react";
import { visibleText } from "../lib/format.ts";
export function ErrorState({
  error,
  onRetry,
  retryLabel = "Try again",
}: {
  error: unknown;
  /** Offer the next step when the failure may be transient. */
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return error ? (
    <div className="notice error" role="alert">
      <AlertCircle size={15} aria-hidden="true" />
      <span>
        {visibleText(error instanceof Error ? error.message : String(error))}
      </span>
      {onRetry && (
        <button type="button" className="notice-action" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  ) : null;
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="empty loading" role="status">
      <LoaderCircle className="spin" size={16} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
export function Empty({
  children,
  title,
  action,
  compact = false,
}: {
  children?: ReactNode;
  /** The cause, in one plain sentence. */
  title?: ReactNode;
  /** The next step, usually a button or link. */
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? "compact" : ""}`.trim()}>
      {title && <strong>{title}</strong>}
      {children}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
/** Environment name in its semantic colour (docs/DESIGN.md §2). */
export function EnvBadge({ environment }: { environment: string }) {
  return (
    <span className="badge env-badge" data-env={environment}>
      {environment === "prod" ? "Production" : environment}
    </span>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
/**
 * The view toolbar (docs/DESIGN.md §7: each view starts with its own toolbar, not a hero heading).
 * `description` is a short factual note (what the data is, how fresh it is), not a slogan.
 * `children` are inline controls such as the key browser's scan form.
 */
export function PageTitle({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div className="title-block">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="toolbar-controls">{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

/** Segmented tabs with roving focus (arrow keys, Home, End). */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (id: T) => void;
  testId?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const enabled = options.filter((option) => !option.disabled);
  const move = (offset: number | "first" | "last") => {
    const index = enabled.findIndex((option) => option.id === value);
    const next =
      offset === "first"
        ? enabled[0]
        : offset === "last"
          ? enabled.at(-1)
          : enabled[(index + offset + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.id);
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)
      ?.focus();
  };
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={label}
      ref={list}
      data-testid={testId}
      onKeyDown={(event) => {
        const keys: Record<string, number | "first" | "last"> = {
          ArrowRight: 1,
          ArrowLeft: -1,
          Home: "first",
          End: "last",
        };
        const offset = keys[event.key];
        if (offset === undefined) return;
        event.preventDefault();
        move(offset);
      }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          data-tab={option.id}
          aria-selected={option.id === value}
          tabIndex={option.id === value ? 0 : -1}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A tiny trend line for readouts. Decorative: the readout text carries the value.
 * The scale starts at zero (or `floor`) so small wobbles do not read as cliffs.
 */
export function Sparkline({
  values,
  floor = 0,
  ceiling,
}: {
  values: number[];
  floor?: number;
  ceiling?: number;
}) {
  if (values.length < 2)
    return <svg className="spark empty-spark" aria-hidden="true" />;
  const top = Math.max(ceiling ?? 0, ...values, floor + 1e-9);
  const span = top - floor || 1;
  const points = values
    .map(
      (value, index) =>
        `${((index / (values.length - 1)) * 100).toFixed(2)},${(21 - ((Math.max(floor, value) - floor) / span) * 19).toFixed(2)}`,
    )
    .join(" ");
  return (
    <svg
      className="spark"
      viewBox="0 0 100 22"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
}

/** One gauge in a readout strip: label, value with unit, a short qualifier and an optional trend. */
export function Readout({
  label,
  value,
  unit,
  sub,
  trend,
  trendMax,
  meter,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  trend?: number[];
  /** Upper bound of the trend scale (e.g. 1 for ratios); the scale always starts at 0. */
  trendMax?: number;
  /** 0..1 fill for capacity readouts (memory of maxmemory). */
  meter?: number;
  tone?: "warn" | "danger";
}) {
  return (
    <div className={`readout ${tone ?? ""}`.trim()}>
      <span className="readout-label">{label}</span>
      <span className="readout-value">
        {value}
        {unit && <span className="readout-unit">{unit}</span>}
      </span>
      {meter !== undefined && (
        <span className="readout-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, meter))})` }} />
        </span>
      )}
      {trend && <Sparkline values={trend} ceiling={trendMax} />}
      {sub && (
        <span
          className="readout-sub"
          title={typeof sub === "string" ? sub : undefined}
        >
          {sub}
        </span>
      )}
    </div>
  );
}
export function CopyButton({
  text,
  label = "Copy",
  iconOnly = false,
  className = "ghost",
}: {
  /** The clipboard text, or a function that builds it on click (for large values). */
  text: string | (() => string);
  label?: string;
  /** Show only the icon; the label stays the accessible name and tooltip. */
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className={`${className} ${iconOnly ? "icon-button" : ""}`.trim()}
        aria-label={label}
        title={iconOnly ? label : undefined}
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(typeof text === "function" ? text() : text))
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            })
            .catch(() =>
              setError("Clipboard unavailable. Select and copy the text."),
            );
        }}
      >
        {copied ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
        {!iconOnly && (copied ? "Copied" : label)}
      </button>
      {(error || (iconOnly && copied)) && (
        <small role="status" className="copy-status">
          {error || "Copied"}
        </small>
      )}
    </>
  );
}
export function Modal({
  title,
  children,
  onClose,
  testId,
  className = "",
  describedBy,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  testId?: string;
  className?: string;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Capture before descendant autoFocus runs during the commit phase.
  const trigger = useRef(document.activeElement);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const field = dialog?.querySelector<HTMLElement>("[data-autofocus], [autofocus]") ??
      dialog?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]):not([type="file"]), select:not([disabled]), textarea:not([disabled])');
    field?.focus();
    return () => {
      dialog?.close();
      if (trigger.current instanceof HTMLElement && trigger.current.isConnected) trigger.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      data-testid={testId}
      className={`modal ${className}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
/** Characters of one string shown in a JSON tree; longer strings end with a marker. */
export const TREE_STRING_LIMIT = 10_000;
export function JsonTree({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  if (depth > 8) return <code>… nested data capped</code>;
  if (value === null || typeof value !== "object" || value instanceof JsonNumber)
    return (
      <code className="data">
        {visibleText(
          typeof value === "string" ? value.slice(0, TREE_STRING_LIMIT) : String(value),
        )}
        {typeof value === "string" && value.length > TREE_STRING_LIMIT && (
          <small className="muted"> … {(value.length - TREE_STRING_LIMIT).toLocaleString()} more characters (display capped; Copy value copies all)</small>
        )}
      </code>
    );
  const entries = Object.entries(value);
  return (
    <details open={depth < 2} className="json-tree">
      <summary>
        {Array.isArray(value)
          ? `Array (${entries.length})`
          : `Object (${entries.length})`}
      </summary>
      <div>
        {entries.slice(0, 200).map(([key, child]) => (
          <div key={key} className="json-row">
            <span className="muted data">{visibleText(key)}</span>
            <JsonTree value={child} depth={depth + 1} />
          </div>
        ))}
        {entries.length > 200 && (
          <small>… {entries.length - 200} more entries</small>
        )}
      </div>
    </details>
  );
}
export function DataTable({
  columns,
  rows,
  empty = "No results to display.",
  className = "",
}: {
  columns: ReactNode[];
  rows: ReactNode[][];
  empty?: ReactNode;
  className?: string;
}) {
  return rows.length ? (
    <div className={`table-wrap ${className}`.trim()}>
      <table>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty compact>{empty}</Empty>
  );
}
export function ActionForm({
  children,
  onSubmit,
  label = "Run",
  disabled = false,
  testId,
  danger = false,
  resetKey,
}: {
  resetKey?: unknown;
  danger?: boolean;
  children: ReactNode;
  onSubmit: () => Promise<unknown>;
  label?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  const latestResetKey = useRef(resetKey);
  if (latestResetKey.current !== resetKey) {
    latestResetKey.current = resetKey;
    setDone(false);
    setError(undefined);
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || disabled) return;
    setBusy(true);
    setDone(false);
    setError(undefined);
    const submittedKey = resetKey;
    // A handler that throws while building its request (a validation error) rejects like an async one, so the error
    // is shown and the button re-enables (review v0.4 r1 M1).
    void new Promise<unknown>((resolve) => resolve(onSubmit()))
      .then(() => { if (latestResetKey.current === submittedKey) setDone(true); })
      // A quiet error was already shown by the form's own content (e.g. a conflict notice).
      .catch(error => { if (latestResetKey.current === submittedKey && !(error as { quiet?: boolean } | undefined)?.quiet) setError(error); })
      .finally(() => setBusy(false));
  };
  return (
    <form className="form" onSubmit={submit}>
      {children}
      <ErrorState error={error} />
      <div className="actions">
        <button
          className={danger ? "danger" : "primary"}
          type="submit"
          disabled={disabled || busy}
          data-testid={testId}
        >
          {busy && <LoaderCircle size={15} className="spin" />}
          {busy ? "Working…" : label}
        </button>
        {done && (
          <span className="success" role="status">
            <Check size={14} /> Done
          </span>
        )}
      </div>
    </form>
  );
}
