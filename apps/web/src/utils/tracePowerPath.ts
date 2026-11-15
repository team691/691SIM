import type { PowerEdge, WireCurrentResult } from '@691sim/simulation';

export interface PowerPathHop {
  connectionId: string;
  from: string;
  to: string;
  gauge: number;
  lengthInches: number;
  currentAmps: number;
  voltageDrop: number;
}

export type PowerPathResult =
  | {
      found: true;
      hops: PowerPathHop[];
      /** True when more than one simple path exists; hops are the shortest. */
      usedShortestOfMultiple: boolean;
    }
  | {
      found: false;
      reason: 'no-path';
    };

interface AdjEdge {
  neighbor: string;
  connectionId: string;
  /** Orientation as stored on the PowerEdge (from → to). */
  edgeFrom: string;
  edgeTo: string;
}

/**
 * Shortest directed-or-undirected hop path of power connections from the
 * battery to the target. Edges are traversed in either direction because the
 * model stores source→target port wiring, not solved current direction.
 * When multiple simple paths exist, the shortest (fewest hops) is returned
 * and `usedShortestOfMultiple` is set.
 */
export function tracePowerPath(
  powerEdges: readonly PowerEdge[],
  wireCurrents: readonly WireCurrentResult[],
  batteryId: string,
  targetId: string,
): PowerPathResult {
  if (batteryId === targetId) {
    return { found: true, hops: [], usedShortestOfMultiple: false };
  }

  const currentById = new Map(wireCurrents.map((wire) => [wire.connectionId, wire]));
  const adj = new Map<string, AdjEdge[]>();

  const add = (from: string, edge: AdjEdge) => {
    const list = adj.get(from) ?? [];
    list.push(edge);
    adj.set(from, list);
  };

  for (const edge of powerEdges) {
    const link: AdjEdge = {
      neighbor: edge.to,
      connectionId: edge.connectionId,
      edgeFrom: edge.from,
      edgeTo: edge.to,
    };
    add(edge.from, { ...link, neighbor: edge.to });
    add(edge.to, { ...link, neighbor: edge.from });
  }

  // BFS for one shortest path; also count whether any other simple path exists.
  type Step = { node: string; via: AdjEdge | null; prev: Step | null };
  const queue: Step[] = [{ node: batteryId, via: null, prev: null }];
  const visited = new Set<string>([batteryId]);
  let end: Step | null = null;

  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.node === targetId) {
      end = step;
      break;
    }
    for (const edge of adj.get(step.node) ?? []) {
      if (visited.has(edge.neighbor)) continue;
      visited.add(edge.neighbor);
      queue.push({ node: edge.neighbor, via: edge, prev: step });
    }
  }

  if (!end) {
    return { found: false, reason: 'no-path' };
  }

  const hops: PowerPathHop[] = [];
  let cursor: Step | null = end;
  const chain: Step[] = [];
  while (cursor) {
    chain.push(cursor);
    cursor = cursor.prev;
  }
  chain.reverse();
  for (let i = 1; i < chain.length; i += 1) {
    const step = chain[i]!;
    const via = step.via!;
    const wire = currentById.get(via.connectionId);
    hops.push({
      connectionId: via.connectionId,
      from: via.edgeFrom,
      to: via.edgeTo,
      gauge: wire?.gauge ?? 0,
      lengthInches: wire?.lengthInches ?? 0,
      currentAmps: wire?.currentAmps ?? 0,
      voltageDrop: wire?.voltageDrop ?? 0,
    });
  }

  const pathCount = countSimplePaths(adj, batteryId, targetId, 32);
  return {
    found: true,
    hops,
    usedShortestOfMultiple: pathCount > 1,
  };
}

/** Bounded enumeration of simple paths (stops early once two are found). */
function countSimplePaths(
  adj: Map<string, AdjEdge[]>,
  start: string,
  goal: string,
  visitLimit: number,
): number {
  let found = 0;
  const stack: Array<{ node: string; used: Set<string> }> = [
    { node: start, used: new Set([start]) },
  ];
  let visits = 0;

  while (stack.length > 0 && found < 2 && visits < visitLimit) {
    visits += 1;
    const frame = stack.pop()!;
    if (frame.node === goal) {
      found += 1;
      continue;
    }
    for (const edge of adj.get(frame.node) ?? []) {
      if (frame.used.has(edge.neighbor)) continue;
      const nextUsed = new Set(frame.used);
      nextUsed.add(edge.neighbor);
      stack.push({ node: edge.neighbor, used: nextUsed });
    }
  }
  return found;
}

/**
 * Check that battery OCV minus internal drop minus path wire drops matches the
 * target voltage within `toleranceVolts`. Breaker contact resistance and other
 * non-wire series elements are outside wireCurrents, so this is exact only for
 * paths whose drops are entirely in the listed hops.
 */
export function pathVoltageCloses(
  batteryVoltage: number,
  internalVoltageDrop: number,
  hops: readonly PowerPathHop[],
  targetVoltage: number,
  toleranceVolts = 1e-6,
): boolean {
  const wireDrop = hops.reduce((sum, hop) => sum + hop.voltageDrop, 0);
  const predicted = batteryVoltage - internalVoltageDrop - wireDrop;
  return Math.abs(predicted - targetVoltage) <= toleranceVolts;
}
