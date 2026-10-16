import type { Connection } from '@691sim/core';
import { PortType } from '@691sim/core';
import { resolveConnectionPortType } from './wireStyles';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoutedSegment {
  connectionId: string;
  start: Point;
  end: Point;
  bundleOffset: number;
  waypoints: Point[];
  path: Point[];
  controlPoint: Point;
  fusePoint: Point;
  labelPoint: Point;
  routeContext?: ManhattanRouteContext;
}

export interface ManhattanRouteContext {
  srcBounds: Rect;
  tgtBounds: Rect;
  exitSide: DeviceSide;
  enterSide: DeviceSide;
  laneOffset: number;
  bundleSpread: number;
  obstacles: Rect[];
}

export interface LabelPlacementRequest {
  id: string;
  anchor: Point;
  text: string;
  detail?: string;
  /** Own wire segments with this id are not treated as obstacles. */
  connectionId?: string;
}

/** Rect obstacle for label placement. Own-wire obstacles are skipped per label. */
export interface LabelObstacle {
  rect: Rect;
  /** When set, labels for this connection ignore the obstacle (their own wire). */
  connectionId?: string;
  kind?: 'device' | 'fuse' | 'ampacity' | 'caption' | 'wire' | 'other';
}

export interface LabelPlacementResult {
  positions: Map<string, Point>;
  /** Labels that could not find a free slot (least-overlap fallback used). */
  crowded: Set<string>;
}

type RegistryLookup = {
  get(type: string): { ports: { id: string; type: PortType }[] } | undefined;
};

export type PortPositionLookup = (
  deviceId: string,
  portId: string,
) => Point | undefined;

export type DeviceBoundsLookup = (deviceId: string) => Rect | undefined;

const BUNDLE_SPACING = 26;
const LANE_SPACING = 26;
const MIN_WIRE_GAP = 16;
const OBSTACLE_MARGIN = 10;
const ALIGN_THRESHOLD = 10;
const CORNER_RADIUS = 8;
const STUB_LENGTH = 28;

export type DeviceSide = 'top' | 'bottom' | 'left' | 'right';

/** Connections drawn on the canvas (ground is implied by the red/black 12V pair). */
export function getDisplayConnections(
  connections: Connection[],
  registry: RegistryLookup,
  deviceTypeById: Map<string, string>,
): Connection[] {
  return connections.filter((conn) => {
    const srcType = deviceTypeById.get(conn.sourceDevice);
    if (!srcType) return true;
    const portType =
      resolveConnectionPortType(registry, conn.sourceDevice, srcType, conn.sourcePort) ??
      PortType.POWER;
    return portType !== PortType.GROUND;
  });
}

function bundleKey(a: string, b: string, portType: PortType): string {
  const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
  return `${pair}:${portType}`;
}

function parseWaypoints(connection: Connection): Point[] {
  const raw = connection.metadata?.waypoints;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((wp) => {
      if (typeof wp !== 'object' || wp === null) return null;
      const x = Number((wp as { x?: unknown }).x);
      const y = Number((wp as { y?: unknown }).y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    })
    .filter((wp): wp is Point => wp !== null);
}

function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return len;
}

function pointsEqual(a: Point, b: Point, eps = 0.5): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

/** Force path segments to be axis-aligned (fix diagonal artifacts). */
export function snapOrthogonalPath(path: Point[]): Point[] {
  if (path.length < 2) return path;

  const snapped = path.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const out: Point[] = [snapped[0]!];

  for (let i = 1; i < snapped.length; i++) {
    const prev = out[out.length - 1]!;
    const curr = snapped[i]!;
    const dx = Math.abs(prev.x - curr.x);
    const dy = Math.abs(prev.y - curr.y);

    if (dx > 0.5 && dy > 0.5) {
      out.push({ x: curr.x, y: prev.y });
    }
    if (!pointsEqual(out[out.length - 1]!, curr)) {
      out.push(curr);
    }
  }

  return simplifyPath(out);
}

