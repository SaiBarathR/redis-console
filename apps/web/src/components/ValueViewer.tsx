import { parseJson, stringifyJson } from "../lib/json.ts";
import { useEffect, useMemo, useState } from "react";
import { defaultValueFormat, usePreferences } from "../lib/preferences.ts";
import { bytesFromBin, type Bin } from "@rconsole/shared";
import {
  COPY_FULL_LIMIT,
  cliBin,
  DISPLAY_LIMIT,
  detection,
  probeDeflate,
  parseValue,
  javaDescriptor,
  epochLabel,
  formatValue,
  inflateValue,
  type ValueFormat,
  visibleText,
} from "../lib/format.ts";
import { decodeMsgpack, msgpackExtTypes } from "../lib/msgpack.ts";
import { Badge, CopyButton, ErrorState, JsonTree, Tabs } from "./ui.tsx";

export const FORMATS: { id: ValueFormat; label: string; structured?: boolean; detected?: RegExp }[] = [
  { id: "text", label: "Text" },
  { id: "json", label: "JSON", structured: true },
  { id: "tree", label: "Tree", structured: true },
  { id: "hex", label: "Hex" },
  { id: "base64", label: "Base64" },
  { id: "msgpack", label: "MsgPack", structured: true },
  // Offered only for values detected as serialized PHP / Java: an inert reading of their structure (L3).
  { id: "php", label: "PHP", structured: true, detected: /^PHP serialization/ },
  { id: "java", label: "Java", structured: true, detected: /^Java serialization/ },
  { id: "float32le", label: "Float32 LE", structured: true },
  { id: "float32be", label: "Float32 BE", structured: true },
  { id: "float64le", label: "Float64 LE", structured: true },
  { id: "float64be", label: "Float64 BE", structured: true },
];

