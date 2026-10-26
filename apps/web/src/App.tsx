import { keyboard, hint, type ShortcutId } from "./lib/keyboard/registry.ts";
import { useShortcuts } from "./lib/keyboard/useShortcuts.ts";
import { ShortcutHelp } from "./lib/keyboard/ShortcutHelp.tsx";
import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ChevronsUpDown,
  Command,
  FileCode2,
  FileKey2,
  HelpCircle,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Sun,
  Terminal,
  Users,
} from "lucide-react";
import type { DatabaseSummary, LogoutResponse, Me } from "@rconsole/shared";
import {
  collection,
  post,
  request,
  RequestError,
  setCsrfToken,
} from "./lib/api.ts";
import { DatabaseContext, SessionContext, useSession } from "./lib/context.tsx";
import { MemoryProvider } from "./lib/memory.tsx";
import { ConfirmationProvider } from "./components/Confirmation.tsx";
import {
  Badge,
  Empty,
  EnvBadge,
  ErrorState,
  Loading,
  Modal,
} from "./components/ui.tsx";
import { Account, Login } from "./pages/Auth.tsx";
import { Landing } from "./pages/Landing.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { ToolsDrawer } from "./components/drawer/ToolsDrawer.tsx";
import { LiveProvider } from "./lib/live.tsx";
import { setPreferences, usePreferences } from "./lib/preferences.ts";
import { initialTheme } from "./lib/theme.ts";
import { insightPaletteEntries } from "./lib/insightPalette.ts";
const Audit = lazy(() =>
  import("./pages/Admin.tsx").then((module) => ({ default: module.Audit })),
);
const LocalUsers = lazy(() =>
  import("./pages/Admin.tsx").then((module) => ({ default: module.Users })),
);
const Console = lazy(() =>
  import("./pages/Console.tsx").then((module) => ({ default: module.Console })),
);
const Dashboard = lazy(() =>
  import("./pages/Dashboard.tsx").then((module) => ({
    default: module.Dashboard,
  })),
);
const Diagnostics = lazy(() =>
  import("./pages/Diagnostics.tsx").then((module) => ({
    default: module.Diagnostics,
  })),
);
const Preferences = lazy(() =>
  import("./pages/Preferences.tsx").then((module) => ({
    default: module.Preferences,
  })),
);
const Guided = lazy(() =>
  import("./pages/Guided.tsx").then((module) => ({ default: module.Guided })),
);
const Keys = lazy(() =>
  import("./pages/Keys.tsx").then((module) => ({ default: module.Keys })),
);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10000 },
    mutations: { retry: false },
  },
});
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  override state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Redis data and credentials must never be logged. */
  }
  override render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>The workspace could not be displayed.</h1>
        <p>Reload the page to restart your session view.</p>
        <button onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function Session() {
  const client = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const payload = await request<Me | { me: Me }>("/auth/me");
      const me = "me" in payload ? payload.me : payload;
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: Infinity,
  });
  const [expired, setExpired] = useState(false);
  const ending = useRef(false);
  const [endedReason, setEndedReason] = useState<string>();
  useEffect(() => {
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "string")
        void client.invalidateQueries({
          predicate: (item) =>
            item.queryKey[1] === event.detail &&
            item.queryKey[0] !== "commands",
        });
    };
    window.addEventListener("rconsole:database-updated", changed);
    return () =>
      window.removeEventListener("rconsole:database-updated", changed);
  }, [client]);
  useEffect(() => {
    const expire = (event: Event) => {
      // Several polls/streams can return 401 together. Do not clear the new sign-in queries again.
      if (ending.current) return;
      ending.current = true;
      setCsrfToken("");
      client.clear();
      // Keep the first reason: requests already in flight fail afterwards with a generic "Not signed in".
      setEndedReason(
        (previous) =>
          previous ??
          (event instanceof CustomEvent && typeof event.detail === "string"
            ? event.detail
            : "Your session ended."),
      );
      setExpired(true);
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, [client]);
  const refresh = async () => {
    const result = await meQuery.refetch();
    if (result.error) throw result.error;
    if (result.data) setCsrfToken(result.data.csrfToken);
    ending.current = false;
    setExpired(false);
    setEndedReason(undefined);
  };
  const logout = async () => {
    let redirect: string | undefined;
    try {
      const response = await post<LogoutResponse>("/auth/logout");
      if (response.redirectUrl) {
        // This URL comes only from the authentication server's configured IdP,
        // never from Redis. Reject executable schemes and embedded credentials.
        const target = new URL(response.redirectUrl, window.location.origin);
        if (
          (target.protocol === "https:" ||
            (target.protocol === "http:" && location.protocol === "http:")) &&
          !target.username &&
          !target.password
        )
          redirect = target.href;
      }
    } finally {
      ending.current = true;
      setCsrfToken("");
      client.clear();
      setEndedReason(undefined);
      setExpired(true);
    }
    if (redirect) window.location.assign(redirect);
  };
  if (meQuery.isPending && !expired)
    return (
      <main className="fatal">
        <Loading label="Opening your secure workspace…" />
      </main>
    );
  const me = meQuery.data;
  if (!me || expired || meQuery.error)
    return (
      <>
        {meQuery.error &&
          !(
            meQuery.error instanceof RequestError &&
            meQuery.error.status === 401
          ) && <ErrorState error={meQuery.error} />}
        <Login
          notice={endedReason}
          onLogin={async (fresh) => {
            if (fresh) {
              ending.current = false;
              setCsrfToken(fresh.csrfToken);
              client.setQueryData(["me"], fresh);
              setExpired(false);
              setEndedReason(undefined);
            } else await refresh();
          }}
        />
      </>
    );
  return (
    <SessionContext value={{ me, refresh, logout }}>
      <MemoryProvider>
        <ConfirmationProvider>
          {me.mustChangePassword || me.mustEnrollTotp ? (
            <Account forced />
          ) : (
            <Shell />
          )}
        </ConfirmationProvider>
      </MemoryProvider>
    </SessionContext>
  );
}
const NAV = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "keys", label: "Key browser", Icon: FileKey2 },
  { id: "console", label: "Console", Icon: Terminal },
  { id: "workbench", label: "Workbench", Icon: FileCode2 },
  { id: "guided", label: "Guided mode", Icon: BookOpen },
  { id: "diagnostics", label: "Diagnostics", Icon: Activity },
];
function SessionExpiryWarning() {
  const { me, refresh } = useSession();
  const refreshedAt = useRef(Date.now());
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    const activity = (event: Event) => {
      if (!event.isTrusted || Date.now() - refreshedAt.current < 60000) return;
      refreshedAt.current = Date.now();
      void latestRefresh.current().catch(() => {});
    };
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    return () => {
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
    };
  }, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Date.parse(me.sessionExpiresAt) - now;
  return remaining > 0 && remaining <= 300000 ? (
    <div className="notice warning" role="status">
      Session expires in {Math.ceil(remaining / 60000)} minutes. Finish your
      edits before signing in again.
    </div>
  ) : null;
}
function Shell() {
  const { me, logout } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const databases = useQuery({
    queryKey: ["databases"],
    queryFn: async () =>
      collection<DatabaseSummary>(await request("/databases", { background: true }), "databases"),
    refetchInterval: 30000,
  });
  const [theme, setTheme] = useState<string>(initialTheme);
  const [palette, setPalette] = useState(false);
  const paletteInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (palette) paletteInput.current?.focus(); }, [palette]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [shortcuts, setShortcuts] = useState(false);
  // Rail width is a per-tab preference held in memory only (storage keeps theme and database id).
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 1600);
  const [logoutError, setLogoutError] = useState<unknown>();
  const currentId = location.pathname.startsWith("/db/")
    ? location.pathname.split("/")[2]
    : undefined;
  const routed = databases.data?.find(
    (db) => encodeURIComponent(db.id) === currentId,
  );
  const [lastDatabaseId, setLastDatabaseId] = useState<string>(() => {
    try {
      return localStorage.getItem("rconsole.database") ?? "";
    } catch {
      return "";
    }
  });
  const selected =
    routed ??
    (location.pathname.startsWith("/admin/") ||
    location.pathname.startsWith("/account") ||
    location.pathname.startsWith("/preferences")
      ? databases.data?.find((db) => db.id === lastDatabaseId)
      : undefined);
  useEffect(() => {
    const view = NAV.find(item => location.pathname.endsWith(`/${item.id}`))?.label ??
      (location.pathname.startsWith("/admin/") ? "Admin" : location.pathname.startsWith("/account") ? "Account" : location.pathname.startsWith("/preferences") ? "Preferences" : "Databases");
    document.title = routed ? `${view} · ${routed.name} [${routed.environment}] — Redis Console` : `${view} — Redis Console`;
    return () => { document.title = "Redis Console"; };
  }, [location.pathname, routed?.name, routed?.environment]);
  const base = selected ? `/db/${encodeURIComponent(selected.id)}` : "";
  useEffect(() => {
    if (routed) {
      setLastDatabaseId(routed.id);
      try {
        localStorage.setItem("rconsole.database", routed.id);
      } catch {
        /* Optional id-only preference. */
      }
    }
  }, [routed?.id]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("rconsole.theme", theme);
    } catch {
      /* Preferences are optional. */
    }
  }, [theme]);
  useEffect(() => keyboard.connect(window), []);
  const prefs = usePreferences();
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${prefs.editorFontSize}px`);
  }, [prefs.editorFontSize]);
  useShortcuts("global", {
    palette: () => { setPalette(value => !value); setSearch(""); setPaletteIndex(0); },
    help: () => setShortcuts(true),
    keys: () => { if (base) navigate(`${base}/keys`); },
    console: () => { if (base) navigate(`${base}/console`); },
  });
  // Palette entries show their keyboard shortcut, so the palette also teaches the keys.
  const routedBase = routed ? `/db/${encodeURIComponent(routed.id)}` : "";
  const commands: { label: string; path?: string; shortcut?: ShortcutId; run?: () => void }[] = [
    ...(base
      ? NAV.map((item) => ({
          label: item.label,
          path: `${base}/${item.id}`,
          shortcut:
            item.id === "keys" || item.id === "console"
              ? (item.id as ShortcutId)
              : undefined,
        }))
      : []),
    // Individual tools (F27): the drawer opens on any page of the database being viewed.
    ...(routedBase
      ? [
          {
            label: prefs.drawerOpen ? "Close the tools drawer" : "Open the tools drawer",
            shortcut: "drawer" as const,
            run: () => setPreferences({ drawerOpen: !prefs.drawerOpen }),
          },
          {
            label: "Command helper",
            run: () => setPreferences({ drawerOpen: true, drawerTab: "helper" }),
          },
          ...(routed?.features.profiler
            ? [
                {
                  label: "Profiler (drawer)",
                  run: () => setPreferences({ drawerOpen: true, drawerTab: "profiler" }),
                },
              ]
            : []),
          { label: "Slow log", path: `${routedBase}/diagnostics/slowlog` },
          { label: "Pub/Sub", path: `${routedBase}/diagnostics/pubsub` },
        ]
      : []),
    ...(base && selected ? insightPaletteEntries(base, selected) : []),
    { label: "Choose a database", path: "/" },
    { label: "Preferences", path: "/preferences" },
    { label: "Account settings", path: "/account" },
    ...(me.role === "admin"
      ? [
          { label: "Audit log", path: "/admin/audit" },
          { label: "Local users", path: "/admin/users" },
        ]
      : []),
    { label: "Keyboard shortcuts", shortcut: "help" as const },
  ].filter((item) => item.label.toLowerCase().includes(search.toLowerCase()));
  const openCommand = (item: (typeof commands)[number]) => {
    setPalette(false);
    if (item.run) item.run();
    else if (item.path) navigate(item.path);
    else setShortcuts(true);
  };
  const env = selected?.environment;
  const edge =
    selected && (env === "prod" || env === "staging" || selected.readOnly);
  return (
    <div
      className="app-shell"
      data-env={env}
      data-readonly={selected?.readOnly ? "true" : undefined}
      data-rail={railOpen ? "open" : "closed"}
    >
      <a href="#main-content" className="skip-link">
        Skip to workspace
      </a>
      {edge && (
        <div
          className={`env-edge ${selected.readOnly ? "readonly" : ""}`}
          role="status"
        >
          <span>
            <LockKeyhole size={12} aria-hidden="true" />
            {env === "prod"
              ? "Production database"
              : env === "staging"
                ? "Staging database"
                : "Read-only database"}
            {selected.readOnly
              ? " · All writes are disabled"
              : env === "prod"
                ? " · Changes require explicit confirmation and a reason"
                : " · Changes affect a shared environment"}
          </span>
        </div>
      )}
      <aside className="rail">
        <Link
          className="brand"
          to="/"
          title="All databases"
          aria-label="Redis Console: all databases"
        >
          <span className="brand-mark" aria-hidden="true">
            rc
          </span>
          <span className="brand-name">Redis Console</span>
        </Link>
        <nav aria-label="Main navigation">
          {NAV.map(({ id, label, Icon }) =>
            base ? (
              <NavLink
                key={id}
                aria-label={label}
                title={railOpen ? undefined : label}
                to={`${base}/${id}`}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "active" : ""}`
                }
                data-testid={`nav-${id}`}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="nav-label">{label}</span>
                {id === "keys" && <kbd>{hint("keys")}</kbd>}
                {id === "console" && <kbd>{hint("console")}</kbd>}
              </NavLink>
            ) : (
              <span
                key={id}
                className="nav-item disabled"
                aria-disabled="true"
                aria-label={`${label} (choose a database first)`}
                title="Choose a database first"
                data-testid={`nav-${id}`}
              >
                <Icon size={17} aria-hidden="true" />
                <span className="nav-label">{label}</span>
              </span>
            ),
          )}
        </nav>
        {me.role === "admin" && (
          <nav aria-label="Administration">
            <NavLink
              className="nav-item"
              to="/admin/audit"
              aria-label="Audit log"
              title={railOpen ? undefined : "Audit log"}
              data-testid="nav-audit"
            >
              <ShieldCheck size={17} aria-hidden="true" />
              <span className="nav-label">Audit log</span>
            </NavLink>
            <NavLink
              className="nav-item"
              to="/admin/users"
              aria-label="Local users"
              title={railOpen ? undefined : "Local users"}
              data-testid="nav-users"
            >
              <Users size={17} aria-hidden="true" />
              <span className="nav-label">Local users</span>
            </NavLink>
          </nav>
        )}
        <div className="rail-bottom">
          <button
            className="nav-item"
            aria-label="Keyboard shortcuts"
            title={railOpen ? undefined : "Keyboard shortcuts (?)"}
            onClick={() => setShortcuts(true)}
          >
            <HelpCircle size={17} aria-hidden="true" />
            <span className="nav-label">Shortcuts</span>
            <kbd>?</kbd>
          </button>
          <NavLink
            className="nav-item"
            to="/preferences"
            aria-label="Preferences"
            title={railOpen ? undefined : "Preferences"}
            data-testid="nav-preferences"
          >
            <SlidersHorizontal size={17} aria-hidden="true" />
            <span className="nav-label">Preferences</span>
          </NavLink>
          <NavLink
            className="nav-item profile"
            to="/account"
            aria-label={`Account settings for ${me.displayName}`}
            title={railOpen ? undefined : `Account: ${me.displayName}`}
            data-testid="account-link"
          >
            <span className="avatar" aria-hidden="true">
              {me.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="nav-label profile-text">
              {me.displayName}
              <small>
                {me.source === "oidc" ? "Company SSO" : "Local account"} ·{" "}
                {me.role}
              </small>
            </span>
          </NavLink>
          <button
            className="nav-item"
            aria-label={railOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={railOpen}
            title={railOpen ? undefined : "Expand sidebar"}
            onClick={() => setRailOpen((open) => !open)}
          >
            {railOpen ? (
              <PanelLeftClose size={17} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={17} aria-hidden="true" />
            )}
            <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="contextbar">
          <div className="database-picker">
            <label className="sr-only" htmlFor="database-switcher">
              Database
            </label>
            <select
              id="database-switcher"
              value={selected?.id ?? ""}
              data-testid="database-switcher"
              onChange={(event) => {
                const target = databases.data?.find(
                  (db) => db.id === event.target.value,
                );
                if (target) {
                  setLastDatabaseId(target.id);
                  client.removeQueries({
                    predicate: (item) =>
                      !["me", "databases", "providers"].includes(
                        String(item.queryKey[0]),
                      ),
                  });
                  navigate(`/db/${encodeURIComponent(target.id)}/overview`);
                }
              }}
            >
              <option value="" disabled>
                Select a database
              </option>
              {databases.data?.map((db) => (
                <option value={db.id} key={db.id}>
                  {db.name} [{db.environment}]
                  {db.readOnly ? " · READ ONLY" : ""}
                </option>
              ))}
            </select>
            <ChevronsUpDown size={13} aria-hidden="true" />
          </div>
          {selected && (
            <div className="database-badges">
              <EnvBadge environment={selected.environment} />
              <Badge>
                <span
                  data-testid="db-index"
                  title={`Logical database ${selected.db ?? 0}, set in the server configuration. Choose another configured database to change it.`}
                >
                  db {selected.db ?? 0}
                </span>
              </Badge>
              {selected.readOnly && (
                <Badge tone="red">
                  <LockKeyhole size={11} aria-hidden="true" />
                  Read-only
                </Badge>
              )}
              <Badge>
                <span className="sr-only">Role: </span>
                {selected.effectiveRole}
              </Badge>
            </div>
          )}
          <div className="topbar-actions">
            <button
              className="palette-trigger"
              onClick={() => {
                setSearch("");
                setPaletteIndex(0);
                setPalette(true);
              }}
              data-testid="command-palette-open"
            >
              <Search size={14} aria-hidden="true" />
              <span>Jump to…</span>
              <kbd>{hint("palette")}</kbd>
            </button>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              data-testid="theme-toggle"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => {
                void logout().catch(setLogoutError);
              }}
              data-testid="logout"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <SessionExpiryWarning />
          <ErrorState error={logoutError} />
          <ErrorState error={databases.error} />
          {databases.isPending ? (
            <Loading label="Loading configured databases…" />
          ) : !databases.data?.length ? (
            <Empty>
              <strong>No databases are available to you.</strong>
              <span>
                Your account may not have access yet, or the server has no
                databases configured. Ask your administrator to check the
                configuration and your role.
              </span>
              <button
                onClick={() => {
                  void databases.refetch();
                }}
              >
                Try again
              </button>
            </Empty>
          ) : (
            <Routes>
              <Route
                path="/db/:databaseId"
                element={<DatabaseBoundary databases={databases.data} />}
              >
                <Route index element={<Navigate to="overview" replace />} />
                <Route path="overview" element={<Dashboard />} />
                <Route path="keys" element={<Keys />} />
                <Route path="console" element={<Console key="console" />} />
                <Route
                  path="workbench"
                  element={<Console key="workbench" workbench />}
                />
                <Route path="guided" element={<Guided />} />
                <Route path="diagnostics" element={<Diagnostics />} />
                <Route path="diagnostics/:tool" element={<Diagnostics />} />
              </Route>
              <Route
                path="preferences"
                element={
                  <div className="view">
                    <Suspense fallback={<Loading label="Opening preferences…" />}>
                      <Preferences />
                    </Suspense>
                  </div>
                }
              />
              <Route
                path="account"
                element={
                  <div className="view">
                    <Account />
                  </div>
                }
              />
              <Route
                path="admin/audit"
                element={
                  <div className="view">
                    <Audit />
                  </div>
                }
              />
              <Route
                path="admin/users"
                element={
                  <div className="view">
                    <LocalUsers />
                  </div>
                }
              />
              <Route
                path="*"
                element={
                  <Landing
                    databases={databases.data}
                    lastDatabaseId={lastDatabaseId}
                    onRefresh={() => {
                      void databases.refetch();
                      void client.invalidateQueries({ queryKey: ["status"] });
                    }}
                  />
                }
              />
            </Routes>
          )}
        </main>
        <StatusBar db={selected} me={me} />
      </div>
      {palette && (
        <Modal
          title="Jump to a view"
          onClose={() => setPalette(false)}
          testId="command-palette"
        >
          <input
            ref={paletteInput}
            className="palette-search"
            autoFocus
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPaletteIndex(0);
            }}
            placeholder="Search views and tools…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-options"
            aria-activedescendant={
              commands[paletteIndex]
                ? `palette-option-${paletteIndex}`
                : undefined
            }
            aria-label="Search commands"
            data-testid="command-palette-search"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setPaletteIndex((index) =>
                  Math.max(
                    0,
                    Math.min(
                      commands.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              }
              if (event.key === "Enter" && commands[paletteIndex]) {
                // Closing restores the trigger's focus; consume Enter before it can activate that button again.
                event.preventDefault();
                openCommand(commands[paletteIndex]);
              }
            }}
          />
          <div
            className="palette-results"
            id="palette-options"
            role="listbox"
            aria-label="Views"
          >
            {commands.length ? (
              commands.map((item, index) => (
                <button
                  key={item.label}
                  role="option"
                  id={`palette-option-${index}`}
                  aria-selected={index === paletteIndex}
                  onClick={() => openCommand(item)}
                >
                  <Command size={15} />
                  {item.label}
                  {item.shortcut && <kbd>{hint(item.shortcut)}</kbd>}
                  {item.path && <ArrowUpRight size={14} />}
                </button>
              ))
            ) : (
              <Empty>No matching views.</Empty>
            )}
          </div>
        </Modal>
      )}
      {shortcuts && <ShortcutHelp onClose={() => setShortcuts(false)} />}
    </div>
  );
}
function DatabaseBoundary({ databases }: { databases: DatabaseSummary[] }) {
  const { databaseId } = useParams();
  const db = databases.find((item) => item.id === databaseId);
  if (!db)
    return (
      <Empty
        title="This database is not available to you."
        action={
          <Link className="button primary" to="/">
            Choose a database
          </Link>
        }
      >
        <span>
          The link may point to a database that was removed from the server
          configuration, or your role has no access to it.
        </span>
      </Empty>
    );
  return (
    <DatabaseContext value={db}>
      {/* Pub/Sub and Profiler sessions belong to this database, not to a page (F22, F27). */}
      <LiveProvider key={db.id}>
        <div key={db.id} className="view">
          {/* While a view's code loads, only the view waits: the rail and top bar stay usable (console review R1). */}
          <Suspense fallback={<Loading label="Opening view…" />}>
            <Outlet />
          </Suspense>
        </div>
        <ToolsDrawer key={`drawer:${db.id}`} />
      </LiveProvider>
    </DatabaseContext>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Suspense fallback={<Loading label="Opening workspace…" />}>
            <Session />
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