function offsetSegmentEndpoint(a: Point, b: Point, t: 0 | 1, offset: number): Point {
  const p = t === 0 ? a : b;
  if (Math.abs(a.y - b.y) < 0.5) return { x: p.x, y: p.y + offset };
  if (Math.abs(a.x - b.x) < 0.5) return { x: p.x + offset, y: p.y };
  return p;
}

/** Parallel-offset a Manhattan path without introducing diagonal segments. */
export function offsetManhattanPath(path: Point[], offset: number): Point[] {
  if (offset === 0 || path.length < 2) return snapOrthogonalPath(path);

  const orth = snapOrthogonalPath(path);
  const out: Point[] = [];

  for (let i = 0; i < orth.length - 1; i++) {
    const a = orth[i]!;
    const b = orth[i + 1]!;
    const start = offsetSegmentEndpoint(a, b, 0, offset);
    const end = offsetSegmentEndpoint(a, b, 1, offset);

    if (out.length === 0) {
      out.push(start, end);
      continue;
    }

    const prev = out[out.length - 1]!;
    if (pointsEqual(prev, start)) {
      out.push(end);
      continue;
    }

    const corner = {
      x: Math.abs(a.x - b.x) < 0.5 ? start.x : prev.x,
      y: Math.abs(a.y - b.y) < 0.5 ? start.y : prev.y,
    };
    if (!pointsEqual(prev, corner)) out.push(corner);
    if (!pointsEqual(corner, start) && !pointsEqual(corner, end)) out.push(start);
    out.push(end);
  }

  return simplifyPath(out);
}

/** Remove duplicate and collinear points. */
export function simplifyPath(path: Point[]): Point[] {
  if (path.length <= 2) return path;
  const out: Point[] = [path[0]!];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const curr = path[i]!;
    const next = path[i + 1]!;
    const collinearH = Math.abs(prev.y - curr.y) < 0.5 && Math.abs(curr.y - next.y) < 0.5;
    const collinearV = Math.abs(prev.x - curr.x) < 0.5 && Math.abs(curr.x - next.x) < 0.5;
    if (collinearH || collinearV) continue;
    if (!pointsEqual(prev, curr)) out.push(curr);
  }
  const last = path[path.length - 1]!;
  if (!pointsEqual(out[out.length - 1]!, last)) out.push(last);
  return out;
}

/** Point at fraction t (0–1) along a polyline. */
export function pointOnPathAtT(path: Point[], t: number): Point {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return path[0]!;
  const total = polylineLength(path);
  if (total === 0) return path[0]!;
  const target = Math.max(0, Math.min(1, t)) * total;
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + seg >= target) {
      const local = seg === 0 ? 0 : (target - walked) / seg;
      return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
    }
    walked += seg;
  }
  return path[path.length - 1]!;
}

/** Closest point on a polyline to an arbitrary cursor position. */
export function nearestPointOnPath(path: Point[], cursor: Point): Point {
  if (path.length === 0) return cursor;
  if (path.length === 1) return path[0]!;

  let best = path[0]!;
  let bestDist = Infinity;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t =
      lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / lenSq));
    const p = { x: a.x + dx * t, y: a.y + dy * t };
    const dist = Math.hypot(cursor.x - p.x, cursor.y - p.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }

  return best;
}

/** Midpoint along a polyline (for labels). */
export function labelPointOnPath(path: Point[]): Point {
  return pointOnPathAtT(path, 0.5);
}

/** Fuse marker sits at the wire midpoint. */
export function fusePointForRoute(path: Point[]): Point {
  return pointOnPathAtT(path, 0.5);
}

/** Handle on the wire, away from the fuse at t=0.5. */
export function controlPointForRoute(path: Point[], waypoints: Point[], connectionId = ''): Point {
  if (waypoints.length > 0) {
    return nearestPointOnPath(path, waypoints[0]!);
  }
  const t = connectionId.charCodeAt(connectionId.length - 1)! % 2 === 0 ? 0.35 : 0.65;
  return pointOnPathAtT(path, t);
}

