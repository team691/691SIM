import { describe, expect, it } from 'vitest';
import {
  autoOrthogonalPath,
  buildSmoothWirePathD,
  computeWireRoutes,
  controlPointForRoute,
  estimateLabelBounds,
  fuseMarkerRect,
  fusePointForRoute,
  manhattanRoute,
  nearestPointOnPath,
  offsetManhattanPath,
  pointOnPathAtT,
  preferredDeviceSides,
  rectsOverlap,
  resolveLabelPositions,
  simplifyPath,
  snapOrthogonalPath,
  type Point,
  type Rect,
} from './wireRouting';
import type { Connection } from '@691sim/core';

function conn(id: string, src: string, tgt: string): Connection {
  return {
    id,
    sourceDevice: src,
    sourcePort: 'out',
    targetDevice: tgt,
    targetPort: 'in',
  };
}

describe('autoOrthogonalPath', () => {
  it('creates an L-shaped path instead of a straight diagonal', () => {
    const path = autoOrthogonalPath({ x: 0, y: 0 }, { x: 100, y: 80 }, 0);
    expect(path.length).toBeGreaterThanOrEqual(3);
    const hasHorizontal = path.some((p, i) => i > 0 && Math.abs(p.y - path[i - 1]!.y) < 0.5);
    const hasVertical = path.some((p, i) => i > 0 && Math.abs(p.x - path[i - 1]!.x) < 0.5);
    expect(hasHorizontal && hasVertical).toBe(true);
  });

  it('offsets parallel wires so they do not share the same corridor', () => {
    const a = autoOrthogonalPath({ x: 0, y: 0 }, { x: 120, y: 60 }, -18);
    const b = autoOrthogonalPath({ x: 0, y: 0 }, { x: 120, y: 60 }, 18);
    const midA = a[1]!;
    const midB = b[1]!;
    expect(Math.abs(midA.x - midB.x) + Math.abs(midA.y - midB.y)).toBeGreaterThan(10);
  });

  it('routes around device obstacles when possible', () => {
    const obstacle: Rect = { x: 40, y: -20, width: 80, height: 80 };
    const path = autoOrthogonalPath({ x: 0, y: 0 }, { x: 160, y: 0 }, 0, [obstacle]);
    expect(path.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildSmoothWirePathD', () => {
  it('renders Manhattan paths with slightly rounded corners by default', () => {
    const d = buildSmoothWirePathD([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 80 },
      { x: 100, y: 80 },
    ]);
    expect(d).toContain('Q');
    expect(d.startsWith('M 0 0')).toBe(true);
  });

  it('renders sharp corners when radius is zero', () => {
    const d = buildSmoothWirePathD(
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 80 },
        { x: 100, y: 80 },
      ],
      0,
    );
    expect(d).not.toContain('Q');
  });
});

describe('snapOrthogonalPath', () => {
  it('splits diagonal segments into horizontal and vertical parts', () => {
    const snapped = snapOrthogonalPath([
      { x: 0, y: 0 },
      { x: 100, y: 80 },
    ]);
    expect(snapped.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < snapped.length; i++) {
      const a = snapped[i - 1]!;
      const b = snapped[i]!;
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
    }
  });
});

describe('offsetManhattanPath', () => {
  it('keeps paired wire offsets axis-aligned', () => {
    const base = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ];
    const offset = offsetManhattanPath(base, 5);
    for (let i = 1; i < offset.length; i++) {
      const a = offset[i - 1]!;
      const b = offset[i]!;
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5).toBe(true);
    }
  });
});

describe('preferredDeviceSides', () => {
  it('exits right and enters left when target is to the right', () => {
    const src = { x: 0, y: 0, width: 100, height: 80 };
    const tgt = { x: 200, y: 0, width: 100, height: 80 };
    expect(preferredDeviceSides(src, tgt)).toEqual({ exit: 'right', enter: 'left' });
  });

  it('exits bottom and enters top when target is below', () => {
    const src = { x: 0, y: 0, width: 100, height: 80 };
    const tgt = { x: 0, y: 150, width: 100, height: 80 };
    expect(preferredDeviceSides(src, tgt)).toEqual({ exit: 'bottom', enter: 'top' });
  });
});

describe('manhattanRoute', () => {
  const srcBounds: Rect = { x: 0, y: 0, width: 168, height: 120 };
  const tgtBounds: Rect = { x: 280, y: 0, width: 168, height: 120 };

  it('routes orthogonally through device edges on different sides', () => {
    const { path, context } = manhattanRoute(
      { x: 84, y: 130 },
      { x: 364, y: 160 },
      srcBounds,
      tgtBounds,
      0,
      0,
    );
    expect(context?.exitSide).toBe('right');
    expect(context?.enterSide).toBe('left');
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const orth = Math.abs(a.x - b.x) < 1 || Math.abs(a.y - b.y) < 1;
      expect(orth).toBe(true);
    }
  });

  it('spreads bundled wires apart on the entry edge', () => {
    const a = manhattanRoute(
      { x: 84, y: 130 },
      { x: 364, y: 130 },
      srcBounds,
      tgtBounds,
      0,
      -26,
    );
    const b = manhattanRoute(
      { x: 84, y: 130 },
      { x: 364, y: 130 },
      srcBounds,
      tgtBounds,
      0,
      26,
    );
    const midA = a.path[Math.floor(a.path.length / 2)]!;
    const midB = b.path[Math.floor(b.path.length / 2)]!;
    expect(Math.hypot(midA.x - midB.x, midA.y - midB.y)).toBeGreaterThan(20);
  });
});