/** A UTF-8 value that is a whole JSON object or array opens as pretty JSON. */
function looksLikeJson(value: Bin) {
  if (value.enc !== "utf8" || value.data.length > 512 * 1024) return false;
  const text = value.data.replace(/^[ \t\r\n]+/, "");
  if (!/^[[{]/.test(text)) return false;
  try {
    parseJson(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Formatter tabs over one value: text, JSON, tree, hex, base64 and MessagePack, plus local gzip/deflate
 * inflation. Detection is display only; serialized Java/PHP objects are never deserialized.
 */
export function ValueViewer({
  value,
  truncated = false,
  preview = false,
  preferred,
}: {
  value: Bin;
  /** The bytes are a preview of a longer value: structured views are off and Copy copies the preview. */
  truncated?: boolean;
  /** A collection element's preview (no "Load full value" exists for it). */
  preview?: boolean;
  preferred?: ValueFormat;
}) {
  // The automatic format follows the value (a JSON document opens as JSON, and an edit that makes it plain text
  // shows text); a format the user picks stays picked.
  const json = useMemo(() => looksLikeJson(value), [value]);
  const [chosen, setFormat] = useState<ValueFormat>();
  const valuePreference = usePreferences().valueFormat;
  // Inflation (and its error) belongs to the bytes it was made from: a refreshed value with other bytes drops it,
  // and a late result for superseded bytes is never shown.
  const [inflation, setInflation] = useState<{
    of: Bin;
    result?: Bin;
    error?: unknown;
  }>();
  const current =
    inflation &&
    inflation.of.enc === value.enc &&
    inflation.of.data === value.data
      ? inflation
      : undefined;
  const inflated = current?.result;
  const error = current?.error;
  const [busy, setBusy] = useState(false);
  const displayed = inflated ?? value;
  const detected = detection(displayed);
  const formats = FORMATS.filter((item) => !item.detected || item.detected.test(detected));
  const format: ValueFormat =
    (chosen && formats.some((item) => item.id === chosen) ? chosen : undefined) ??
    (truncated ? "text" : (preferred ?? (json ? "json" : defaultValueFormat(value.enc, valuePreference))));
  const [verified, setVerified] = useState<Bin>();
  useEffect(() => {
    let active = true;
    if (detected === "Possible zlib compression")
      void probeDeflate(displayed).then((valid) => {
        if (active) setVerified(valid ? displayed : undefined);
      });
    return () => {
      active = false;
    };
  }, [displayed, detected]);
  const kind =
    detected === "Possible zlib compression"
      ? verified === displayed
        ? "deflate"
        : displayed.enc === "utf8"
          ? "UTF-8"
          : "Binary"
      : detected;
  let text = "";
  let failure: unknown;
  try {
    if (truncated && FORMATS.find((item) => item.id === format)?.structured)
      throw new Error("Load the full value to decode.");
    if (format !== "tree") text = format === "text" && displayed.enc === "base64"
      ? cliBin(displayed, DISPLAY_LIMIT) : formatValue(displayed, format);
  } catch (caught) {
    failure = caught;
  }
  let tree: unknown;
  if (format === "tree" && !failure) {
    try {
      tree = parseValue(displayed);
      text = visibleText(stringifyJson(tree));
    } catch (caught) {
      failure = caught;
    }
  }
  // Copy copies the whole representation; only a server preview, or a value too large to copy in full, is a
  // labelled preview copy (web review v0.2 r3 M1).
  const partial = truncated || bytesFromBin(displayed).length > COPY_FULL_LIMIT;
  const copyText = () => {
    if (!partial && format === "text" && displayed.enc === "utf8") return displayed.data;
    if (!partial && format === "text") return cliBin(displayed);
    return partial || format === "tree" ? text : formatValue(displayed, format, Infinity);
  };
  const copyLabel = partial ? "Copy preview" : format === "text" && displayed.enc === "base64" ? "Copy as redis-cli" : "Copy value";
  const java = javaDescriptor(displayed);
  let extTypes: number[] = [];
  if (format === "msgpack" && !failure) {
    try {
      extTypes = msgpackExtTypes(decodeMsgpack(bytesFromBin(displayed)));
    } catch {
      extTypes = [];
    }
  }
  const epoch = displayed.enc === "utf8" ? epochLabel(displayed.data) : undefined;
  return (
    <div className="value-viewer">
      <div className="value-toolbar">
        <Tabs
          label="Value format"
          testId="value-format"
          value={format}
          onChange={setFormat}
          options={formats.map((item) => ({
            id: item.id,
            label: item.label,
            disabled: truncated && item.structured,
            title:
              truncated && item.structured
                ? "Load the full value to decode"
                : undefined,
          }))}
        />
        <Badge>{kind}</Badge>
        {inflated && <Badge tone="blue">Inflated locally</Badge>}
        <span className="value-toolbar-end">
          {(kind === "gzip" || kind === "deflate") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const of = value;
                setBusy(true);
                setInflation(inflated ? { of, result: inflated } : undefined);
                void inflateValue(displayed)
                  .then((result) => setInflation({ of, result }))
                  .catch((caught: unknown) =>
                    setInflation({ of, result: inflated, error: caught }),
                  )
                  .finally(() => setBusy(false));
              }}
              data-testid="value-inflate"
            >
              {busy ? "Inflating…" : "Inflate (max 4 MiB)"}
            </button>
          )}
          {inflated && (
            <button type="button" onClick={() => setInflation(undefined)}>
              Show original bytes
            </button>
          )}
          <button type="button" disabled={truncated || bytesFromBin(value).length > COPY_FULL_LIMIT} title={truncated || bytesFromBin(value).length > COPY_FULL_LIMIT ? "Load the full value within the 4 MiB download cap" : "Download exact original bytes"} onClick={() => downloadBytes(value)} data-testid="value-download">Download bytes</button>
          {failure ? (
            <button type="button" className="ghost" disabled title="Nothing to copy in this format">
              {copyLabel}
            </button>
          ) : (
            <CopyButton text={copyText} label={copyLabel} />
          )}
        </span>
      </div>
      {truncated && (
        <p className="value-note">
          {preview
            ? "Structured views need the whole element; use Load full element."
            : "Load the full value to decode JSON, Tree, MsgPack, PHP or Java."}
        </p>
      )}
      {format.startsWith("float") && !failure && <p className="value-note">{bytesFromBin(displayed).length / (format.startsWith("float32") ? 4 : 8)} dimensions · {format.startsWith("float32") ? "float32" : "float64"} · {format.endsWith("le") ? "little" : "big"} endian. Download preserves the original bytes.</p>}
      {(format === "php" || format === "java") && !failure && (
        <p className="value-note" data-testid="value-serialized-note">
          {format === "php"
            ? "Read as PHP serialize() output, var_dump style. Nothing is unserialized: no class is loaded, references are not followed and custom (C:) payloads are shown as bytes."
            : "Read as a Java serialization stream: class descriptors, field names and values, #n handles and references. Nothing is deserialized: no class is loaded and no code runs. writeObject data is shown as its block bytes and values."}
        </p>
      )}
      {format === "msgpack" && extTypes.length > 0 && (
        <p className="value-note" data-testid="value-msgpack-ext">
          MessagePack extension {extTypes.length === 1 ? "type" : "types"} {extTypes.join(", ")}: shown as type and bytes, not interpreted.
        </p>
      )}
      {java && (
        <p className="value-note data">
          Java class {java.name} · serialVersionUID {java.uid}
        </p>
      )}
      {epoch && (
        <p className="value-note" title={displayed.data}>
          Reads as a timestamp: {epoch}
        </p>
      )}
      <ErrorState error={failure ?? error} />
      {!failure &&
        (format === "tree" ? (
          <div className="value-content tree" data-testid="key-value">
            <JsonTree value={tree} />
          </div>
        ) : (
          <pre className="value-content data" data-testid="key-value">
            {text}
          </pre>
        ))}
    </div>
  );
}

/** A local, opaque Blob URL; the filename is static and never contains Redis data. */
export function downloadBytes(value: Bin) {
  const blob = new Blob([Uint8Array.from(bytesFromBin(value)).buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "redis-value.bin";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
