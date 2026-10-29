import { JsonNumber, parseJson, stringifyJson } from "../lib/json.ts";
import { useMemo, useState } from "react";
import {
  binEquals,
  binFromString,
  binFromBytes,
  bytesFromBin,
  type Bin,
  type EditConflict,
  type EditExpect,
  type KeyDetails,
  type KeyListItem,
  type KeyOp,
} from "@rconsole/shared";
import { digestBin, digestText, observedConflict } from "../lib/expect.ts";
import { editableBin, parseValue, visibleText } from "../lib/format.ts";
import { executeCli, KEY_EXISTS, keyOperation } from "../lib/operations.ts";
import { useDatabase } from "../lib/context.tsx";
import { lineValues } from "../lib/array.ts";
import { ConflictNotice, conflictOf, HandledError } from "./Conflict.tsx";
import { ActionForm, ErrorState, Field, Modal } from "./ui.tsx";
export const CREATE_TYPES = [
  "string",
  "hash",
  "list",
  "set",
  "zset",
  "stream",
  "json",
  "timeseries",
  "bloom",
  "cuckoo",
  "vectorset",
  "array", // v0.4 arrays
] as const;
type CreateType = (typeof CREATE_TYPES)[number];
/** The Redis TYPE reply for each creatable type (for the new key's list row). */
const REDIS_TYPE: Record<CreateType, string> = {
  string: "string",
  hash: "hash",
  list: "list",
  set: "set",
  zset: "zset",
  stream: "stream",
  json: "ReJSON-RL",
  timeseries: "TSDB-TYPE",
  bloom: "MBbloom--",
  cuckoo: "MBbloomCF",
  vectorset: "vectorset",
  array: "array",
};
function editorTitle(details?: KeyDetails) {
  switch (details?.value.type) {
    case undefined:
      return "Add a key";
    case "hash":
      return "Set a hash field";
    case "list":
      return "Add or replace a list item";
    case "set":
      return "Add a set member";
    case "zset":
      return "Add or update a sorted set member";
    case "stream":
      return "Add a stream entry";
    case "timeseries":
      return "Add a sample";
    default:
      return "Edit value";
  }
}
export function inputBin(text: string, encoding: "utf8" | "base64"): Bin {
  const value: Bin = { enc: encoding, data: text };
  try {
    bytesFromBin(value);
  } catch {
    throw new Error(`"${text.length > 40 ? `${text.slice(0, 40)}…` : text}" is not valid base64.`);
  }
  return value;
}
/**
 * "Create key" must never change an existing key, field or document. Strings and JSON are created with NX. The other
 * types have no create-only command, so the name is checked first (EXISTS); their writes then only add, and the ones
 * that could replace data (HSET, ZADD) use HSETNX and ZADD NX, so a key created between the check and the write
 * keeps every field and member.
 */
async function assertNewKey(database: string, key: Bin) {
  const { reply } = await executeCli(database, {
    argvBin: [binFromString("EXISTS"), key],
  });
  if (reply.t !== "int" || reply.v !== "0") throw new Error(KEY_EXISTS);
}
const cli = (...args: (string | Bin)[]) => ({
  argvBin: args.map((arg) => (typeof arg === "string" ? binFromString(arg) : arg)),
});
/**
 * The expectation of an element the editor writes in a collection it opened (compare-and-set, review r3): its
 * bytes when the loaded page shows it, `null` when the page shows the whole collection without it. A field or
 * member that is not on a partial page is expected absent too, so an unseen value is never replaced blindly: the
 * server answers 409 with it, and the user decides.
 */