function expandRect(rect: Rect, margin: number): Rect {
  return {
    x: rect.x - margin,
    y: rect.y - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

function segmentIntersectsRect(p1: Point, p2: Point, rect: Rect): boolean {
  const r = expandRect(rect, OBSTACLE_MARGIN);
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  if (maxX < r.x || minX > r.x + r.width) return false;
  if (maxY < r.y || minY > r.y + r.height) return false;

  const vertical = Math.abs(p1.x - p2.x) < 0.5;
  const horizontal = Math.abs(p1.y - p2.y) < 0.5;

  if (vertical) {
    const x = p1.x;
    return x >= r.x && x <= r.x + r.width && maxY >= r.y && minY <= r.y + r.height;
  }
  if (horizontal) {
    const y = p1.y;
    return y >= r.y && y <= r.y + r.height && maxX >= r.x && minX <= r.x + r.width;
  }

  return true;
}

function pathHitsObstacles(path: Point[], obstacles: Rect[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (obstacles.some((obs) => segmentIntersectsRect(a, b, obs))) return true;
  }
  return false;
}

function nudgeCandidate(base: number, attempt: number, step: number): number {
  if (attempt === 0) return base;
  const magnitude = Math.ceil(attempt / 2) * step;
  return attempt % 2 === 1 ? base + magnitude : base - magnitude;
}

/** Pick exit/enter sides so the wire approaches each device from different edges when possible. */
export function preferredDeviceSides(srcBounds: Rect, tgtBounds: Rect): {
  exit: DeviceSide;
  enter: DeviceSide;
} {
  const srcCx = srcBounds.x + srcBounds.width / 2;
  const srcCy = srcBounds.y + srcBounds.height / 2;
  const tgtCx = tgtBounds.x + tgtBounds.width / 2;
  const tgtCy = tgtBounds.y + tgtBounds.height / 2;
  const dx = tgtCx - srcCx;
  const dy = tgtCy - srcCy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { exit: 'right', enter: 'left' } : { exit: 'left', enter: 'right' };
  }
  return dy >= 0 ? { exit: 'bottom', enter: 'top' } : { exit: 'top', enter: 'bottom' };
}

/** Point outside the device on the given side, with spread for bundled wires. */
export function edgeExitPoint(
  port: Point,
  bounds: Rect,
  side: DeviceSide,
  spread: number,
): Point {
  switch (side) {
    case 'right':
      return { x: bounds.x + bounds.width + STUB_LENGTH, y: port.y + spread };
    case 'left':
      return { x: bounds.x - STUB_LENGTH, y: port.y + spread };
    case 'bottom':
      return { x: port.x + spread, y: bounds.y + bounds.height + STUB_LENGTH };
    case 'top':
      return { x: port.x + spread, y: bounds.y - STUB_LENGTH };
  }
}

function connectPortToEdge(port: Point, edge: Point): Point[] {
  if (pointsEqual(port, edge)) return [port];
  if (Math.abs(port.x - edge.x) < 1) return [port, edge];
  if (Math.abs(port.y - edge.y) < 1) return [port, edge];
  return simplifyPath([port, { x: edge.x, y: port.y }, edge]);
}

/**
 * Manhattan route: port → device edge → orthogonal corridor → opposite edge → port.
 * Wires leave and enter devices on different sides when geometry allows.
 */
export function manhattanRoute(
  startPort: Point,
  endPort: Point,
  srcBounds: Rect | undefined,
  tgtBounds: Rect | undefined,
  laneOffset: number,
  bundleSpread: number,
  obstacles: Rect[] = [],
): { path: Point[]; context?: ManhattanRouteContext } {
  if (!srcBounds || !tgtBounds) {
    return { path: autoOrthogonalPath(startPort, endPort, laneOffset, obstacles) };
  }

  const { exit: exitSide, enter: enterSide } = preferredDeviceSides(srcBounds, tgtBounds);
  const startExit = edgeExitPoint(startPort, srcBounds, exitSide, bundleSpread);
  const endExit = edgeExitPoint(endPort, tgtBounds, enterSide, bundleSpread);

  const toExit = connectPortToEdge(startPort, startExit);
  const corridor = autoOrthogonalPath(startExit, endExit, laneOffset, obstacles);
  const fromEnter = connectPortToEdge(endExit, endPort);

  const path = snapOrthogonalPath(
    simplifyPath([...toExit, ...corridor.slice(1), ...fromEnter.slice(1)]),
  );

  return {
    path,
    context: {
      srcBounds,
      tgtBounds,
      exitSide,
      enterSide,
      laneOffset,
      bundleSpread,
      obstacles,
    },
  };
}

function rerouteManhattan(route: RoutedSegment, laneOffset: number, bundleSpread: number): void {
  const ctx = route.routeContext;
  if (!ctx) {
    const path = autoOrthogonalPath(route.start, route.end, laneOffset, []);
    route.path = path;
    route.bundleOffset = bundleSpread;
  } else {
    const { path, context } = manhattanRoute(
      route.start,
      route.end,
      ctx.srcBounds,
      ctx.tgtBounds,
      laneOffset,
      bundleSpread,
      ctx.obstacles,
    );
    route.path = path;
    route.routeContext = context;
    route.bundleOffset = bundleSpread;
  }
  route.controlPoint = controlPointForRoute(route.path, route.waypoints, route.connectionId);
  route.fusePoint = fusePointForRoute(route.path);
  route.labelPoint = labelPointOnPath(route.path);
  route.path = snapOrthogonalPath(route.path);
}

/**
 * Orthogonal autoroute: horizontal-vertical or vertical-horizontal with lane offset
 * so parallel wires do not fully overlap.
 */
export function autoOrthogonalPath(
  start: Point,
  end: Point,
  laneOffset: number,
  obstacles: Rect[] = [],
): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (Math.hypot(dx, dy) < 4) return [start, end];

  const alignedH = Math.abs(dy) < ALIGN_THRESHOLD;
  const alignedV = Math.abs(dx) < ALIGN_THRESHOLD;

  if (alignedH) {
    const straight = simplifyPath([start, end]);
    if (!pathHitsObstacles(straight, obstacles)) return straight;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const detourY = nudgeCandidate(start.y, attempt, LANE_SPACING * 2);
      const path = simplifyPath([
        start,
        { x: start.x, y: detourY },
        { x: end.x, y: detourY },
        end,
      ]);
      if (!pathHitsObstacles(path, obstacles)) return path;
    }
  }

  if (alignedV) {
    const straight = simplifyPath([start, end]);
    if (!pathHitsObstacles(straight, obstacles)) return straight;
    for (let attempt = 1; attempt <= 12; attempt++) {
      const detourX = nudgeCandidate(start.x, attempt, LANE_SPACING * 2);
      const path = simplifyPath([
        start,
        { x: detourX, y: start.y },
        { x: detourX, y: end.y },
        end,
      ]);
      if (!pathHitsObstacles(path, obstacles)) return path;
    }
  }

  const preferHorizontal = Math.abs(dx) >= Math.abs(dy);
  const step = LANE_SPACING * 2;

  for (let attempt = 0; attempt < 24; attempt++) {
    const offset = nudgeCandidate(laneOffset, attempt, step);
    let path: Point[];

    if (preferHorizontal) {
      const midX = start.x + dx / 2 + offset;
      path = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    } else {
      const midY = start.y + dy / 2 + offset;
      path = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
    }

    path = simplifyPath(path);
    if (!pathHitsObstacles(path, obstacles)) return path;
  }

  if (preferHorizontal) {
    const midX = start.x + dx / 2 + laneOffset;
    return simplifyPath([start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]);
  }
  const midY = start.y + dy / 2 + laneOffset;
  return simplifyPath([start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]);
}

