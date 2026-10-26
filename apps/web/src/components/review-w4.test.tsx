import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { binFromBytes, binFromString, bytesFromBin, tokenizeCommandLineBytes, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { cliBin, visibleText } from "../lib/format.ts";
import { keyOperation } from "../lib/operations.ts";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { cliReply } from "./Reply.tsx";
import { CommandEcho } from "./ConsoleResult.tsx";
import { KeyName } from "./anatomy.tsx";
import { ValueViewer } from "./ValueViewer.tsx";
import { KeyInspector } from "./KeyInspector.tsx";
import { HistorySearch } from "./HistorySearch.tsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const invisibles = Array.from({ length: 65536 }, (_, n) => String.fromCharCode(n)).filter(c => visibleText(c) !== c);
it.each(invisibles)("M1: displayed and copied argument U+%s round-trips through the shared byte tokenizer", c => {
  const value = binFromString(`${c}key\\u200b😀`);
  const shown = cliReply({ t: "str", v: value });
  expect(tokenizeCommandLineBytes(shown).map(b => Array.from(b))).toEqual([Array.from(bytesFromBin(value))]);
  expect(shown).toBe(cliBin(value));
});
it("M1 sweep: rendered command and key carry parseable bytes", () => {
  const value = binFromString("\ufeffkey\u200b\r\n\0");
  const { container } = render(<CommandEcho line={`GET '${value.data}'`} docs={[]} />);
  expect(Array.from(tokenizeCommandLineBytes(container.textContent!)[1]!)).toEqual(Array.from(bytesFromBin(value)));
  cleanup();
  const key = render(<KeyName name={value} />);
  expect(tokenizeCommandLineBytes(key.container.textContent!).map(b => Array.from(b))).toEqual([Array.from(bytesFromBin(value))]);
});
it("M1 sweep: history displays parseable commands while choosing retains the original executable text", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const line = "GET '\ufeffkey\u200b'", onChoose = vi.fn();
  render(<HistorySearch history={[line]} onChoose={onChoose} onClose={() => {}} />);
  const option = screen.getByRole("option");
  expect(tokenizeCommandLineBytes(option.textContent!).map(b => Array.from(b))).toEqual(tokenizeCommandLineBytes(line).map(b => Array.from(b)));
  await userEvent.click(option);
  expect(onChoose).toHaveBeenCalledWith(line);
});
it.each(["a\r\nb", "a\0b", "\ufeff{\"a\":1}", "abc\u202edef", "a\u200bb", "literal \\u000d"])("M2: Text Copy value preserves %s", async data => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  render(<ValueViewer value={binFromString(data)} />);
  await userEvent.click(screen.getByRole("tab", { name: "Text" }));
  await userEvent.click(screen.getByRole("button", { name: "Copy value" }));
  expect(writeText).toHaveBeenCalledWith(data);
});
it("L1: a BOM-prefixed JSON string opens on Text with an exact copy available", () => {
  render(<ValueViewer value={binFromString('\ufeff{"a":1}')} />);
  expect(screen.getByRole("tab", { name: "Text" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Copy value" })).toBeEnabled();
});
it("M2 sweep: binary Text copies a labelled, quoted redis-cli argument with exact bytes", async () => {
  const value = binFromBytes(new Uint8Array([0xff, 0, 13, 10, 0x80]));
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const { container } = render(<ValueViewer value={value} />);
  await userEvent.click(screen.getByRole("button", { name: "Copy as redis-cli" }));
  const copied = writeText.mock.calls[0]![0];
  expect(container.querySelector("pre")!.textContent).toBe(copied);
  expect(tokenizeCommandLineBytes(copied).map(b => Array.from(b))).toEqual([Array.from(bytesFromBin(value))]);
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
it("L2: refreshing a deleted key removes the old value and mutation controls", async () => {
  const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", effectiveRole: "operator", features: { profiler: false }, readOnly: false, status: "connected" };
  const details: KeyDetails = { key: binFromString("k"), type: "string", ttl: -1, value: { type: "string", value: binFromString("STALE-VALUE"), truncated: false, totalBytes: 11 } };
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ++reads === 1 ? json(details) : json({ error: { code: "not_found", message: "Key does not exist." } }, 404)));
  render(<MemoryRouter><MemoryProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DatabaseContext value={db}><KeyInspector selected={details.key} delimiter=":" onDeleted={() => {}} /></DatabaseContext></QueryClientProvider></MemoryProvider></MemoryRouter>);
  await userEvent.click(await screen.findByRole("button", { name: "Refresh key" }));
  await screen.findByText("This key no longer exists.");
  expect(screen.queryByText("STALE-VALUE")).toBeNull();
  expect(screen.queryByTestId("key-edit")).toBeNull();
  expect(screen.queryByTestId("key-ttl")).toBeNull();
});
it("L2: EXPIRE 0 reports a missing key; PERSIST 0 remains a valid no-op", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true, result: { t: "int", v: "0" } })));
  await expect(keyOperation("db", { op: "key.expire", key: binFromString("k"), ttl: 100 })).rejects.toThrow("This key no longer exists.");
  await expect(keyOperation("db", { op: "key.persist", key: binFromString("k") })).resolves.toMatchObject({ ok: true });
});