function elementExpect(base: KeyDetails, find: () => { value: Bin; truncated?: boolean } | undefined): EditExpect {
  const found = find();
  if (found?.truncated)
    throw new Error("The stored value is a truncated preview here; change it in the console.");
  return { type: base.type, sha256: found ? digestBin(found.value) : null };
}
export function KeyEditor({
  details,
  current,
  onClose,
  onSaved,
  onReload,
}: {
  /** The key as it was when the editor opened: the title, the form, the operation and its expectation follow it. */
  details?: KeyDetails;
  /** The latest read of the key; a change to what the editor opened shows a conflict instead of saving. */
  current?: KeyDetails;
  onClose: () => void;
  /** Called after a successful write; a new key is passed so the list can show it without a rescan. */
  onSaved: (created?: KeyListItem) => Promise<unknown>;
  /** Re-read the key and reopen the editor on it (after a conflict). */
  onReload?: () => void;
}) {
  const db = useDatabase();
  // Bound to an immutable opening snapshot (web review v0.2 r3 H2). `base` is what the save expects Redis to
  // hold; it moves only when the user explicitly overwrites a changed value.
  const [opened] = useState(details);
  const [base, setBase] = useState(details);
  details = opened;
  const [saving, setSaving] = useState(false);
  const [serverConflict, setServerConflict] = useState<EditConflict>();
  const [decision, setDecision] = useState<{ busy: boolean; error?: unknown }>({ busy: false });
  // Hashes values only when the reads change, not on every keystroke.
  const observedNow = useMemo(() => (base && current ? observedConflict(base, current) : undefined), [base, current]);
  const observed = saving ? undefined : observedNow;
  const conflict = serverConflict ?? observed;
  const initialType = details?.value.type;
  const [type, setType] = useState<CreateType>(
    CREATE_TYPES.includes(initialType as CreateType)
      ? (initialType as CreateType)
      : "string",
  );
  const [name, setName] = useState(details?.key.data ?? "");
  const [keyEncoding, setKeyEncoding] = useState<"utf8" | "base64">(
    details?.key.enc ?? "utf8",
  );
  const initialValue =
    details?.value.type === "string" ? editableBin(details.value.value) : undefined;
  const [value, setValue] = useState(
    initialValue?.data ??
      (details?.value.type === "json" ? details.value.json : ""),
  );
  const [encoding, setEncoding] = useState<"utf8" | "base64">(
    initialValue?.enc ?? "utf8",
  );
  const [field, setField] = useState("");
  const [score, setScore] = useState("0");
  const [index, setIndex] = useState("0");
  const [ttl, setTtl] = useState("");
  const [keepTtl, setKeepTtl] = useState(!!details);
  const [mode, setMode] = useState("append");
  const [path, setPath] = useState("$");
  const [fileError, setFileError] = useState<unknown>();
  const [importing, setImporting] = useState(false);
  let paths: ReturnType<typeof jsonPaths> = [];
  if (base?.value.type === "json" && !base.value.truncated) {
    try {
      paths = jsonPaths(parseValue(binFromString(base.value.json)));
    } catch {
      /* Keep raw editor available. */
    }
  }
  const save = async (override: { expect?: EditExpect; base?: KeyDetails } = {}) => {
    setSaving(true);
    try {
      await write(override);
    } catch (error) {
      setSaving(false);
      const found = conflictOf(error);
      if (!found) throw error;
      setServerConflict(found);
      throw new HandledError("conflict");
    }
  };
  /** "Overwrite anyway": write the draft over exactly the state the conflict showed (a new expectation, checked again). */
  const overwrite = (expect: EditExpect) => {
    const next = serverConflict ? base : current;
    setServerConflict(undefined);
    if (next) setBase(next);
    setDecision({ busy: true });
    void save({ expect, ...(next ? { base: next } : {}) })
      .then(() => setDecision({ busy: false }))
      .catch((error: unknown) => setDecision({ busy: false, error: error instanceof HandledError ? undefined : error }));
  };
  const write = async ({ expect: override, base: expected = base }: { expect?: EditExpect; base?: KeyDetails }) => {
          const key = details?.key ?? inputBin(name, keyEncoding);
          const created: KeyListItem | undefined = details
            ? undefined
            : {
                key,
                type: REDIS_TYPE[type],
                ttl: type === "string" && ttl ? Number(ttl) : -1,
              };
          // v0.4 arrays: ARINSERT of the initial values, compare-and-set on "no key": the server writes only when the
          // key does not exist (409 otherwise), so a create never overwrites, even against a concurrent writer.
          if (!details && type === "array") {
            try {
              await keyOperation(db.id, { op: "array.insert", key, values: lineValues(value, encoding), expect: { type: "none" } });
            } catch (error) {
              if (conflictOf(error)) throw new Error(KEY_EXISTS);
              throw error;
            }
            await onSaved(created);
            onClose();
            return;
          }
          const val = inputBin(value, encoding);
          const f = binFromString(field);
          if (!details && type !== "string") {
            if (type === "json") parseJson(value);
            else await assertNewKey(db.id, key);
            const createOnly =
              type === "json"
                ? cli("JSON.SET", key, "$", value, "NX")
                : type === "hash"
                  ? cli("HSETNX", key, f, val)
                  : type === "zset"
                    ? cli("ZADD", key, "NX", score, val)
                    : undefined;
            if (createOnly) {
              const { reply } = await executeCli(db.id, createOnly);
              if (reply.t === "nil" || (reply.t === "int" && reply.v === "0"))
                throw new Error(KEY_EXISTS);
              await onSaved(created);
              onClose();
              return;
            }
          }
          let operation: KeyOp;
          // Edits of an existing key carry what the editor opened (compare-and-set, review r3).
          const v = expected?.value;
          switch (type) {
            case "string":
              operation = {
                op: "string.set",
                key,
                value: val,
                ...(details && keepTtl ? { keepTtl: true } : ttl ? { ttl: Number(ttl) } : {}),
                ...(!details ? { nx: true } : {}),
                ...(expected && v?.type === "string"
                  ? { expect: override ?? { type: expected.type, sha256: digestBin(v.value) } }
                  : {}),
              };
              break;
            case "hash":
              operation = {
                op: "hash.set",
                key,
                entries: [{ field: f, value: val }],
                ...(expected && v?.type === "hash"
                  ? { expect: override ?? elementExpect(expected, () => v.entries.find((e) => binEquals(e.field, f))) }
                  : {}),
              };
              break;
            case "list": {
              if (!(details && mode === "replace")) {
                operation = {
                  op: "list.push",
                  key,
                  values: [val],
                  end: mode === "prepend" ? "head" : "tail",
                };
                break;
              }
              const at = Number(index);
              const resolved = at < 0 && expected?.length !== undefined ? expected.length + at : at;
              const item = v?.type === "list" ? v.items.find((i) => i.index === resolved) : undefined;
              if (!override && !item)
                throw new Error(
                  `Index ${index} is not on the loaded page. Open the page that shows it, or edit its row.`,
                );
              if (item?.truncated)
                throw new Error("The stored value is a truncated preview here; change it in the console.");
              operation = {
                op: "list.set",
                key,
                index: at,
                value: val,
                expect: override ?? { type: expected!.type, sha256: digestBin(item!.value) },
              };
              break;
            }
            case "set":
              operation = { op: "set.add", key, members: [val] };
              break;
            case "zset":
              operation = {
                op: "zset.add",
                key,
                members: [{ member: val, score }],
                ...(expected && v?.type === "zset"
                  ? {
                      expect: override ?? elementExpect(expected, () => {
                        const m = v.members.find((x) => binEquals(x.member, val));
                        return m && { value: binFromString(m.score), truncated: m.truncated };
                      }),
                    }
                  : {}),
              };
              break;
            case "stream":
              operation = {
                op: "stream.add",
                key,
                id: "*",
                fields: [{ field: f, value: val }],
              };
              break;
            case "json":
              parseJson(value);
              operation = {
                op: "json.set",
                key,
                path,
                json: value,
                ...(expected && v?.type === "json"
                  ? { expect: override ?? { type: expected.type, sha256: digestText(v.json) } }
                  : {}),
              };
              break;
            case "bloom":
            case "cuckoo":
              await executeCli(db.id, {
                argvBin: [
                  binFromString(type === "bloom" ? "BF.ADD" : "CF.ADD"),
                  key,
                  val,
                ],
              });
              await onSaved(created);
              onClose();
              return;
            case "vectorset": {
              const vector = value
                .split(/[\s,]+/)
                .filter(Boolean)
                .map(Number);
              if (
                !vector.length ||
                vector.length > 1024 ||
                vector.some((v) => !Number.isFinite(v))
              )
                throw new Error(
                  "Provide 1–1024 finite numeric vector coordinates, separated by commas.",
                );
              await executeCli(db.id, {
                argvBin: [
                  binFromString("VADD"),
                  key,
                  binFromString("VALUES"),
                  binFromString(String(vector.length)),
                  ...vector.map((v) => binFromString(String(v))),
                  binFromString(field),
                ],
              });
              await onSaved(created);
              onClose();
              return;
            }
            case "array": // created above; existing arrays are edited in the array inspector
              throw new Error("Edit array elements in the array inspector.");
            case "timeseries":
              if (!Number.isFinite(Number(value)) || !value.trim())
                throw new Error("Enter a finite numeric sample.");
              await executeCli(db.id, {
                argvBin: [
                  binFromString("TS.ADD"),
                  key,
                  binFromString("*"),
                  binFromString(value),
                ],
              });
              await onSaved(created);
              onClose();
              return;
          }
          await keyOperation(db.id, operation);
          await onSaved(created);
          onClose();
  };
  return (
    <Modal
      title={editorTitle(details)}
      onClose={onClose}
      testId="key-editor-dialog"
    >
      <ActionForm
        disabled={importing || !!conflict || decision.busy}
        label={details ? "Save changes" : "Create key"}
        testId="key-save"
        onSubmit={() => save()}
      >
        {!details && (
          <>
            <Field label="Key type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as CreateType)}
                data-testid="key-create-type"
              >
                {CREATE_TYPES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                    {item === "json" ||
                    item === "timeseries" ||
                    item === "bloom" ||
                    item === "cuckoo" ||
                    item === "vectorset"
                      ? " (requires module)"
                      : ""}
                  </option>
                ))}
              </select>
            </Field>
            <div className="form-row">
              <Field label="Key name">
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  data-testid="key-create-name"
                />
              </Field>
              <Field label="Key encoding">
                <select
                  data-testid="key-create-encoding"
                  value={keyEncoding}
                  onChange={(e) =>
                    setKeyEncoding(e.target.value as "utf8" | "base64")
                  }
                >
                  <option value="utf8">UTF-8</option>
                  <option value="base64">Base64</option>
                </select>
              </Field>
            </div>
          </>
        )}
        {(type === "hash" || type === "stream" || type === "vectorset") && (
          <Field label={type === "vectorset" ? "Member name" : "Field"}>
            <input
              required
              value={field}
              onChange={(e) => setField(e.target.value)}
              data-testid="key-edit-field"
            />
          </Field>
        )}
        {type === "list" && (
          <>
            <Field label="Action">
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="append">Append to tail · RPUSH</option>
                <option value="prepend">Prepend to head · LPUSH</option>
                {details && (
                  <option value="replace">Replace at index · LSET</option>
                )}
              </select>
            </Field>
            {mode === "replace" && (
              <Field label="Index">
                <input
                  type="number"
                  required
                  value={index}
                  onChange={(e) => setIndex(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        {type === "zset" && (
          <Field label="Score">
            <input
              required
              value={score}
              onChange={(e) => setScore(e.target.value)}
              data-testid="key-edit-score"
            />
          </Field>
        )}
        {type === "json" && details && (
          <>
            <Field label="JSON path">
              <input
                required
                maxLength={1024}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                aria-label="JSON path"
              />
            </Field>
            <Field label="Pick a document path">
              <select
                aria-label="Pick a JSON path"
                value={paths.some((item) => item.path === path) ? path : ""}
                onChange={(e) => {
                  const item = paths.find(
                    (item) => item.path === e.target.value,
                  );
                  if (item) {
                    setPath(item.path);
                    setValue(item.json);
                  }
                }}
              >
                <option value="" disabled>
                  Custom path
                </option>
                {paths.map((item) => (
                  <option
                    key={item.path}
                    value={item.path}
                    disabled={!!item.unavailable}
                    title={item.unavailable}
                  >
                    {pathLabel(item.path)}
                    {item.unavailable ? " (not addressable here)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            {paths.some((item) => item.unavailable) && (
              <p className="muted">
                Paths through property names with line breaks cannot be entered in the path field; edit their parent
                object or the root document ($) instead.
              </p>
            )}
            {/[\u0000-\u001f\u007f]/.test(path) && (
              <p className="muted data">Path with invisible characters shown: {pathLabel(path)}</p>
            )}
          </>
        )}
        {(type === "string" || type === "json") && (
          <Field label="Import value from file (max 4 MiB)">
            <input
              type="file"
              disabled={importing}
              aria-label="Import value from file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 4 * 1024 * 1024) {
                  event.target.setCustomValidity(
                    "File exceeds the 4 MiB input limit.",
                  );
                  event.target.reportValidity();
                  return;
                }
                event.target.setCustomValidity("");
                setFileError(undefined);
                setImporting(true);
                void file
                  .arrayBuffer()
                  .then((buffer) => {
                    const decoded = binFromBytes(new Uint8Array(buffer));
                    const next = type === "json" ? decoded : editableBin(decoded);
                    if (type === "json" && next.enc !== "utf8")
                      throw new Error("JSON files must contain UTF-8 text.");
                    setEncoding(next.enc);
                    setValue(next.data);
                  })
                  .catch(setFileError)
                  .finally(() => setImporting(false));
              }}
            />
            <ErrorState error={fileError} />
          </Field>
        )}
        <Field
          label={
            type === "json"
              ? "JSON document"
              : type === "set" || type === "zset"
                ? "Member"
                : type === "timeseries"
                  ? "Numeric sample (timestamp is now)"
                  : type === "vectorset"
                    ? "Vector coordinates (comma separated)"
                    : type === "array"
                      ? "Initial values, one per line (indices 0, 1, 2, …)"
                    : type === "bloom" || type === "cuckoo"
                      ? "Member"
                      : "Value"
          }
        >
          <textarea
            required={
              type === "json" || type === "timeseries" || type === "vectorset" || type === "array"
            }
            rows={6}
            autoComplete="off"
            spellCheck={false}
            className="data"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="key-edit-value"
          />
        </Field>
        {type !== "json" && type !== "timeseries" && type !== "vectorset" && (
          <Field label="Value encoding">
            <select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as "utf8" | "base64")}
              data-testid="key-edit-encoding"
            >
              <option value="utf8">UTF-8 text</option>
              <option value="base64">Base64 bytes</option>
            </select>
          </Field>
        )}
        {initialValue?.enc === "base64" && details?.value.type === "string" && details.value.value.enc === "utf8" && (
          <p className="notice">Contains CR / CRLF line endings. Base64 editing preserves the stored bytes.</p>
        )}
        {type === "string" && details && (
          <label className="checkbox">
            <input type="checkbox" checked={keepTtl} onChange={e => setKeepTtl(e.target.checked)} />
            Keep current expiry (SET KEEPTTL)
          </label>
        )}
        {type === "string" && (
          <Field
            label="TTL in seconds (optional)"
            hint={
              details
                ? keepTtl ? "Keeps the existing expiry exactly, including no expiry." : "An empty TTL removes the current expiry."
                : "An empty TTL keeps the key indefinitely."
            }
          >
            <input
              type="number"
              min={1}
              step={1}
              value={ttl}
              onChange={(e) => setTtl(e.target.value)}
              disabled={!!details && keepTtl}
              data-testid="key-edit-ttl"
            />
          </Field>
        )}
        {(type === "json" ||
          type === "timeseries" ||
          type === "bloom" ||
          type === "cuckoo" ||
          type === "vectorset") && (
          <p className="muted">
            Requires the corresponding Redis module. Availability is enforced by
            the server.
          </p>
        )}
        {conflict && (
          <ConflictNotice
            conflict={conflict}
            opened={
              base?.value.type === "string"
                ? base.value.value
                : base?.value.type === "json"
                  ? binFromString(base.value.json)
                  : undefined
            }
            busy={decision.busy}
            onReload={() => (onReload ? onReload() : onClose())}
            onOverwrite={conflict.reason === "type" ? undefined : overwrite}
          />
        )}
        <ErrorState error={decision.error} />
      </ActionForm>
    </Modal>
  );
}

/** A JSONPath shown as text: control and bidirectional characters escaped, never interpreted. */
export function pathLabel(path: string) {
  return visibleText(path.replace(/[\t\n\r]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

/**
 * Document paths for the picker, in the RedisJSON bracket grammar: inside `["…"]` only `"` and `\` are escaped and
 * every other character, controls included, is literal (RedisJSON rejects JSON escapes such as `\n` there; review
 * r3 L1). A path whose property names contain a line break is listed as `unavailable`: a single-line path field
 * cannot hold it.
 */
export function jsonPaths(value: unknown) {
  const result: { path: string; json: string; unavailable?: string }[] = [];
  const visit = (child: unknown, path: string, depth: number) => {
    if (result.length >= 200 || depth > 6 || path.length > 1024) return;
    result.push({
      path,
      json: stringifyJson(child),
      ...(/[\r\n]/.test(path)
        ? { unavailable: "A property name in this path has a line break, which the path field cannot hold." }
        : {}),
    });
    if (child && typeof child === "object" && !(child instanceof JsonNumber))
      for (const [key, item] of Object.entries(child).slice(0, 200))
        visit(
          item,
          `${path}[${Array.isArray(child) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`}]`,
          depth + 1,
        );
  };
  visit(value, "$", 0);
  return result;
}
