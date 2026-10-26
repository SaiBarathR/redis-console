import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, UserPlus } from "lucide-react";
import type {
  AuditEvent,
  DatabaseSummary,
  LocalUser,
  Role,
} from "@rconsole/shared";
import { collection, post, query, request } from "../lib/api.ts";
import { useSession } from "../lib/context.tsx";
import { visibleText } from "../lib/format.ts";
import {
  ActionForm,
  Empty,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageTitle,
} from "../components/ui.tsx";

const PAGE = 100;
const stamp = new Intl.DateTimeFormat(undefined, {
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const OUTCOME_LABEL: Record<AuditEvent["outcome"], string> = {
  allowed: "allowed",
  denied: "denied",
  error: "error",
  confirmation_required: "needs confirmation",
};

export function Audit() {
  const { me } = useSession();
  const [user, setUser] = useState("");
  const [database, setDatabase] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [before, setBefore] = useState<string[]>([]);
  const [filter, setFilter] = useState({
    user: "",
    database: "",
    action: "",
    outcome: "",
  });
  // Database ids for the filter suggestions come from the shell's cached list (no extra request).
  const databases = useQueryClient().getQueryData<DatabaseSummary[]>([
    "databases",
  ]);
  const cursor = before.at(-1);
  const data = useQuery({
    queryKey: ["audit", filter, cursor],
    enabled: me.role === "admin",
    queryFn: async () =>
      collection<AuditEvent>(
        await request(
          "/admin/audit" +
            query({
              user: filter.user || undefined,
              database: filter.database || undefined,
              action: filter.action || undefined,
              outcome: filter.outcome || undefined,
              before: cursor,
              limit: PAGE,
            }),
        ),
        "events",
      ),
  });
  if (me.role !== "admin")
    return (
      <Empty title="The audit log needs an admin account.">
        Ask an administrator if you need to review activity.
      </Empty>
    );
  const filtered = Object.values(filter).some(Boolean);
  const events = data.data ?? [];
  const clear = () => {
    setUser("");
    setDatabase("");
    setAction("");
    setOutcome("");
    setBefore([]);
    setFilter({ user: "", database: "", action: "", outcome: "" });
  };
  return (
    <div className="workspace audit">
      <PageTitle
        title="Audit log"
        description="Sign-ins, commands and admin changes, newest first. Values are never stored; arguments show as their size."
        actions={
          <button
            type="button"
            className="ghost"
            disabled={data.isFetching}
            onClick={() => {
              void data.refetch();
            }}
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={data.isFetching ? "spin" : ""}
            />
            Refresh
          </button>
        }
      />
      <form
        className="filter-bar"
        aria-label="Filter audit events"
        onSubmit={(event) => {
          event.preventDefault();
          setBefore([]);
          setFilter({ user, database, action, outcome });
        }}
      >
        <Field label="User">
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="username"
            data-testid="audit-user-filter"
          />
        </Field>
        <Field label="Database">
          <input
            className="data"
            value={database}
            list="audit-database-ids"
            onChange={(e) => setDatabase(e.target.value)}
            placeholder="database id"
            data-testid="audit-database-filter"
          />
          <datalist id="audit-database-ids">
            {databases?.map((db) => (
              <option key={db.id} value={db.id}>
                {db.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Action">
          <input
            className="data"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="cli.exec"
            data-testid="audit-action-filter"
          />
        </Field>
        <Field label="Outcome">
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            data-testid="audit-outcome-filter"
          >
            <option value="">All outcomes</option>
            {(
              ["allowed", "denied", "error", "confirmation_required"] as const
            ).map((value) => (
              <option key={value} value={value}>
                {OUTCOME_LABEL[value]}
              </option>
            ))}
          </select>
        </Field>
        <div className="actions">
          <button type="submit" className="primary" data-testid="audit-filter">
            Apply filters
          </button>
          {filtered && (
            <button type="button" className="ghost" onClick={clear}>
              Clear
            </button>
          )}
        </div>
      </form>
      <div className="admin-table">
        <ErrorState
          error={data.error}
          onRetry={() => {
            void data.refetch();
          }}
        />
        {data.isPending ? (
          <Loading label="Reading audit events…" />
        ) : events.length ? (
          <table>
            <thead>
              <tr>
                {/* Outcome next to who and what: it is what tells a refusal from a change, and must stay
                    visible at 1024 px while the command scrolls. */}
                <th>Time</th>
                <th>User</th>
                <th>Outcome</th>
                <th>Action</th>
                <th>Database</th>
                <th>Command (arguments redacted)</th>
                <th>Reason or detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="nowrap tabular" title={event.at}>
                    {stamp.format(new Date(event.at))}
                  </td>
                  <td>
                    <span className="user-ip">
                      <span>{visibleText(event.username)}</span>
                      <small className="data" title="Source address">
                        {visibleText(event.ip)}
                      </small>
                    </span>
                  </td>
                  <td>
                    <span className={`outcome-tag ${event.outcome}`}>
                      {OUTCOME_LABEL[event.outcome] ?? event.outcome}
                    </span>
                  </td>
                  <td>
                    <code>{visibleText(event.action)}</code>
                  </td>
                  <td>
                    {event.databaseId ? (
                      <code>{visibleText(event.databaseId)}</code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {event.command ? (
                      <code className="audit-command">
                        {/* The redacted argv starts with the command itself; fall back to the name. */}
                        <span className="cmd">
                          {visibleText(
                            event.argvRedacted?.[0] ?? event.command,
                          )}
                        </span>
                        {event.argvRedacted && event.argvRedacted.length > 1
                          ? ` ${visibleText(event.argvRedacted.slice(1).join(" "))}`
                          : ""}
                        {event.keyCount ? (
                          <span className="muted">
                            {" "}
                            · {event.keyCount}{" "}
                            {event.keyCount === 1 ? "key" : "keys"}
                          </span>
                        ) : null}
                      </code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="reason">
                    {event.reason || event.detail ? (
                      visibleText(event.reason ?? event.detail ?? "")
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title={
              filtered
                ? "No events match these filters."
                : before.length
                  ? "No older events."
                  : "No events recorded yet."
            }
            action={
              filtered ? (
                <button type="button" onClick={clear}>
                  Clear filters
                </button>
              ) : before.length ? (
                <button type="button" onClick={() => setBefore([])}>
                  Back to newest
                </button>
              ) : undefined
            }
          >
            {filtered
              ? "User and action match exactly. Check the spelling or clear a filter."
              : null}
          </Empty>
        )}
      </div>
      <footer className="pane-foot">
        <span>
          {data.data
            ? `Page ${before.length + 1} · ${events.length} ${events.length === 1 ? "event" : "events"}${filtered ? " · filtered" : ""}`
            : ""}
        </span>
        <div className="actions">
          <button
            type="button"
            disabled={!before.length}
            onClick={() => setBefore([])}
          >
            Newest
          </button>
          <button
            type="button"
            disabled={!before.length}
            onClick={() => setBefore((pages) => pages.slice(0, -1))}
          >
            Newer
          </button>
          <button
            type="button"
            disabled={!data.data?.length || data.data.length < PAGE}
            onClick={() => {
              const last = data.data?.at(-1)?.id;
              if (last) setBefore((pages) => [...pages, last]);
            }}
            data-testid="audit-next"
          >
            Older events
          </button>
        </div>
      </footer>
    </div>
  );
}

function UserEditor({
  user,
  onClose,
  onSaved,
}: {
  user?: LocalUser;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "viewer");
  const [password, setPassword] = useState("");
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [resetTotp, setReset] = useState(false);
  return (
    <Modal
      title={user ? `Manage ${user.username}` : "Create a local user"}
      onClose={onClose}
      testId="user-editor-dialog"
    >
      <ActionForm
        label={user ? "Save changes" : "Create user"}
        testId="user-save"
        onSubmit={async () => {
          if (user)
            await request(`/admin/users/${encodeURIComponent(user.id)}`, {
              method: "PATCH",
              body: {
                displayName,
                role,
                disabled,
                ...(password ? { newPassword: password } : {}),
                ...(resetTotp ? { resetTotp: true } : {}),
              },
            });
          else
            await post("/admin/users", {
              username,
              displayName,
              role,
              initialPassword: password,
            });
          setPassword("");
          await onSaved();
          onClose();
        }}
      >
        {!user && (
          <Field
            label="Username"
            hint="3 to 64 letters, numbers, periods, underscores or hyphens."
          >
            <input
              className="data"
              autoComplete="off"
              required
              pattern="[a-zA-Z0-9._\-]{3,64}"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="user-username"
            />
          </Field>
        )}
        <div className="form-row">
          <Field label="Display name">
            <input
              required
              maxLength={128}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="user-display-name"
            />
          </Field>
          <Field label="Role">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              data-testid="user-role"
            >
              <option value="viewer">viewer · reads only</option>
              <option value="operator">operator · reads and writes</option>
              <option value="admin">admin · everything, plus users</option>
            </select>
          </Field>
        </div>
        <Field
          label={user ? "New password (optional)" : "Initial password"}
          hint="At least 12 characters. The user must change it at the next sign-in."
        >
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            required={!user}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="user-password"
          />
        </Field>
        {user && (
          <fieldset className="checks">
            <legend className="sr-only">Account state</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={disabled}
                onChange={(e) => setDisabled(e.target.checked)}
                data-testid="user-disabled"
              />
              Block sign-in for this account
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={resetTotp}
                onChange={(e) => setReset(e.target.checked)}
                data-testid="user-reset-totp"
              />
              Reset the authenticator (the user enrolls again at sign-in)
            </label>
          </fieldset>
        )}
      </ActionForm>
    </Modal>
  );
}

export function Users() {
  const { me } = useSession();
  const [editing, setEditing] = useState<LocalUser | "new">();
  const data = useQuery({
    queryKey: ["users"],
    enabled: me.role === "admin",
    queryFn: async () =>
      collection<LocalUser>(await request("/admin/users"), "users"),
  });
  if (me.role !== "admin")
    return (
      <Empty title="User management needs an admin account.">
        Ask an administrator to create or change local accounts.
      </Empty>
    );
  const users = data.data ?? [];
  const blocked = users.filter((user) => user.disabled).length;
  return (
    <div className="workspace users">
      <PageTitle
        title="Local users"
        description={
          data.data
            ? `${users.length} accounts${blocked ? ` · ${blocked} blocked` : ""} · SSO accounts are managed in your identity provider`
            : "SSO accounts are managed in your identity provider"
        }
        actions={
          <button
            type="button"
            className="primary"
            onClick={() => setEditing("new")}
            data-testid="user-add"
          >
            <UserPlus size={14} aria-hidden="true" />
            Create user
          </button>
        }
      />
      <div className="admin-table">
        <ErrorState
          error={data.error}
          onRetry={() => {
            void data.refetch();
          }}
        />
        {data.isPending ? (
          <Loading label="Reading local users…" />
        ) : users.length ? (
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Two-factor</th>
                <th>Created</th>
                <th>Last sign-in</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={user.disabled ? "blocked" : undefined}>
                  <td>
                    <span className="stack">
                      <span>{visibleText(user.displayName)}</span>
                      <small className="data">{visibleText(user.username)}</small>
                    </span>
                  </td>
                  <td>
                    <span className={`role-tag ${user.role}`}>{user.role}</span>
                  </td>
                  <td>
                    <span className={`outcome-tag ${user.disabled ? "denied" : "allowed"}`}>
                      {user.disabled ? "Disabled" : "Active"}
                    </span>
                  </td>
                  <td>{user.totpEnabled ? "Enrolled" : "Not enrolled"}</td>
                  <td className="nowrap tabular">
                    {stamp.format(new Date(user.createdAt))}
                  </td>
                  <td className="nowrap tabular">
                    {user.lastLoginAt ? (
                      stamp.format(new Date(user.lastLoginAt))
                    ) : (
                      <span className="muted">Never</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      onClick={() => setEditing(user)}
                      data-testid="user-edit"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title="No local users yet."
            action={
              <button type="button" onClick={() => setEditing("new")}>
                Create user
              </button>
            }
          >
            People who sign in with company SSO do not appear here.
          </Empty>
        )}
      </div>
      {editing && (
        <UserEditor
          user={editing === "new" ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => data.refetch()}
        />
      )}
    </div>
  );
}
