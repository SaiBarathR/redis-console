import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { token, useTheme } from "../lib/theme.ts";

/** Fill colour for a line: the stroke at low alpha (hex tokens only). */
function tint(hex: string, alpha: number) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "transparent";
  const n = Number.parseInt(match[1]!, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * A time series line (uPlot on canvas). Colours come from design tokens and follow the theme;
 * `color` is a token name such as "--signal" or "--type-stream".
 */
export function Chart({
  samples,
  label,
  unit = "",
  color = "--signal",
  height = 150,
  waiting = "Needs at least two samples to draw a line.",
}: {
  samples: [number, number][];
  label: string;
  unit?: string;
  color?: string;
  height?: number;
  /** Shown until there are two samples. */
  waiting?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | undefined>(undefined);
  const theme = useTheme();
  const ready = samples.length >= 2;
  useEffect(() => {
    if (!host.current || !ready) return;
    const element = host.current;
    // uPlot needs the content width: clientWidth includes the host's chart padding.
    const contentWidth = () => {
      const css = getComputedStyle(element);
      return Math.max(1, element.clientWidth - parseFloat(css.paddingLeft || "0") - parseFloat(css.paddingRight || "0"));
    };
    const stroke = token(color, "#3b3db4");
    const axis = token("--graphite", "#555e59");
    const grid = token("--rule", "#d2d8d2");
    const font = `11px ${token("--font-ui", "system-ui")}`;
    const instance = new uPlot(
      {
        width: contentWidth(),
        height,
        series: [
          {},
          {
            label,
            stroke,
            width: 1.5,
            fill: tint(stroke, 0.1),
            points: { show: false },
            value: (_, value) => `${value?.toLocaleString() ?? "—"}${unit}`,
          },
        ],
        axes: [
          {
            stroke: axis,
            grid: { show: false },
            ticks: { stroke: grid, width: 1 },
            font,
            size: 28,
            values: (_, ticks) =>
              ticks.map((t) =>
                new Date(t * 1000).toLocaleTimeString([], {
                  hour12: false,
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }),
              ),
          },
          {
            stroke: axis,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            font,
            size: 56,
          },
        ],
        // A single sample has no time span; show at least the last minute so tick labels stay distinct.
        scales: {
          x: {
            time: true,
            range: (_, min, max) =>
              max - min < 60 ? [max - 60, max] : [min, max],
          },
          // Flat series (steady memory) would otherwise get identical tick labels: keep a ±10% (min 1) span.
          y: {
            range: (_, min, max) => {
              const pad = Math.max(Math.abs(max) * 0.1, 1);
              return max - min < pad
                ? [Math.max(0, (min + max) / 2 - pad), (min + max) / 2 + pad]
                : [Math.min(0, min), max * 1.05];
            },
          },
        },
        legend: { show: false },
        cursor: { drag: { x: false, y: false }, points: { show: false } },
      },
      [samples.map((s) => s[0] / 1000), samples.map((s) => s[1])],
      element,
    );
    chart.current = instance;
    const resize = new ResizeObserver(() =>
      instance.setSize({ width: contentWidth(), height }),
    );
    resize.observe(element);
    return () => {
      resize.disconnect();
      instance.destroy();
      chart.current = undefined;
    };
    // Data updates do not recreate the chart; a theme switch does (colours are drawn on canvas).
  }, [label, unit, color, height, ready, theme]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance || samples.length < 2) return;
    instance.setData([samples.map((s) => s[0] / 1000), samples.map((s) => s[1])]);
    // Always show at least the last minute so time ticks stay distinct.
    const first = samples[0]![0] / 1000;
    const last = samples.at(-1)![0] / 1000;
    instance.setScale("x", { min: Math.min(first, last - 60), max: last });
  }, [samples]);
  const latest = samples.at(-1)?.[1];
  return (
    <div
      className="chart"
      ref={host}
      role="img"
      style={{ minHeight: ready ? height : 48 }}
      aria-label={`${label} chart. ${samples.length} samples. Latest: ${latest === undefined ? "waiting" : `${latest.toLocaleString()}${unit}`}`}
    >
      {!ready && (
        <div className="empty compact chart-wait">{waiting}</div>
      )}
    </div>
  );
}
