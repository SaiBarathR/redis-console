import { useEffect, useRef, type RefObject } from "react";
import { keyboard, shortcut, type DispatchId } from "./registry.ts";
/** Global entries ignore every text field; the rest may fire inside CodeMirror editors (or their own scope). */
const GLOBAL_ONLY: readonly DispatchId[] = ["help", "keys", "console"];
export function useShortcuts(
  scope: string,
  handlers: Partial<
    Record<DispatchId, (event: KeyboardEvent) => boolean | void>
  >,
  root?: RefObject<HTMLElement | null>,
  typing: "editor" | "scope" = "editor",
) {
  const latest = useRef(handlers);
  latest.current = handlers;
  const ids = Object.keys(handlers).sort().join(",");
  useEffect(() => {
    const remove = (ids.split(",").filter(Boolean) as DispatchId[]).map((id) =>
      keyboard.register({
        id,
        scope,
        keys: shortcut(id).keys,
        root: root ? () => root.current : undefined,
        typing: GLOBAL_ONLY.includes(id) ? undefined : typing,
        run: (event) => latest.current[id]?.(event),
      }),
    );
    return () => remove.forEach((dispose) => dispose());
  }, [scope, root, typing, ids]);
}
