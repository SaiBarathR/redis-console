/**
 * Geo results on a map (v0.4, RI parity F11): GEOSEARCH / GEORADIUS* WITHCOORD and GEOPOS.
 *
 * Offline by design (AGENTS.md hard rule 11): an SVG in an equirectangular frame over a bundled public-domain land
 * outline (Natural Earth 1:110m, loaded on first use), no tiles, no fetches. Member names are rendered as text only.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { displayBin, visibleText } from "../lib/format.ts";
import type { GeoPoint, GeoView } from "../lib/richReply.ts";

/** The outline's unit: tenths of a degree, x = (lon + 180) * 10, y = (90 - lat) * 10. */
const px = (lon: number) => (lon + 180) * 10;
const py = (lat: number) => (90 - lat) * 10;
const WORLD: Box = { x: 0, y: 0, w: 3600, h: 1800 };
const M_PER_DEGREE = 111_320;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pointName(p: GeoPoint): string {
  return p.member ? displayBin(p.member, 120) : visibleText(p.label ?? "");
}

/** The area to show: every point (and the search area), padded, at least 2 degrees across, inside the world. */
export function fitBox(view: Pick<GeoView, "points" | "center" | "radiusM" | "boxM">): Box {
  const xs = view.points.map((p) => px(p.lon));
  const ys = view.points.map((p) => py(p.lat));
  if (view.center) {
    const { dLon, dLat } = areaDegrees(view);
    xs.push(px(view.center.lon - dLon), px(view.center.lon + dLon));
    ys.push(py(view.center.lat + dLat), py(view.center.lat - dLat));
  }
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  const padX = Math.max((maxX - minX) * 0.15, 10);
  const padY = Math.max((maxY - minY) * 0.15, 10);
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;
  // Keep a landscape frame so a single point or a north-south line still shows its surroundings.
  const w = Math.max(maxX - minX, (maxY - minY) * 1.6, 20);
  const h = Math.max(maxY - minY, w / 2.2);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const box = { x: cx - w / 2, y: cy - h / 2, w, h };
  if (box.w >= WORLD.w || box.h >= WORLD.h) return WORLD;
  box.x = Math.min(Math.max(box.x, 0), WORLD.w - box.w);
  box.y = Math.min(Math.max(box.y, 0), WORLD.h - box.h);
  return box;
}

/** Half-extent of the search area in degrees (approximate on this projection). */
function areaDegrees(view: Pick<GeoView, "center" | "radiusM" | "boxM">): { dLon: number; dLat: number } {
  if (!view.center) return { dLon: 0, dLat: 0 };
  const cos = Math.max(Math.cos((view.center.lat * Math.PI) / 180), 0.01);
  if (view.radiusM) return { dLat: view.radiusM / M_PER_DEGREE, dLon: view.radiusM / (M_PER_DEGREE * cos) };
  if (view.boxM) return { dLat: view.boxM.height / 2 / M_PER_DEGREE, dLon: view.boxM.width / 2 / (M_PER_DEGREE * cos) };
  return { dLon: 0, dLat: 0 };
}

/** Grid lines every `step` degrees, chosen so about four to eight fit across the view. */
function graticule(box: Box): { step: number; lons: number[]; lats: number[] } {
  const spanDeg = box.w / 10;
  const step = [90, 30, 10, 5, 2, 1, 0.5, 0.2, 0.1].find((s) => spanDeg / s >= 4) ?? 0.1;
  const lons: number[] = [];
  const lats: number[] = [];
  for (let lon = Math.ceil((box.x / 10 - 180) / step) * step; px(lon) <= box.x + box.w; lon += step) lons.push(lon);
  for (let lat = Math.floor((90 - box.y / 10) / step) * step; py(lat) <= box.y + box.h; lat -= step) lats.push(lat);
  return { step, lons, lats };
}

const fmt = (n: number) => n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");

