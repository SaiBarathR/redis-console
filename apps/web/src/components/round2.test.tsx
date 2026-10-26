import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { binFromBytes, binFromString } from "@rconsole/shared";
import { ValueViewer } from "./ValueViewer.tsx";
import { MemoryProvider, useMemorySlot } from "../lib/memory.tsx";
import { cliReply } from "./Reply.tsx";
import {
  detection,
  epochLabel,
  javaDescriptor,
  probeDeflate,
} from "../lib/format.ts";
import { jsonPaths } from "./KeyOperations.tsx";
function Draft({ db }: { db: string }) {
  const [text, set] = useMemorySlot(db, "");
  return (
    <input
      aria-label="Draft"
      value={text}
      onChange={(event) => set(event.target.value)}
    />
  );
}
describe("review regressions", () => {
  it("parses a full JSON document above the text display cap", async () => {
    render(
      <ValueViewer
        value={binFromString(
          JSON.stringify({ large: "x".repeat(120000), tail: "fully parsed" }),
        )}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Tree" }));
    expect(screen.getByText("fully parsed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("requires full bytes before structured decoding", () => {
    render(<ValueViewer value={binFromString('{"partial":')} truncated />);
    for (const name of ["JSON", "Tree", "MsgPack"])
      expect(screen.getByRole("tab", { name })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Text" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/Load the full value to decode/)).toBeVisible();
  });
  it("retains memory across page unmounts, isolates databases and clears with the session", async () => {
    const { rerender } = render(
      <MemoryProvider key="session1">
        <Draft db="a" />
      </MemoryProvider>,
    );
    await userEvent.type(screen.getByLabelText("Draft"), "sensitive command");
    rerender(
      <MemoryProvider key="session1">
        <span>Other page</span>
      </MemoryProvider>,
    );
    rerender(
      <MemoryProvider key="session1">
        <Draft db="a" />
      </MemoryProvider>,
    );
    expect(screen.getByLabelText("Draft")).toHaveValue("sensitive command");
    rerender(
      <MemoryProvider key="session1">
        <Draft db="b" />
      </MemoryProvider>,
    );
    expect(screen.getByLabelText("Draft")).toHaveValue("");
    rerender(
      <MemoryProvider key="session2">
        <Draft db="a" />
      </MemoryProvider>,
    );
    expect(screen.getByLabelText("Draft")).toHaveValue("");
  });
  it("does not call plain text PHP or confirmed deflate", async () => {
    expect(detection(binFromString("s:hello this is plain text"))).toBe(
      "UTF-8",
    );
    expect(await probeDeflate(binFromString("x^2 + y^2"))).toBe(false);
    render(<ValueViewer value={binFromString("x^2 + y^2")} />);
    await waitFor(() => expect(screen.getByText("UTF-8")).toBeVisible());
    expect(screen.queryByTestId("value-inflate")).toBeNull();
  });
  it("reads only bounded Java class descriptors and signed serialVersionUID", () => {
    const name = new TextEncoder().encode("java.lang.String");
    const bytes = new Uint8Array(8 + name.length + 8);
    bytes.set([0xac, 0xed, 0, 5, 0x73, 0x72, 0, name.length]);
    bytes.set(name, 8);
    new DataView(bytes.buffer).setBigInt64(8 + name.length, -123n);
    expect(javaDescriptor(binFromBytes(bytes))).toEqual({
      name: "java.lang.String",
      uid: "-123",
    });
    expect(javaDescriptor(binFromBytes(bytes.subarray(0, 12)))).toBeUndefined();
  });
  it("formats RESP types, binary strings and nested numbering like redis-cli", () => {
    expect(
      cliReply({
        t: "arr",
        v: [
          { t: "int", v: "9223372036854775807" },
          { t: "nil" },
          { t: "str", v: binFromBytes(new Uint8Array([97, 255, 0])) },
        ],
      }),
    ).toBe('1) (integer) 9223372036854775807\n2) (nil)\n3) "a\\xff\\x00"');
  });
  it("recognizes seconds, milliseconds and stream IDs without guessing small numbers", () => {
    expect(epochLabel("1700000000")).toBe("2023-11-14T22:13:20.000Z");
    expect(epochLabel("1700000000000-1")).toBe(epochLabel("1700000000000"));
    expect(epochLabel("3")).toBeUndefined();
  });
  it("offers quoted JSON paths without interpreting property names", () => {
    expect(jsonPaths({ "a.b": [3] }).map((item) => item.path)).toEqual([
      "$",
      '$["a.b"]',
      '$["a.b"][0]',
    ]);
  });
});
describe("formatter tabs follow the value until the user picks one", () => {
  it("opens JSON documents as JSON and shows text after the value stops being JSON", async () => {
    const { rerender } = render(<ValueViewer value={binFromString('{"a":1}')} />);
    expect(screen.getByRole("tab", { name: "JSON" })).toHaveAttribute("aria-selected", "true");
    rerender(<ValueViewer value={binFromString("plain text")} />);
    expect(screen.getByRole("tab", { name: "Text" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("key-value")).toHaveTextContent("plain text");
    await userEvent.click(screen.getByRole("tab", { name: "Hex" }));
    rerender(<ValueViewer value={binFromString('{"b":2}')} />);
    expect(screen.getByRole("tab", { name: "Hex" })).toHaveAttribute("aria-selected", "true");
  });
});
