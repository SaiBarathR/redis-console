import { Fragment, useState } from "react";
import { useLocation } from "react-router";
import { Modal } from "../../components/ui.tsx";
import {
  contexts,
  isMac,
  shortcutLabel,
  shortcuts,
  type Shortcut,
  type ShortcutContext,
} from "./registry.ts";
import "./ShortcutHelp.css";
/** Contexts that apply to the current view, listed first in the overlay. */
export function viewContexts(pathname: string): ShortcutContext[] {
  const view = /^\/db\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
  if (view === "console")
    return [
      "Console prompt",
      "Console and Workbench editors",
      "Console and Workbench",
      "Result block",
      "History search",
    ];
  if (view === "workbench")
    return [
      "Workbench editor",
      "Console and Workbench editors",
      "Console and Workbench",
      "Result block",
    ];
  if (view === "keys") return ["Key browser"];
  if (pathname === "/") return ["Databases"];
  return [];
}
/** "⌘+Shift+C" as separate key caps; alternatives separated by "or". */
function Keys({ keys, mac }: { keys: readonly string[]; mac: boolean }) {
  return (
    <>
      {keys.map((key, i) => (
        <Fragment key={key}>
          {i > 0 && <span className="shortcut-or">or</span>}
          <span className="shortcut-chord">
            {shortcutLabel(key, mac)
              .split(/\+(?!$)/)
              .map((part, j) => (
                <kbd key={j}>{part}</kbd>
              ))}
          </span>
        </Fragment>
      ))}
    </>
  );
}
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const [mac, setMac] = useState(isMac);
  const here = viewContexts(pathname);
  const order = [
    ...here,
    "Global" as const,
    ...contexts.filter((group) => group !== "Global" && !here.includes(group)),
  ];
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={onClose}
      testId="shortcut-help"
      className="shortcut-help"
    >
      <div className="shortcut-help-intro">
        <p>
          Shortcuts follow focus and never fire while you type in other fields.
          Every one also has a button on screen.
          {here.length ? " Shortcuts for this view come first." : ""}
        </p>
        <div className="segmented" role="group" aria-label="Key labels">
          <button
            type="button"
            aria-pressed={mac}
            onClick={() => setMac(true)}
          >
            macOS
          </button>
          <button
            type="button"
            aria-pressed={!mac}
            onClick={() => setMac(false)}
          >
            Windows / Linux
          </button>
        </div>
      </div>
      <div className="shortcut-groups">
        {order.map((group) => {
          const items = (shortcuts as readonly Shortcut[]).filter(
            (item) => item.group === group,
          );
          if (!items.length) return null;
          return (
            <section
              key={group}
              className="shortcut-group"
              data-current={here.includes(group) || undefined}
              aria-labelledby={`shortcut-group-${group.replace(/\W+/g, "-")}`}
            >
              <h3 id={`shortcut-group-${group.replace(/\W+/g, "-")}`}>
                {group}
                {here.includes(group) && (
                  <span className="shortcut-here">this view</span>
                )}
              </h3>
              <dl>
                {items.map((item) => (
                  <Fragment key={item.id}>
                    <dt>{item.label}</dt>
                    <dd>
                      <Keys keys={item.keys} mac={mac} />
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