function segmentKey(p1: Point, p2: Point): string {
  const a = `${Math.round(p1.x)}:${Math.round(p1.y)}`;
  const b = `${Math.round(p2.x)}:${Math.round(p2.y)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function applyCorridorDeconfliction(routes: RoutedSegment[]): void {
  const usage = new Map<string, string[]>();

  for (const route of routes) {
    for (let i = 1; i < route.path.length; i++) {
      const key = segmentKey(route.path[i - 1]!, route.path[i]!);
      const ids = usage.get(key) ?? [];
      ids.push(route.connectionId);
      usage.set(key, ids);
    }
  }

  for (const [, ids] of usage) {
    if (ids.length <= 1) continue;
    const sorted = [...ids].sort();
    sorted.forEach((id, index) => {
      const route = routes.find((r) => r.connectionId === id);
      if (!route || route.waypoints.length > 0) return;
      const extra = (index - (sorted.length - 1) / 2) * LANE_SPACING;
      if (Math.abs(extra) < 0.1) return;
      rerouteManhattan(
        route,
        (route.routeContext?.laneOffset ?? 0) + extra,
        route.bundleOffset + extra,
      );
    });
  }
}

/** Push apart routes whose middle segments run too close together. */
function applyWireSeparation(routes: RoutedSegment[]): void {
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const a = routes[i]!;
      const b = routes[j]!;
      if (a.waypoints.length > 0 || b.waypoints.length > 0) continue;

      const aMid = a.controlPoint;
      const bMid = b.controlPoint;
      const dist = Math.hypot(aMid.x - bMid.x, aMid.y - bMid.y);
      if (dist >= MIN_WIRE_GAP * 2 || dist < 0.01) continue;

      const push = ((MIN_WIRE_GAP * 2 - dist) / 2) * 1.2;
      const laneA = (a.routeContext?.laneOffset ?? a.bundleOffset) - push;
      const laneB = (b.routeContext?.laneOffset ?? b.bundleOffset) + push;
      const spreadA = a.bundleOffset - push;
      const spreadB = b.bundleOffset + push;

      rerouteManhattan(a, laneA, spreadA);
      rerouteManhattan(b, laneB, spreadB);
    }
  }
}

const LABEL_FONT_PRIMARY = '600 9px ui-sans-serif, system-ui, sans-serif';
const LABEL_FONT_DETAIL = '400 7.5px ui-sans-serif, system-ui, sans-serif';
const LABEL_PAD_X = 10;
const LABEL_MIN_WIDTH = 40;
const LABEL_LINE_HEIGHT = 11;
const LABEL_PAD_Y = 6;

const LABEL_RING_STEP = 12;
const LABEL_MAX_RADIUS = 96;
const LABEL_ANGLE_STEP_DEG = 45;

const FUSE_MARKER_W = 36;
const FUSE_MARKER_H = 20;
const AMPACITY_MARKER_W = 18;
const AMPACITY_MARKER_H = 16;
const CAPTION_HEIGHT = 16;
const WIRE_OBSTACLE_THICKNESS = 4;

const textWidthCache = new Map<string, number>();
let measureCtx: { font: string; measureText(text: string): { width: number } } | null | undefined;

function getMeasureContext(): typeof measureCtx {
  if (measureCtx !== undefined) return measureCtx;
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(1, 1);
      measureCtx = canvas.getContext('2d');
      return measureCtx;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      measureCtx = canvas.getContext('2d');
      return measureCtx;
    }
  } catch {
    /* fall through */
  }
  measureCtx = null;
  return null;
}

/** Measured text width with cache; falls back to chars × 5.5 when no canvas exists (e.g. vitest). */
export function measureLabelTextWidth(text: string, font: string = LABEL_FONT_PRIMARY): number {
  const key = `${font}\0${text}`;
  const cached = textWidthCache.get(key);
  if (cached != null) return cached;

  const ctx = getMeasureContext();
  let width: number;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(text).width;
  } else {
    width = text.length * 5.5;
  }
  textWidthCache.set(key, width);
  return width;
}

/** Clear the measureText cache (tests). */
export function clearLabelTextWidthCache(): void {
  textWidthCache.clear();
}

export function estimateLabelBounds(text: string, detail?: string): Rect {
  const primaryW = measureLabelTextWidth(text, LABEL_FONT_PRIMARY);
  const detailW = detail ? measureLabelTextWidth(detail, LABEL_FONT_DETAIL) : 0;
  const lines = detail ? 2 : 1;
  const height = lines * LABEL_LINE_HEIGHT + LABEL_PAD_Y;
  const width = Math.max(primaryW, detailW, LABEL_MIN_WIDTH) + LABEL_PAD_X;
  return { x: 0, y: 0, width, height };
}

/** Fuse badge bounds (matches FuseMarker translate(x-18, y-10) + 36×20). */
export function fuseMarkerRect(fusePoint: Point): Rect {
  return {
    x: fusePoint.x - FUSE_MARKER_W / 2,
    y: fusePoint.y - FUSE_MARKER_H / 2,
    width: FUSE_MARKER_W,
    height: FUSE_MARKER_H,
  };
}

/** Ampacity hazard bounds (triangle roughly under the fuse point). */
export function ampacityMarkerRect(fusePoint: Point): Rect {
  return {
    x: fusePoint.x - AMPACITY_MARKER_W / 2,
    y: fusePoint.y + 14 - 9,
    width: AMPACITY_MARKER_W,
    height: AMPACITY_MARKER_H,
  };
}

/** Approximate HTML `.device-caption` under a device body. */
export function deviceCaptionRect(deviceBounds: Rect): Rect {
  return {
    x: deviceBounds.x,
    y: deviceBounds.y + deviceBounds.height + 2,
    width: deviceBounds.width,
    height: CAPTION_HEIGHT,
  };
}

/** Thin axis-aligned rects covering each wire segment. */
export function wireSegmentObstacles(
  path: Point[],
  connectionId: string,
  thickness = WIRE_OBSTACLE_THICKNESS,
): LabelObstacle[] {
  const half = thickness / 2;
  const out: LabelObstacle[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const minX = Math.min(a.x, b.x) - half;
    const maxX = Math.max(a.x, b.x) + half;
    const minY = Math.min(a.y, b.y) - half;
    const maxY = Math.max(a.y, b.y) + half;
    out.push({
      rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      connectionId,
      kind: 'wire',
    });
  }
  return out;
}

export function rectsOverlap(
  a: Rect,
  ax: number,
  ay: number,
  b: Rect,
  bx: number,
  by: number,
  pad = 6,
): boolean {
  return (
    ax - pad < bx + b.width + pad &&
    ax + a.width + pad > bx - pad &&
    ay - pad < by + b.height + pad &&
    ay + a.height + pad > by - pad
  );
}

function overlapArea(
  a: Rect,
  ax: number,
  ay: number,
  b: Rect,
  bx: number,
  by: number,
  pad = 0,
): number {
  const left = Math.max(ax - pad, bx - pad);
  const right = Math.min(ax + a.width + pad, bx + b.width + pad);
  const top = Math.max(ay - pad, by - pad);
  const bottom = Math.min(ay + a.height + pad, by + b.height + pad);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

function normalizeObstacles(obstacles: Array<Rect | LabelObstacle>): LabelObstacle[] {
  return obstacles.map((o) => ('rect' in o ? o : { rect: o, kind: 'device' as const }));
}

/** Deterministic candidate offsets: anchor, then expanding rings. */
export function labelRingOffsets(
  maxRadius = LABEL_MAX_RADIUS,
  ringStep = LABEL_RING_STEP,
  angleStepDeg = LABEL_ANGLE_STEP_DEG,
): Point[] {
  const offsets: Point[] = [{ x: 0, y: 0 }];
  for (let r = ringStep; r <= maxRadius; r += ringStep) {
    const denser = r >= ringStep * 3 ? angleStepDeg / 2 : angleStepDeg;
    for (let deg = 0; deg < 360; deg += denser) {
      const rad = (deg * Math.PI) / 180;
      offsets.push({
        x: Math.round(Math.cos(rad) * r),
        y: Math.round(Math.sin(rad) * r),
      });
    }
  }
  return offsets;
}

const RING_OFFSETS = labelRingOffsets();

/**
 * Place labels so they avoid devices, markers, captions, other wires, and each other.
 * Searches outward in rings; if nothing is free, picks the least-overlapping candidate
 * and marks the label as crowded (never silently pretends it is free).
 */
export function resolveLabelPositions(
  labels: LabelPlacementRequest[],
  obstacles: Array<Rect | LabelObstacle> = [],
): LabelPlacementResult {
  const positions = new Map<string, Point>();
  const crowded = new Set<string>();
  const placed: Array<{ rect: Rect; x: number; y: number }> = [];
  const baseObstacles = normalizeObstacles(obstacles);

  const sorted = [...labels].sort((a, b) => a.id.localeCompare(b.id));

  for (const label of sorted) {
    const bounds = estimateLabelBounds(label.text, label.detail);
    const ownId = label.connectionId ?? label.id;
    const activeObstacles = baseObstacles.filter(
      (obs) => !(obs.kind === 'wire' && obs.connectionId === ownId),
    );

    let bestFree: Point | null = null;
    let bestCrowded: Point = label.anchor;
    let bestOverlap = Infinity;

    for (const off of RING_OFFSETS) {
      const cx = label.anchor.x + off.x;
      const cy = label.anchor.y + off.y;
      const left = cx - bounds.width / 2;
      const top = cy - bounds.height / 2;

      let totalOverlap = 0;
      let hits = false;

      for (const obs of activeObstacles) {
        const pad = obs.kind === 'wire' ? 2 : 4;
        if (rectsOverlap(bounds, left, top, obs.rect, obs.rect.x, obs.rect.y, pad)) {
          hits = true;
          totalOverlap += overlapArea(bounds, left, top, obs.rect, obs.rect.x, obs.rect.y, pad);
        }
      }

      for (const p of placed) {
        if (rectsOverlap(bounds, left, top, p.rect, p.x, p.y, 8)) {
          hits = true;
          totalOverlap += overlapArea(bounds, left, top, p.rect, p.x, p.y, 8);
        }
      }

      if (!hits) {
        bestFree = { x: cx, y: cy };
        break;
      }

      if (totalOverlap < bestOverlap) {
        bestOverlap = totalOverlap;
        bestCrowded = { x: cx, y: cy };
      }
    }

    const chosen = bestFree ?? bestCrowded;
    if (bestFree == null) crowded.add(label.id);

    placed.push({
      rect: bounds,
      x: chosen.x - bounds.width / 2,
      y: chosen.y - bounds.height / 2,
    });
    positions.set(label.id, chosen);
  }

  return { positions, crowded };
}

/**
 * Spread wires that share the same device pair so they do not fully overlap.
 * Auto-routes orthogonally when no manual waypoints are set.
 */
export function computeWireRoutes(
  connections: Connection[],
  getCenter: (deviceId: string) => Point,
  getPortPosition?: PortPositionLookup,
  registry?: RegistryLookup,
  deviceTypeById?: Map<string, string>,
  getDeviceBounds?: DeviceBoundsLookup,
): RoutedSegment[] {
  const bundles = new Map<string, Connection[]>();

  for (const conn of connections) {
    const srcType = deviceTypeById?.get(conn.sourceDevice) ?? '';
    const portType =
      registry && deviceTypeById
        ? (resolveConnectionPortType(registry, conn.sourceDevice, srcType, conn.sourcePort) ??
          PortType.POWER)
        : PortType.POWER;
    const key = bundleKey(conn.sourceDevice, conn.targetDevice, portType);
    const group = bundles.get(key) ?? [];
    group.push(conn);
    bundles.set(key, group);
  }

  const globalSorted = [...connections].sort((a, b) => a.id.localeCompare(b.id));
  const globalIndex = new Map(globalSorted.map((c, i) => [c.id, i]));
  const globalCount = globalSorted.length;

  const routes: RoutedSegment[] = [];

  for (const group of bundles.values()) {
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const count = sorted.length;

    sorted.forEach((conn, index) => {
      const startPort =
        getPortPosition?.(conn.sourceDevice, conn.sourcePort) ??
        getCenter(conn.sourceDevice);
      const endPort =
        getPortPosition?.(conn.targetDevice, conn.targetPort) ?? getCenter(conn.targetDevice);
      const bundleSpread = count === 1 ? 0 : (index - (count - 1) / 2) * BUNDLE_SPACING;
      const waypoints = parseWaypoints(conn);

      const gi = globalIndex.get(conn.id) ?? 0;
      const laneOffset =
        (gi - (globalCount - 1) / 2) * LANE_SPACING + bundleSpread * 0.35;

      const srcBounds = getDeviceBounds?.(conn.sourceDevice);
      const tgtBounds = getDeviceBounds?.(conn.targetDevice);

      const allObstacles =
        getDeviceBounds != null
          ? [...new Set(connections.flatMap((c) => [c.sourceDevice, c.targetDevice]))]
              .filter((id) => id !== conn.sourceDevice && id !== conn.targetDevice)
              .map((id) => getDeviceBounds(id))
              .filter((r): r is Rect => r != null)
          : [];

      const routed =
        waypoints.length > 0
          ? {
              path: simplifyPath([startPort, ...waypoints, endPort]),
              context: undefined as ManhattanRouteContext | undefined,
            }
          : manhattanRoute(
              startPort,
              endPort,
              srcBounds,
              tgtBounds,
              laneOffset,
              bundleSpread,
              allObstacles,
            );

      const path = snapOrthogonalPath(
        waypoints.length > 0
          ? simplifyPath([startPort, ...waypoints, endPort])
          : routed.path,
      );

      routes.push({
        connectionId: conn.id,
        start: startPort,
        end: endPort,
        bundleOffset: bundleSpread,
        waypoints,
        path,
        controlPoint: controlPointForRoute(path, waypoints, conn.id),
        fusePoint: fusePointForRoute(path),
        labelPoint: labelPointOnPath(path),
        routeContext: routed.context,
      });
    });
  }

  applyCorridorDeconfliction(routes);
  applyWireSeparation(routes);
  return routes;
}

export function offsetLineEndpoints(
  start: Point,
  end: Point,
  bundleOffset: number,
): { start: Point; end: Point } {
  if (bundleOffset === 0) {
    return { start, end };
  }

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const perpX = (-dy / length) * bundleOffset;
  const perpY = (dx / length) * bundleOffset;

  return {
    start: { x: start.x + perpX, y: start.y + perpY },
    end: { x: end.x + perpX, y: end.y + perpY },
  };
}

/** @deprecated Use offsetManhattanPath for orthogonal routes. */
export function offsetPathPerpendicular(path: Point[], offset: number): Point[] {
  return offsetManhattanPath(path, offset);
}

/**
 * SVG path with rounded corners at bends. All vertices lie on the rendered wire.
 */
export function buildSmoothWirePathD(points: Point[], cornerRadius = CORNER_RADIUS): string {
  if (points.length < 2) return '';
  if (cornerRadius <= 0) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  }
  if (points.length === 2) {
    return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  }

  const r = cornerRadius;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const next = points[i + 1]!;

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y) || 1;
    const len2 = Math.hypot(v2x, v2y) || 1;
    const cr = Math.min(r, len1 / 2, len2 / 2);

    const p1x = curr.x - (v1x / len1) * cr;
    const p1y = curr.y - (v1y / len1) * cr;
    const p2x = curr.x + (v2x / len2) * cr;
    const p2y = curr.y + (v2y / len2) * cr;

    d += ` L ${p1x} ${p1y} Q ${curr.x} ${curr.y} ${p2x} ${p2y}`;
  }

  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** SVG polyline points string from a path. */
export function pathToPolylinePoints(path: Point[]): string {
  return path.map((p) => `${p.x},${p.y}`).join(' ');
}
