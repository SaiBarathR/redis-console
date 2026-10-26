import { Suspense, lazy, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useLocation } from "react-router";
import { BookOpenText, ChevronDown, ChevronUp, Columns2, Radio, ScanSearch, Terminal } from "lucide-react";
import { useDatabase } from "../../lib/context.tsx";
import { useMemorySlot } from "../../lib/memory.tsx";
import { useLive, useLiveSessions } from "../../lib/live.tsx";
import { DRAWER_MAX_SHARE, DRAWER_MIN, setPreferences, usePreferences, type Preferences } from "../../lib/preferences.ts";
import { hint } from "../../lib/keyboard/registry.ts";
import { useShortcuts } from "../../lib/keyboard/useShortcuts.ts";
import { Loading } from "../ui.tsx";
import "./drawer.css";

const DockedConsole = lazy(() =>
  import("../../pages/Console.tsx").then((module) => ({
    default: () => <module.Console docked />,
  })),
);
const CommandHelper = lazy(() =>
  import("./CommandHelper.tsx").then((module) => ({ default: module.CommandHelper })),
);
const Profiler = lazy(() =>
  import("../diagnostics/Profiler.tsx").then((module) => ({
    default: () => <module.Profiler compact />,
  })),
);

type Tab = Preferences["drawerTab"];

/** The tabs this user has on this database: the Profiler only where the server allows it (admin, non-prod). */
export function drawerTabs(features: { profiler: boolean }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "console", label: "Console" },
    { id: "helper", label: "Command helper" },
  ];
  if (features.profiler) tabs.push({ id: "profiler", label: "Profiler" });
  return tabs;
}

/** Height within [DRAWER_MIN, DRAWER_MAX_SHARE of the window]. */
export function clampDrawerHeight(height: number, viewport = window.innerHeight) {
  return Math.round(Math.max(DRAWER_MIN, Math.min(height, Math.max(DRAWER_MIN, viewport * DRAWER_MAX_SHARE))));
}

const ICONS = { console: Terminal, helper: BookOpenText, profiler: ScanSearch } as const;

/**
 * Which tools are visible. Tabbed (the default): the selected one. Side by side (review v0.2.1 web L5): the Console
 * on the left and the selected Command helper or Profiler on the right (the helper when the Console tab is the one
 * chosen); on the Console page, whose own Console is already visible, only the second tool.
 */
export function drawerPanes(tab: Tab, split: boolean, onConsolePage: boolean): Tab[] {
  if (!split) return [tab];
  const side: Tab = tab === "console" ? "helper" : tab;
  return onConsolePage ? [side] : ["console", side];
}

/**
 * Persistent bottom tools drawer on every database page (F27): the Console (the same component and session memory as
 * the Console page), the Command helper and, where allowed, the Profiler. It is mounted by the database layout, so it
 * is bound to that database: switching database gives a fresh drawer for the new one. Open state, tab and height are
 * presentation preferences; nothing in it is stored on the device.
 */