export function GeoMap({ view }: { view: GeoView }) {
  const [land, setLand] = useState<string>();
  const [world, setWorld] = useState(false);
  const [selected, setSelected] = useState<number>();
  useEffect(() => {
    let live = true;
    void import("../assets/world-110m.ts").then((m) => live && setLand(m.WORLD_110M_PATH));
    return () => {
      live = false;
    };
  }, []);
  const fitted = useMemo(() => fitBox(view), [view]);
  const box = world ? WORLD : fitted;
  const grid = useMemo(() => graticule(box), [box]);
  const r = box.w / 170;
  const area = areaDegrees(view);
  const select = (i: number) => setSelected((s) => (s === i ? undefined : i));
  const key = (i: number) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(i);
    }
  };
  const chosen = selected !== undefined ? view.points[selected] : undefined;
  return (
    <div className="geo-map" data-testid="geo-map">
      <div className="rich-meta">
        <span data-testid="geo-count">
          {view.points.length.toLocaleString()} {view.points.length === 1 ? "point" : "points"}
        </span>
        {view.center && (
          <span>
            Centre {fmt(view.center.lat)}, {fmt(view.center.lon)}
            {view.radiusM ? ` · radius ${(view.radiusM / 1000).toLocaleString()} km` : ""}
            {view.boxM ? ` · box ${(view.boxM.width / 1000).toLocaleString()} × ${(view.boxM.height / 1000).toLocaleString()} km` : ""}
            {(view.radiusM || view.boxM) && " (outline approximate)"}
          </span>
        )}
        {view.omitted > 0 && <span className="warn-text">{view.omitted.toLocaleString()} more not drawn (use the raw reply)</span>}
        {view.missing.length > 0 && <span className="warn-text">Not found: {view.missing.slice(0, 5).map(visibleText).join(", ")}{view.missing.length > 5 ? "…" : ""}</span>}
        <span className="geo-actions">
          <button type="button" className="ghost" aria-pressed={!world} onClick={() => setWorld(false)} data-testid="geo-fit">
            Fit points
          </button>
          <button type="button" className="ghost" aria-pressed={world} onClick={() => setWorld(true)} data-testid="geo-world">
            World
          </button>
        </span>
      </div>
      <svg
        className="geo-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Map of ${view.points.length} points`}
      >
        <rect className="geo-sea" x={0} y={0} width={WORLD.w} height={WORLD.h} />
        {land && <path className="geo-land" d={land} data-testid="geo-land" />}
        <g className="geo-grid" aria-hidden="true">
          {grid.lons.map((lon) => (
            <line key={`x${lon}`} x1={px(lon)} x2={px(lon)} y1={0} y2={WORLD.h} />
          ))}
          {grid.lats.map((lat) => (
            <line key={`y${lat}`} x1={0} x2={WORLD.w} y1={py(lat)} y2={py(lat)} />
          ))}
        </g>
        {view.center && (
          <g className="geo-area" aria-hidden="true">
            {view.radiusM ? <ellipse cx={px(view.center.lon)} cy={py(view.center.lat)} rx={area.dLon * 10} ry={area.dLat * 10} /> : null}
            {view.boxM ? <rect x={px(view.center.lon - area.dLon)} y={py(view.center.lat + area.dLat)} width={area.dLon * 20} height={area.dLat * 20} /> : null}
            <circle className="geo-center" cx={px(view.center.lon)} cy={py(view.center.lat)} r={r * 0.6} />
          </g>
        )}
        {view.points.map((p, i) => (
          <circle
            key={i}
            className={i === selected ? "geo-point selected" : "geo-point"}
            cx={px(p.lon)}
            cy={py(p.lat)}
            r={i === selected ? r * 1.6 : r}
            tabIndex={0}
            role="button"
            aria-pressed={i === selected}
            aria-label={`${pointName(p)}: latitude ${fmt(p.lat)}, longitude ${fmt(p.lon)}`}
            data-testid="geo-point"
            onClick={() => select(i)}
            onKeyDown={key(i)}
          >
            <title>{pointName(p)}</title>
          </circle>
        ))}
        {chosen && (
          <text className="geo-label" x={px(chosen.lon) + r * 2} y={py(chosen.lat) - r * 2} fontSize={r * 4}>
            {pointName(chosen)}
          </text>
        )}
      </svg>
      <div className="table-wrap dense rich-scroll">
        <table className="geo-table" aria-label="Points" data-testid="geo-table">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col" className="num">Latitude</th>
              <th scope="col" className="num">Longitude</th>
              {view.points.some((p) => p.dist !== undefined) && <th scope="col" className="num">Distance{view.unit ? ` (${view.unit})` : ""}</th>}
            </tr>
          </thead>
          <tbody>
            {view.points.map((p, i) => (
              <tr key={i} className={i === selected ? "selected" : undefined} onClick={() => select(i)} data-testid="geo-row">
                <td className="data">{pointName(p)}</td>
                <td className="data num">{fmt(p.lat)}</td>
                <td className="data num">{fmt(p.lon)}</td>
                {view.points.some((q) => q.dist !== undefined) && <td className="data num">{p.dist !== undefined ? visibleText(p.dist) : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
