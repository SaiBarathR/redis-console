import { describe, expect, it } from "vitest";
import type { Reply } from "@rconsole/shared";
import { aggregateTable, explainPlan, multiSeriesOf, profileView, richKind, searchTable, seriesOf } from "./richReply.ts";

const s = (data: string): Reply => ({ t: "str", v: { enc: "utf8", data } });
const b64 = (data: string): Reply => ({ t: "str", v: { enc: "base64", data } });
const i = (v: string | number): Reply => ({ t: "int", v: String(v) });
const d = (v: number): Reply => ({ t: "dbl", v: String(v) });
const arr = (...v: Reply[]): Reply => ({ t: "arr", v });
const map = (...pairs: [string, Reply][]): Reply => ({ t: "map", v: pairs.map(([k, v]) => [s(k), v]) });

describe("command-aware reply readings (F11)", () => {
  it("FT.SEARCH RESP3: ids keep their bytes, fields in order, total and warnings", () => {
    const reply = map(
      ["attributes", arr()],
      ["format", s("STRING")],
      ["results", arr(map(["id", b64("/wA=")], ["extra_attributes", map(["title", s("Blue")], ["price", s("25")])], ["values", arr()]), map(["id", s("doc:2")], ["extra_attributes", map(["title", s("Red")])]))],
      ["total_results", i(7)],
      ["warning", arr(s("Timeout limit was reached"))],
    );
    const t = searchTable(reply)!;
    expect(t.total).toBe(7);
    expect(t.rows[0]!.id).toEqual({ enc: "base64", data: "/wA=" });
    expect(t.columns).toEqual(["title", "price"]);
    expect(t.warnings).toEqual(["Timeout limit was reached"]);
    expect(richKind(["FT.SEARCH", "idx", "*"], reply)).toBe("search");
  });

  it("FT.SEARCH RESP2 shapes, with and without content", () => {
    expect(searchTable(arr(i(2), s("a"), arr(s("f"), s("1")), s("b"), arr(s("f"), s("2"))))).toMatchObject({ total: 2, columns: ["f"], rows: [{ id: { data: "a" } }, { id: { data: "b" } }] });
    expect(searchTable(arr(i(2), s("a"), s("b")))!.rows.map((r) => r.id!.data)).toEqual(["a", "b"]);
    expect(searchTable(s("OK"))).toBeUndefined();
  });

  it("FT.AGGREGATE (RESP3 map, RESP2 arrays, WITHCURSOR)", () => {
    const resp3 = map(["results", arr(map(["extra_attributes", map(["category", s("tools"), ], ["n", s("2")])]))], ["total_results", i(1)]);
    expect(aggregateTable(resp3)).toMatchObject({ total: 1, columns: ["category", "n"] });
    expect(aggregateTable(arr(i(1), arr(s("category"), s("toys"), s("n"), s("1"))))).toMatchObject({ columns: ["category", "n"] });
    expect(aggregateTable(arr(resp3, i(42)))).toMatchObject({ cursor: "42" });
    expect(richKind(["FT.CURSOR", "READ", "idx", "42"], arr(resp3, i(0)))).toBe("aggregate");
  });

  it("TS.RANGE and TS.MRANGE become series (sorted, non-numeric values counted)", () => {
    const range = arr(arr(i(2000), d(2)), arr(i(1000), d(1)), arr(i(3000), s("nan?")));
    expect(seriesOf(range)).toMatchObject({ samples: [[1000, 1], [2000, 2]], dropped: 1 });
    expect(richKind(["TS.REVRANGE", "k", "-", "+"], range)).toBe("series");
    const resp3 = map(["t:a", arr(map(["room", s("kitchen")]), arr(), arr(arr(i(1), d(5))))], ["t:b", arr(map(), arr(), arr(arr(i(1), d(6)), arr(i(2), d(7))))]);
    expect(multiSeriesOf(resp3)).toMatchObject({
      total: 2,
      series: [
        { name: "t:a", labels: [["room", "kitchen"]], samples: [[1, 5]] },
        { name: "t:b", samples: [[1, 6], [2, 7]] },
      ],
    });
    const resp2 = arr(arr(s("t:a"), arr(arr(s("room"), s("office"))), arr(arr(i(1), s("3.5")))));
    expect(multiSeriesOf(resp2)).toMatchObject({ total: 1, series: [{ name: "t:a", labels: [["room", "office"]], samples: [[1, 3.5]] }] });
    expect(richKind(["TS.RANGE", "k"], arr(s("x")))).toBeUndefined();
  });

  // Review v0.2.1 web M2: the bounds stay, and the readings report what they leave out.
  it("bounded readings count the series, rows and columns they leave out", () => {
    const thirteen = map(...Array.from({ length: 13 }, (_, n): [string, Reply] => [`s:${n}`, arr(map(["rw", s("1")]), arr(), arr(arr(i(1), d(n)), arr(i(2), d(n))))]));
    const set = multiSeriesOf(thirteen)!;
    expect(set.total).toBe(13);
    expect(set.series).toHaveLength(12);
    expect(set.series.map((x) => x.name)).not.toContain("s:12");
    const wide = map(["results", arr(map(["id", s("d")], ["extra_attributes", map(...Array.from({ length: 45 }, (_, n): [string, Reply] => [`f${n}`, s("v")]))]))], ["total_results", i(1)]);
    expect(searchTable(wide)).toMatchObject({ omittedColumns: 5, omittedRows: 0 });
    expect(searchTable(wide)!.columns).toHaveLength(40);
    const long = arr(i(1200), ...Array.from({ length: 1200 }, (_, n) => s(`d${n}`)));
    expect(searchTable(long)).toMatchObject({ omittedRows: 200, omittedColumns: 0 });
    expect(searchTable(long)!.rows).toHaveLength(1000);
  });

  it("FT.EXPLAIN text and FT.EXPLAINCLI lines become a plan tree", () => {
    const plan = explainPlan(s("INTERSECT {\n  UNION {\n    hello\n    +hello(expanded)\n  }\n  NUMERIC {3.000000 <= @n <= 4.000000}\n}\n"))!;
    expect(plan.label).toBe("INTERSECT");
    expect(plan.children.map((c) => c.label)).toEqual(["UNION", "NUMERIC {3.000000 <= @n <= 4.000000}"]);
    expect(plan.children[0]!.children.map((c) => c.label)).toEqual(["hello", "+hello(expanded)"]);
    expect(explainPlan(arr(s("INTERSECT {"), s("  a"), s("}")))!.children[0]!.label).toBe("a");
  });

  it("FT.PROFILE: results, timings, iterator tree and result processors", () => {
    const reply = map(
      ["Results", map(["results", arr(map(["id", s("d1")], ["extra_attributes", map(["t", s("x")])]))], ["total_results", i(1)])],
      [
        "Profile",
        map([
          "Shards",
          arr(
            map(
              ["Total profile time", d(0.5)],
              ["Parsing time", d(0.1)],
              ["Iterators profile", map(["Type", s("INTERSECT")], ["Time", d(0.2)], ["Counter", i(1)], ["Child iterators", arr(map(["Type", s("TEXT")], ["Term", s("hello")], ["Counter", i(3)]))])],
              ["Result processors profile", arr(map(["Type", s("Index")], ["Time", d(0.01)], ["Counter", i(1)]), map(["Type", s("Sorter")], ["Counter", i(1)]))],
            ),
          ),
        ]),
      ],
    );
    const p = profileView(reply)!;
    expect(p.results!.rows[0]!.id!.data).toBe("d1");
    expect(p.shards[0]!.facts).toEqual([["Total profile time", "0.5"], ["Parsing time", "0.1"]]);
    expect(p.shards[0]!.iterators).toMatchObject({ label: "INTERSECT", facts: [["Time", "0.2"], ["Counter", "1"]], children: [{ label: "TEXT hello", facts: [["Counter", "3"]] }] });
    expect(p.shards[0]!.processors.map((n) => n.label)).toEqual(["Index", "Sorter"]);
    expect(richKind(["FT.PROFILE", "i", "SEARCH", "QUERY", "*"], reply)).toBe("profile");
  });

  it("errors, truncated replies and other commands keep the generic view", () => {
    expect(richKind(["FT.SEARCH", "i", "*"], { t: "err", v: "ERR no such index" })).toBeUndefined();
    expect(richKind(["FT.SEARCH", "i", "*"], { t: "truncated", bytes: 10 })).toBeUndefined();
    expect(richKind(["GET", "k"], s("x"))).toBeUndefined();
  });
});
