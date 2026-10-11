import type { CircuitComponent } from './components.js';

const CONTROLLER_TYPES = new Set(['RoboRIO', 'SystemCore']);
const TERMINATOR_TYPES = new Set(['PDH', 'PDP']);
const CANIVORE_TYPE = 'CANivore';

export interface CanEdge {
  connectionId: string;
  a: string;
  b: string;
}

export interface CanTopologyIssue {
  code: string;
  message: string;
  deviceIds: string[];
}

export interface CanBusSegment {
  /** `roborio`, or `canivore-0`, `canivore-1`, … */
  id: string;
  kind: 'roborio' | 'canivore';
  deviceIds: string[];
  endpoints: string[];
  valid: boolean;
}

export interface CanTopologyResult {
  hasCanBus: boolean;
  isValidChain: boolean;
  terminationOk: boolean;
  /** Endpoints of the roboRIO bus, or of the only bus when that bus is a CANivore. */
  endpoints: string[];
  segments: number;
  /** One entry per CAN bus. A CANivore chain is its own entry, not a branch of the roboRIO bus. */
  buses: CanBusSegment[];
  issues: CanTopologyIssue[];
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Verify the CAN bus is a single daisy chain terminated at both ends.
 *
 * A healthy FRC CAN bus is a linear chain that starts at the roboRIO (built-in
 * 120Ω terminator) and ends at the PDH/PDP (switchable 120Ω terminator), with
 * every device in between having exactly two neighbours. This detects branches,
 * loops, isolated segments, and missing/incorrect termination.
 */
export function verifyCanTopology(
  components: Map<string, CircuitComponent>,
  canEdges: CanEdge[],
): CanTopologyResult {
  const adjacency = new Map<string, Set<string>>();
  const seenEdges = new Set<string>();

  const touch = (id: string) => {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    return adjacency.get(id)!;
  };

  for (const edge of canEdges) {
    if (edge.a === edge.b) continue;
    const key = edgeKey(edge.a, edge.b);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    touch(edge.a).add(edge.b);
    touch(edge.b).add(edge.a);
  }

  const nodes = [...adjacency.keys()];
  if (nodes.length === 0) {
    return {
      hasCanBus: false,
      isValidChain: true,
      terminationOk: true,
      endpoints: [],
      segments: 0,
      buses: [],
      issues: [],
    };
  }

  const issues: CanTopologyIssue[] = [];
  const typeOf = (id: string) => components.get(id)?.type ?? '';

  // Branch detection: any node with more than two neighbours.
  const branchNodes = nodes.filter((id) => (adjacency.get(id)?.size ?? 0) > 2);
  for (const id of branchNodes) {
    issues.push({
      code: 'CAN_BRANCH_DETECTED',
      message: `${id} has ${adjacency.get(id)!.size} CAN connections — the bus must be a single daisy chain, not a branch.`,
      deviceIds: [id],
    });
  }

  // Connected components + cycle detection (a tree component has edges = nodes - 1).
  const visited = new Set<string>();
  const componentGroups: string[][] = [];
  let hasLoop = false;

  for (const start of nodes) {
    if (visited.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    visited.add(start);
    let edgeEndpointCount = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      group.push(current);
      const neighbours = adjacency.get(current) ?? new Set();
      edgeEndpointCount += neighbours.size;
      for (const next of neighbours) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    const groupEdges = edgeEndpointCount / 2;
    if (groupEdges >= group.length) {
      hasLoop = true;
    }
    componentGroups.push(group);
  }

  if (hasLoop) {
    issues.push({
      code: 'CAN_LOOP_DETECTED',
      message: 'CAN bus forms a loop. A closed ring prevents proper 120Ω termination at both ends.',
      deviceIds: nodes,
    });
  }

  const endpointsOf = (group: string[]): string[] =>
    group.filter((id) => (adjacency.get(id)?.size ?? 0) === 1);

  const isLine = (group: string[]): boolean => {
    const degrees = group.map((id) => adjacency.get(id)?.size ?? 0);
    return degrees.every((degree) => degree <= 2) && degrees.filter((degree) => degree === 1).length === 2;
  };

  const rioGroups = componentGroups.filter((group) => !group.some((id) => typeOf(id) === CANIVORE_TYPE));
  const canivoreGroups = componentGroups.filter((group) => group.some((id) => typeOf(id) === CANIVORE_TYPE));
  const mainRio =
    rioGroups.find((group) => group.some((id) => CONTROLLER_TYPES.has(typeOf(id)))) ?? rioGroups[0];

  for (const group of rioGroups) {
    if (group === mainRio) continue;
    issues.push({
      code: 'CAN_ISOLATED_SEGMENT',
      message: `Isolated CAN segment not joined to the main bus: ${group.join(', ')}.`,
      deviceIds: group,
    });
  }

  const buses: CanBusSegment[] = [];
  let rioTerminationOk = true;
  if (mainRio) {
    const rioEndpoints = endpointsOf(mainRio);
    rioTerminationOk =
      isLine(mainRio) &&
      rioEndpoints.length === 2 &&
      rioEndpoints.some((id) => CONTROLLER_TYPES.has(typeOf(id))) &&
      rioEndpoints.some((id) => TERMINATOR_TYPES.has(typeOf(id)));
    buses.push({
      id: 'roborio',
      kind: 'roborio',
      deviceIds: mainRio,
      endpoints: rioEndpoints,
      valid: rioTerminationOk && !hasLoop && branchNodes.length === 0,
    });
    if (!rioTerminationOk && !hasLoop) {
      issues.push({
        code: 'CAN_MISSING_TERMINATION',
        message:
          'CAN chain is not terminated correctly. It should start at the roboRIO and end at the PDH/PDP with a 120Ω terminating resistor at each end.',
        deviceIds: mainRio,
      });
    }
  }

  let canivoreBusesOk = true;
  canivoreGroups.forEach((group, index) => {
    const busEndpoints = endpointsOf(group);
    const branched = group.some((id) => (adjacency.get(id)?.size ?? 0) > 2);
    const valid = isLine(group) && busEndpoints.some((id) => typeOf(id) === CANIVORE_TYPE) && !hasLoop && !branched;
    if (!valid) canivoreBusesOk = false;
    buses.push({
      id: `canivore-${index}`,
      kind: 'canivore',
      deviceIds: group,
      endpoints: busEndpoints,
      valid,
    });
    if (!valid && !hasLoop && !branched) {
      issues.push({
        code: 'CAN_BUS_INVALID',
        message:
          'CANivore bus must be its own daisy chain with the CANivore at one end, not a branch of the roboRIO bus.',
        deviceIds: group,
      });
    }
  });

  const endpoints = mainRio ? endpointsOf(mainRio) : (buses[0]?.endpoints ?? []);
  const terminationOk = rioTerminationOk && canivoreBusesOk;
  const isValidChain =
    rioGroups.filter((group) => group !== mainRio).length === 0 &&
    branchNodes.length === 0 &&
    !hasLoop &&
    terminationOk;

  return {
    hasCanBus: true,
    isValidChain,
    terminationOk,
    endpoints,
    segments: componentGroups.length,
    buses,
    issues,
  };
}