describe('controlPointForRoute', () => {
  it('returns the user waypoint projected onto the path', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 100 },
      { x: 100, y: 100 },
    ];
    const wp = { x: 48, y: 2 };
    const cp = controlPointForRoute(path, [wp], 'c1');
    expect(Math.hypot(cp.x - 50, cp.y - 0)).toBeLessThan(5);
  });

  it('places auto handle away from fuse midpoint', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const cp = controlPointForRoute(path, [], 'c1');
    const fuse = fusePointForRoute(path);
    expect(Math.hypot(cp.x - fuse.x, cp.y - fuse.y)).toBeGreaterThan(10);
  });
});

describe('nearestPointOnPath', () => {
  it('snaps cursor to the closest point on the wire', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const snapped = nearestPointOnPath(path, { x: 50, y: 40 });
    expect(snapped.y).toBeCloseTo(0, 0);
    expect(snapped.x).toBeCloseTo(50, 0);
  });
});

describe('pointOnPathAtT', () => {
  it('returns midpoint at t=0.5', () => {
    const mid = pointOnPathAtT(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      0.5,
    );
    expect(mid.x).toBeCloseTo(50, 0);
    expect(mid.y).toBeCloseTo(0, 0);
  });
});

describe('resolveLabelPositions', () => {
  it('separates overlapping label anchors', () => {
    const { positions } = resolveLabelPositions([
      { id: 'a', anchor: { x: 100, y: 100 }, text: 'PDH → SparkMax' },
      { id: 'b', anchor: { x: 102, y: 101 }, text: 'PDH → VRM' },
    ]);
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(8);
  });

  it('avoids a fuse marker obstacle', () => {
    const fusePoint = { x: 100, y: 100 };
    const fuse = fuseMarkerRect(fusePoint);
    const text = 'PDH → Motor';
    const { positions, crowded } = resolveLabelPositions(
      [{ id: 'a', anchor: fusePoint, text }],
      [{ rect: fuse, kind: 'fuse' }],
    );
    const pos = positions.get('a')!;
    const bounds = estimateLabelBounds(text);
    const left = pos.x - bounds.width / 2;
    const top = pos.y - bounds.height / 2;
    expect(rectsOverlap(bounds, left, top, fuse, fuse.x, fuse.y, 4)).toBe(false);
    expect(crowded.has('a')).toBe(false);
  });

  it('returns a least-overlap crowded result without throwing', () => {
    const wall: Rect = { x: 0, y: 0, width: 400, height: 400 };
    const { positions, crowded } = resolveLabelPositions(
      [
        { id: 'a', anchor: { x: 200, y: 200 }, text: 'Crowded A' },
        { id: 'b', anchor: { x: 200, y: 200 }, text: 'Crowded B' },
        { id: 'c', anchor: { x: 200, y: 200 }, text: 'Crowded C' },
      ],
      [{ rect: wall, kind: 'device' }],
    );
    expect(positions.size).toBe(3);
    expect(crowded.size).toBeGreaterThan(0);
    for (const id of ['a', 'b', 'c']) {
      expect(positions.get(id)).toBeDefined();
    }
  });

  it('is deterministic for the same input', () => {
    const labels = [
      { id: 'z', anchor: { x: 50, y: 50 }, text: 'Z label' },
      { id: 'a', anchor: { x: 52, y: 51 }, text: 'A label' },
      { id: 'm', anchor: { x: 48, y: 53 }, text: 'M label' },
    ];
    const obstacles = [{ rect: { x: 40, y: 40, width: 30, height: 20 }, kind: 'fuse' as const }];
    const first = resolveLabelPositions(labels, obstacles);
    const second = resolveLabelPositions(labels, obstacles);
    expect([...first.positions.entries()]).toEqual([...second.positions.entries()]);
    expect([...first.crowded].sort()).toEqual([...second.crowded].sort());
  });
});

describe('computeWireRoutes', () => {
  const getCenter = (id: string): Point => {
    const map: Record<string, Point> = {
      a: { x: 50, y: 50 },
      b: { x: 250, y: 50 },
      c: { x: 150, y: 200 },
    };
    return map[id] ?? { x: 0, y: 0 };
  };

  const getBounds = (id: string): Rect => {
    const map: Record<string, Rect> = {
      a: { x: 0, y: 0, width: 168, height: 120 },
      b: { x: 220, y: 0, width: 168, height: 120 },
      c: { x: 100, y: 180, width: 168, height: 120 },
    };
    return map[id] ?? { x: 0, y: 0, width: 168, height: 120 };
  };

  it('auto-routes multiple wires on different corridors', () => {
    const connections = [conn('c1', 'a', 'b'), conn('c2', 'a', 'c')];
    const routes = computeWireRoutes(connections, getCenter, undefined, undefined, undefined, getBounds);
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route.path.length).toBeGreaterThanOrEqual(2);
      expect(route.controlPoint).toBeDefined();
    }
    const dist = Math.hypot(
      routes[0]!.controlPoint.x - routes[1]!.controlPoint.x,
      routes[0]!.controlPoint.y - routes[1]!.controlPoint.y,
    );
    expect(dist).toBeGreaterThan(0);
  });

  it('preserves manual waypoints when set', () => {
    const connections: Connection[] = [
      {
        ...conn('c1', 'a', 'b'),
        metadata: { waypoints: [{ x: 150, y: 120 }] },
      },
    ];
    const routes = computeWireRoutes(connections, getCenter);
    expect(routes[0]!.path.some((p) => p.x === 150 && p.y === 120)).toBe(true);
    expect(routes[0]!.controlPoint).toEqual({ x: 150, y: 120 });
    expect(routes[0]!.fusePoint).toBeDefined();
  });
});

describe('simplifyPath', () => {
  it('removes collinear middle points', () => {
    const simplified = simplifyPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(simplified).toHaveLength(2);
  });
});
