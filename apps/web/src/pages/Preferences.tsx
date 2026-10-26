import type { ReactNode } from "react";
import {
  DEFAULT_PREFERENCES,
  formatDateTime,
  formatTime,
  resetPreferences,
  setPreferences,
  usePreferences,
  type Preferences as Prefs,
} from "../lib/preferences.ts";
import { hint } from "../lib/keyboard/registry.ts";
import { PageTitle } from "../components/ui.tsx";

function Choice<K extends keyof Prefs>({
  name,
  label,
  description,
  options,
}: {
  name: K;
  label: string;
  description?: ReactNode;
  options: { value: Prefs[K]; label: string }[];
}) {
  const prefs = usePreferences();
  const id = `pref-${name}`;
  return (
    <div className="pref-row">
      <div className="pref-label">
        <label htmlFor={id}>{label}</label>
        {description && <small id={`${id}-help`}>{description}</small>}
      </div>
      <select
        id={id}
        value={String(prefs[name])}
        aria-describedby={description ? `${id}-help` : undefined}
        data-testid={id}
        onChange={(event) => {
          const option = options.find((item) => String(item.value) === event.target.value);
          if (option) setPreferences({ [name]: option.value } as Partial<Prefs>);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
            {option.value === DEFAULT_PREFERENCES[name] ? " (default)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ name, label, description }: { name: "clearWorkbenchAfterRun"; label: string; description: ReactNode }) {
  const prefs = usePreferences();
  return (
    <div className="pref-row">
      <div className="pref-label">
        <label htmlFor={`pref-${name}`}>{label}</label>
        <small id={`pref-${name}-help`}>{description}</small>
      </div>
      <input
        id={`pref-${name}`}
        type="checkbox"
        checked={prefs[name]}
        aria-describedby={`pref-${name}-help`}
        data-testid={`pref-${name}`}
        onChange={(event) => setPreferences({ [name]: event.target.checked })}
      />
    </div>
  );
}

const SAMPLE = Date.UTC(2026, 9, 24, 14, 3, 9);

/**
 * Presentation preferences (F26). Kept in this browser only and never containing Redis data; limits, roles and
 * timeouts are deployment policy in the server configuration and are not settable here.
 */
export function Preferences() {
  const prefs = usePreferences();
  return (
    <div className="preferences" data-testid="preferences">
      <PageTitle
        title="Preferences"
        description="How this browser shows things. Stored on this device; no Redis data, no server policy."
        actions={
          <button type="button" className="ghost" onClick={resetPreferences} data-testid="pref-reset">
            Restore defaults
          </button>
        }
      />
      <section className="section pref-section" aria-labelledby="pref-time">
        <header>
          <h2 id="pref-time">Date and time</h2>
          <span className="meta" data-testid="pref-time-sample">
            Example: {formatDateTime(SAMPLE, prefs)} · {formatTime(SAMPLE, prefs)}
          </span>
        </header>
        <Choice
          name="timeZone"
          label="Time zone"
          description="UTC keeps timelines comparable with server logs during an incident."
          options={[
            { value: "local", label: `This browser (${Intl.DateTimeFormat().resolvedOptions().timeZone})` },
            { value: "utc", label: "UTC" },
          ]}
        />
        <Choice
          name="hourCycle"
          label="Clock"
          options={[
            { value: "h23", label: "24-hour" },
            { value: "h12", label: "12-hour" },
          ]}
        />
        <Choice
          name="dateStyle"
          label="Dates"
          options={[
            { value: "locale", label: "Browser style (Oct 24, 14:03:09)" },
            { value: "iso", label: "ISO 8601 (2026-10-24 14:03:09)" },
          ]}
        />
        <p className="pref-applies">Applies to the slow log, Pub/Sub, the profiler and the status bar.</p>
      </section>
      <section className="section pref-section" aria-labelledby="pref-values">
        <header>
          <h2 id="pref-values">Values and refresh</h2>
        </header>
        <Choice
          name="valueFormat"
          label="String values open as"
          description="A value that is a whole JSON document still opens as JSON."
          options={[
            { value: "text", label: "Text (control bytes made visible)" },
            { value: "binary-hex", label: "Hex for binary values, text otherwise" },
            { value: "hex", label: "Hex" },
          ]}
        />
        <Choice
          name="toolRefreshSeconds"
          label="Slow log and channel list refresh"
          description="The starting interval; each tool can still change it for the visit."
          options={[
            { value: 0, label: "Manual" },
            { value: 5, label: "Every 5 s" },
            { value: 15, label: "Every 15 s" },
            { value: 30, label: "Every 30 s" },
            { value: 60, label: "Every 60 s" },
          ]}
        />
      </section>
      <section className="section pref-section" aria-labelledby="pref-editor">
        <header>
          <h2 id="pref-editor">Editors</h2>
        </header>
        <Choice
          name="editorFontSize"
          label="Editor font size"
          options={[
            { value: 12, label: "12 px" },
            { value: 13, label: "13 px" },
            { value: 14, label: "14 px" },
            { value: 16, label: "16 px" },
          ]}
        />
        <Toggle
          name="clearWorkbenchAfterRun"
          label="Clear the Workbench after a clean run"
          description="Only when the whole script ran without errors; running a selection never clears it."
        />
      </section>
      <section className="section pref-section" aria-labelledby="pref-drawer">
        <header>
          <h2 id="pref-drawer">Tools drawer</h2>
        </header>
        <Choice
          name="drawerOpen"
          label="Drawer on database pages"
          description={
            <>
              Also <kbd>{hint("drawer")}</kbd> on any database page. The Console history and results in it stay in this
              tab's memory only.
            </>
          }
          options={[
            { value: false, label: "Closed" },
            { value: true, label: "Open" },
          ]}
        />
        <Choice
          name="drawerSplit"
          label="Drawer layout"
          description="Side by side keeps the Console visible next to the Command helper or the Profiler. The drawer's Side by side button switches it too."
          options={[
            { value: false, label: "One tool at a time" },
            { value: true, label: "Side by side" },
          ]}
        />
      </section>
      <section className="section pref-section" aria-labelledby="pref-policy">
        <header>
          <h2 id="pref-policy">Set by the server</h2>
        </header>
        <p className="pref-applies" data-testid="pref-server-policy">
          The server sets the most keys one key-browser scan may cover, reply and value limits, command timeouts, the
          profiler's environments and roles. Ask an administrator to change the server configuration. How many keys a
          scan covers, up to that limit, is your choice: <strong>Keys to scan</strong> at the bottom of the key list.
        </p>
      </section>
    </div>
  );
}
