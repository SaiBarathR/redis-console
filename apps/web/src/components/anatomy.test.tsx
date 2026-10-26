import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  binFromBytes,
  binFromString,
  type DatabaseSummary,
} from "@rconsole/shared";
import {
  countdown,
  fuseFraction,
  KeyName,
  remaining,
  segmentKey,
  ttlState,
  TtlFuse,
  TypeGlyph,
} from "./anatomy.tsx";
import { landingOrder } from "../pages/Landing.tsx";

describe("key anatomy", () => {
  it("splits namespaces, identifiers and the leaf without changing the text", () => {
    const key = "session:9f2a1b7c:profile";
    const segments = segmentKey(key);
    expect(segments.map((segment) => segment.kind)).toEqual(["ns", "id", "leaf"]);
    expect(segments.map((segment) => segment.text).join(":")).toBe(key);
    expect(segmentKey("user:1001:cart").map((s) => s.kind)).toEqual(["ns", "id", "leaf"]);
    expect(
      segmentKey("job:3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f").map((s) => s.kind),
    ).toEqual(["ns", "id"]);
    expect(segmentKey("plain").map((s) => s.kind)).toEqual(["leaf"]);
    expect(segmentKey("a/b/c", "/").map((s) => s.kind)).toEqual(["ns", "ns", "leaf"]);
  });
  it("keeps the full key as text when a folder prefix is hidden, and shows invisible characters", () => {
    const { container, rerender } = render(
      <KeyName name={binFromString("app:user:42")} prefix="app:user:" />,
    );
    expect(container.textContent).toBe("app:user:42");
    rerender(<KeyName name={binFromString("evil‮txt:​x")} />);
    expect(container.textContent).toBe('"evil\\xe2\\x80\\xaetxt:\\xe2\\x80\\x8bx"');
    rerender(<KeyName name={binFromString("<img src=x onerror=alert(1)>")} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<KeyName name={binFromBytes(new Uint8Array([255, 58, 0]))} />);
    expect(container.textContent).toBe('"\\xff:\\x00"');
  });
  it("names the full Redis type for assistive technology", () => {
    render(<TypeGlyph type="ReJSON-RL" />);
    expect(screen.getByText("jsn")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("ReJSON-RL")).toBeInTheDocument();
  });
});

describe("TTL fuse", () => {
  it("burns on a log scale: full at seven days, visibly different at 20 s and 20 min", () => {
    expect(fuseFraction(7 * 24 * 3600)).toBe(1);
    expect(fuseFraction(0)).toBe(0);
    expect(fuseFraction(20 * 60) - fuseFraction(20)).toBeGreaterThan(0.3);
  });
  it("classifies states and formats a compact countdown", () => {
    expect(ttlState(-1)).toBe("persist");
    expect(ttlState(0)).toBe("expired");
    expect(ttlState(45)).toBe("critical");
    expect(ttlState(1800)).toBe("soon");
    expect(ttlState(7200)).toBe("long");
    expect(countdown(42)).toBe("42s");
    expect(countdown(545)).toBe("9m 05s");
    expect(countdown(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(countdown(4 * 86400 + 6 * 3600)).toBe("4d 6h");
    expect(countdown(-1)).toBe("no expiry");
  });
  it("counts down from the time the server reported the TTL", () => {
    expect(remaining(100, 1_000, 31_000)).toBe(70);
    expect(remaining(10, 0, 60_000)).toBe(0);
    expect(remaining(-1, 0, 60_000)).toBe(-1);
  });
  it("hides the bar from assistive technology; the label carries the value", () => {
    const { container } = render(<TtlFuse ttl={-1} readAt={Date.now()} />);
    expect(container.querySelector(".fuse-track")).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent).toBe("no expiry");
  });
});

describe("database landing order", () => {
  const db = (id: string, name: string, environment: DatabaseSummary["environment"]) =>
    ({ id, name, environment }) as DatabaseSummary;
  it("puts the last used database first, then names, with production last", () => {
    const list = [db("p", "Alpha prod", "prod"), db("b", "Beta", "dev"), db("a", "Alpha", "test")];
    expect(landingOrder(list, "").map((item) => item.id)).toEqual(["a", "b", "p"]);
    expect(landingOrder(list, "b").map((item) => item.id)).toEqual(["b", "a", "p"]);
    expect(landingOrder(list, "p").map((item) => item.id)).toEqual(["p", "a", "b"]);
  });
});
