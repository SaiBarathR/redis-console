import type { Reply } from "@rconsole/shared";
import { cliBin, displayBin, DISPLAY_LIMIT, visibleText } from "../lib/format.ts";
import { Badge, DataTable } from "./ui.tsx";
export function ReplyView({
  reply,
  depth = 0,
}: {
  reply: Reply;
  depth?: number;
}) {
  if (depth > 12)
    return <span className="muted">Nested reply display capped</span>;
  if (reply.t === "nil") return <span className="muted data">(nil)</span>;
  if (reply.t === "truncated")
    return <Badge tone="amber">Reply truncated · {reply.bytes} bytes</Badge>;
  if (reply.t === "arr" || reply.t === "set")
    return (
      <div className="reply-list">
        {reply.v.length ? (
          reply.v.slice(0, 1000).map((value, i) => (
            <div className="reply-item" key={i}>
              <span className="muted data">{i + 1})</span>
              <ReplyView reply={value} depth={depth + 1} />
            </div>
          ))
        ) : (
          <span className="muted">
            (empty {reply.t === "arr" ? "array" : "set"})
          </span>
        )}
        {(reply.more || reply.v.length > 1000) && (
          <small>… more elements omitted</small>
        )}
      </div>
    );
  if (reply.t === "map")
    return (
      <>
        <DataTable
          columns={["Key", "Value"]}
          rows={reply.v
            .slice(0, 1000)
            .map(([key, value]) => [
              <ReplyView reply={key} depth={depth + 1} />,
              <ReplyView reply={value} depth={depth + 1} />,
            ])}
        />
        {reply.more && <small>… {reply.more} more pairs</small>}
      </>
    );
  if (reply.t === "str")
    return <pre className="data">{reply.v.enc === "utf8" && visibleText(reply.v.data) === reply.v.data
      ? displayBin(reply.v) : cliBin(reply.v, DISPLAY_LIMIT)}</pre>;
  return (
    <pre
      className={`data ${reply.t === "err" ? "error-text" : reply.t === "status" ? "success" : ""}`}
    >
      {reply.t === "bool"
        ? String(reply.v)
        : visibleText(reply.v.slice(0, 100000))}
    </pre>
  );
}

/** Bounded redis-cli display and clipboard format; all output remains plain text. */
export function cliReply(reply: Reply, depth = 0): string {
  if (depth > 12) return "(nested reply capped)";
  switch (reply.t) {
    case "nil":
      return "(nil)";
    case "int":
      return `(integer) ${reply.v}`;
    case "dbl":
      return `(double) ${reply.v}`;
    case "bool":
      return `(boolean) ${reply.v}`;
    case "status":
      return visibleText(reply.v);
    case "err":
      return `(error) ${visibleText(reply.v)}`;
    case "str":
      // Whole: this is also the clipboard text ("Copy result"); views cap what they show and say so (review r3 M1).
      return cliBin(reply.v);
    case "truncated":
      return `(reply truncated at ${reply.bytes} bytes)`;
    case "arr":
    case "set":
    case "map": {
      const elements =
        reply.t === "map" ? reply.v.flatMap((pair) => pair) : reply.v;
      if (!elements.length)
        return `(empty ${reply.t === "arr" ? "array" : reply.t})`;
      return (
        elements
          .slice(0, 1000)
          .map(
            (child, index) =>
              `${index + 1}) ${cliReply(child, depth + 1).replace(/\n/g, "\n   ")}`,
          )
          .join("\n") +
        (reply.more || elements.length > 1000
          ? "\n… more elements omitted"
          : "")
      );
    }
  }
}