export function ToolsDrawer() {
  const db = useDatabase();
  const prefs = usePreferences();
  const location = useLocation();
  const { pubsub, profiler } = useLiveSessions();
  const pubsubState = useLive(pubsub);
  const profilerState = useLive(profiler);
  const [, setDraft] = useMemorySlot(`${db.id}:console:draft`, "");
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef(false);
  const tabs = drawerTabs(db.features);
  const tab = tabs.some((item) => item.id === prefs.drawerTab) ? prefs.drawerTab : "console";
  const open = prefs.drawerOpen;
  const split = prefs.drawerSplit;
  const height = clampDrawerHeight(prefs.drawerHeight);
  const onConsolePage = /\/console\/?$/.test(location.pathname);
  const base = `/db/${encodeURIComponent(db.id)}`;
  const panes = drawerPanes(tab, split, onConsolePage);

  const show = (next: Tab, focus = true) => {
    focusOnOpen.current = focus;
    setPreferences({ drawerOpen: true, drawerTab: next });
  };
  /** Side by side, the Console tab does not hide the second tool: it moves focus to the Console's editor. */
  const focusConsole = () => panel.current?.querySelector<HTMLElement>(".drawer-pane-console .cm-content")?.focus();
  const close = () => {
    if (panel.current?.contains(document.activeElement)) toggle.current?.focus();
    setPreferences({ drawerOpen: false });
  };
  useShortcuts("drawer", {
    drawer: () => {
      if (open) close();
      else show(tab);
    },
  });
  // Opened by the shortcut, the palette or a tab: put focus in the panel (the Console focuses its own editor).
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const timer = setTimeout(() => {
      const node = panel.current;
      if (!node || node.contains(document.activeElement)) return;
      node.querySelector<HTMLElement>('.cm-content, input[type="search"], input, button')?.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [open, tab]);

  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { startY: event.clientY, startHeight: height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPreferences({ drawerHeight: clampDrawerHeight(drag.current.startHeight + drag.current.startY - event.clientY) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 24;
    const next =
      event.key === "ArrowUp"
        ? height + step
        : event.key === "ArrowDown"
          ? height - step
          : event.key === "Home"
            ? DRAWER_MIN
            : event.key === "End"
              ? window.innerHeight
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setPreferences({ drawerHeight: clampDrawerHeight(next) });
  };

  const tool = (id: Tab) =>
    id === "console" ? (
      onConsolePage ? (
        <p className="drawer-note">
          The Console is open on this page. The drawer and the page share the same history and results.
        </p>
      ) : (
        <DockedConsole />
      )
    ) : id === "helper" ? (
      <CommandHelper
        onInsert={(command) => {
          setDraft(command);
          if (onConsolePage) close();
          else if (panes.includes("console")) setTimeout(focusConsole, 0);
          else show("console");
        }}
      />
    ) : (
      <Profiler />
    );

  return (
    <section
      className={`tools-drawer ${open ? "is-open" : ""}`.trim()}
      aria-label="Tools drawer"
      data-testid="tools-drawer"
      data-open={open ? "true" : "false"}
      style={open ? { height } : undefined}
    >
      {open && (
        <div
          className="drawer-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the tools drawer"
          aria-valuemin={DRAWER_MIN}
          aria-valuemax={Math.round(window.innerHeight * DRAWER_MAX_SHARE)}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onSeparatorKey}
          data-testid="drawer-resizer"
        />
      )}
      <div className="drawer-bar">
        <div role="tablist" aria-label="Tools" className="drawer-tabs">
          {tabs.map(({ id, label }) => {
            const Icon = ICONS[id];
            const selected = open && panes.includes(id);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`drawer-tab-${id}`}
                aria-selected={selected}
                aria-controls={selected ? (panes.length > 1 ? `drawer-pane-${id}` : "drawer-panel") : undefined}
                className="drawer-tab"
                onClick={() => (split && open && id === "console" && selected ? focusConsole() : selected ? close() : show(id))}
                data-testid={`drawer-tab-${id}`}
                title={split && open && id === "console" && selected ? "Focus the Console" : selected ? `Close the ${label}` : `Open the ${label}`}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
                {id === "profiler" && profiler.active && (
                  <span className="drawer-live" title="Profiler recording">
                    <span className="dot" aria-hidden="true" />
                    <span className="sr-only">recording</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span className="drawer-context" title="The drawer runs against this database with your role here">
          <span className="db-index">db {db.db ?? 0}</span>
          {db.effectiveRole}
          {db.readOnly ? " · read-only" : ""}
          {db.environment === "prod" ? " · production" : ""}
        </span>
        {pubsub.active && (
          <Link className="drawer-session" to={`${base}/diagnostics/pubsub`} data-testid="drawer-pubsub-live">
            <Radio size={13} aria-hidden="true" />
            Pub/Sub listening · {pubsubState.received} {pubsubState.received === 1 ? "message" : "messages"}
          </Link>
        )}
        {!open && profiler.active && profilerState.status === "live" && (
          <span className="drawer-session">Profiler recording</span>
        )}
        <span className="spacer" />
        {open && (
          <button
            type="button"
            className="ghost drawer-toggle"
            aria-pressed={split}
            onClick={() => setPreferences({ drawerSplit: !split })}
            title={split ? "Show one tool at a time" : "Show the Console beside the Command helper or Profiler"}
            data-testid="drawer-split"
          >
            <Columns2 size={14} aria-hidden="true" />
            Side by side
          </button>
        )}
        <button
          ref={toggle}
          type="button"
          className="ghost drawer-toggle"
          aria-expanded={open}
          aria-controls="drawer-panel"
          onClick={() => (open ? close() : show(tab))}
          data-testid="drawer-toggle"
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          {open ? "Hide" : "Tools"}
          <kbd>{hint("drawer")}</kbd>
        </button>
      </div>
      {open &&
        (panes.length === 1 ? (
          <div
            ref={panel}
            className={`drawer-panel panel-${panes[0]}`}
            id="drawer-panel"
            role="tabpanel"
            aria-labelledby={`drawer-tab-${panes[0]}`}
            data-testid="drawer-panel"
          >
            <Suspense fallback={<Loading label="Opening tool…" />}>{tool(panes[0]!)}</Suspense>
          </div>
        ) : (
          <div ref={panel} className="drawer-panel is-split" id="drawer-panel" data-testid="drawer-panel">
            {panes.map((id) => (
              <div
                key={id}
                className={`drawer-pane drawer-pane-${id} panel-${id}`}
                id={`drawer-pane-${id}`}
                role="tabpanel"
                aria-labelledby={`drawer-tab-${id}`}
                data-testid={`drawer-pane-${id}`}
              >
                <Suspense fallback={<Loading label="Opening tool…" />}>{tool(id)}</Suspense>
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
