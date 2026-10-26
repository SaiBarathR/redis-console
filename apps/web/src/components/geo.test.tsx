import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromString, type Reply } from "@rconsole/shared";
import { geoView, richKind, RICH_LABEL } from "../lib/richReply.ts";
import { fitBox, GeoMap } from "./GeoMap.tsx";
import { RichReply } from "./RichReply.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const s = (v: string): Reply => ({ t: "str", v: binFromString(v) });
const pos = (lon: string, lat: string): Reply => ({ t: "arr", v: [s(lon), s(lat)] });
const arr = (...v: Reply[]): Reply => ({ t: "arr", v });

describe("geo results (v0.4 F11)", () => {
  it("parses GEOSEARCH WITHCOORD WITHDIST WITHHASH in reply order, whatever order the flags were typed", () => {
    const argv = ["GEOSEARCH", "places", "FROMLONLAT", "13.4", "52.5", "BYRADIUS", "200", "km", "WITHHASH", "WITHCOORD", "WITHDIST"];
    const reply = arr(arr(s("Berlin"), s("1.2"), { t: "int", v: "3471579339700058" }, pos("13.40", "52.52")), arr(s("Potsdam"), s("27.5"), { t: "int", v: "1" }, pos("13.06", "52.39")));
    const view = geoView(argv, reply)!;
    expect(view.points.map((p) => [p.lon, p.lat, p.dist, p.hash])).toEqual([
      [13.4, 52.52, "1.2", "3471579339700058"],
      [13.06, 52.39, "27.5", "1"],
    ]);
    expect(view.center).toEqual({ lon: 13.4, lat: 52.5 });
    expect(view.radiusM).toBe(200_000);
    expect(view.unit).toBe("km");
    expect(richKind(argv, reply)).toBe("geo");
    expect(RICH_LABEL.geo).toBe("Map");
  });

  it("reads RESP3 doubles, GEORADIUS, BYBOX and GEOPOS with missing members", () => {
    const dbl = (v: string): Reply => ({ t: "dbl", v });
    const radius = geoView(["GEORADIUS_RO", "k", "-0.12", "51.5", "5", "mi", "WITHCOORD"], arr(arr(s("London"), arr(dbl("-0.1276"), dbl("51.5072")))))!;
    expect(radius.points[0]).toMatchObject({ lon: -0.1276, lat: 51.5072 });
    expect(radius.radiusM).toBeCloseTo(8046.72);
    const box = geoView(["GEOSEARCH", "k", "FROMMEMBER", "a", "BYBOX", "10", "4", "km", "WITHCOORD"], arr(arr(s("a"), pos("2.35", "48.85"))))!;
    expect(box.boxM).toEqual({ width: 10_000, height: 4_000 });
    expect(box.center).toBeUndefined();
    const positions = geoView(["GEOPOS", "k", "paris", "nowhere", "rome"], arr(pos("2.35", "48.85"), { t: "nil" }, pos("12.49", "41.89")))!;
    expect(positions.points.map((p) => p.label)).toEqual(["paris", "rome"]);
    expect(positions.missing).toEqual(["nowhere"]);
  });

  it("has no map without coordinates, for STORE, errors, or out-of-range positions", () => {
    expect(richKind(["GEOSEARCH", "k", "FROMMEMBER", "a", "BYRADIUS", "1", "km"], arr(s("a"), s("b")))).toBeUndefined();
    expect(richKind(["GEORADIUS", "k", "0", "0", "1", "km", "WITHCOORD", "STORE", "dst"], { t: "int", v: "2" })).toBeUndefined();
    expect(richKind(["GEOPOS", "k", "a"], { t: "err", v: "WRONGTYPE" })).toBeUndefined();
    expect(richKind(["GEOPOS", "k", "a"], arr(pos("200", "10")))).toBeUndefined();
    expect(richKind(["GEOSEARCH", "k", "FROMMEMBER", "a", "BYRADIUS", "1", "km", "WITHCOORD"], arr(arr(s("a"), pos("x", "1"))))).toBeUndefined();
  });

  it("fits the points with padding, keeps a landscape frame and stays inside the world", () => {
    const one = fitBox({ points: [{ label: "p", lon: 10, lat: 50 }] });
    expect(one.w).toBeGreaterThanOrEqual(20);
    expect(one.w / one.h).toBeGreaterThan(1.5);
    expect(one.x).toBeLessThan((10 + 180) * 10);
    expect(one.x + one.w).toBeGreaterThan((10 + 180) * 10);
    const edge = fitBox({ points: [{ label: "a", lon: -179.9, lat: 89.9 }, { label: "b", lon: -170, lat: 80 }] });
    expect(edge.x).toBeGreaterThanOrEqual(0);
    expect(edge.y).toBeGreaterThanOrEqual(0);
    const spread = fitBox({ points: [{ label: "a", lon: -170, lat: -80 }, { label: "b", lon: 170, lat: 80 }] });
    expect(spread).toEqual({ x: 0, y: 0, w: 3600, h: 1800 });
  });

  it("draws points as text-only, keyboard-selectable markers over the bundled outline, without any fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const hostile = '<img src=x onerror="alert(1)">';
    const argv = ["GEOSEARCH", "k", "FROMLONLAT", "2.35", "48.85", "BYRADIUS", "500", "km", "WITHCOORD", "WITHDIST"];
    const reply = arr(arr(s(hostile), s("0.4"), pos("2.35", "48.86")), arr(s("Lyon"), s("391.5"), pos("4.83", "45.76")));
    const { container } = render(<RichReply kind="geo" reply={reply} argv={argv} />);
    const map = screen.getByTestId("geo-map");
    expect(within(map).getByTestId("geo-count")).toHaveTextContent("2 points");
    await waitFor(() => expect(screen.getByTestId("geo-land").getAttribute("d")!.length).toBeGreaterThan(1000));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByTestId("geo-row")[0]).toHaveTextContent(hostile);
    const points = screen.getAllByTestId("geo-point");
    expect(points).toHaveLength(2);
    points[1]!.focus();
    await userEvent.keyboard("{Enter}");
    expect(points[1]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByTestId("geo-row")[1]).toHaveClass("selected");
    expect(container.querySelector("text.geo-label")).toHaveTextContent("Lyon");
    await userEvent.click(screen.getByTestId("geo-world"));
    expect(container.querySelector("svg.geo-svg")!.getAttribute("viewBox")).toBe("0 0 3600 1800");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says what it left out", () => {
    const reply: Reply = { t: "arr", v: [pos("1", "1"), { t: "nil" }], more: 7 };
    render(<GeoMap view={geoView(["GEOPOS", "k", "a", "b"], reply)!} />);
    expect(screen.getByTestId("geo-map")).toHaveTextContent("7 more not drawn");
    expect(screen.getByTestId("geo-map")).toHaveTextContent("Not found: b");
  });
});
