import type { PowerNetwork } from './network.js';
import { GROUND_NODE_ID } from './network.js';

export type VoltageIssueCode =
  | 'NO_BATTERY'
  | 'FLOATING_NODE'
  | 'POWER_LOOP_DETECTED'
  | 'SINGULAR_NETWORK'
  | 'PLACEHOLDER_CONSTANT'
  | 'TALON_SUPPLY_UNRESOLVED'
  | 'LOAD_ITERATION_DIVERGED'
  | 'BATTERY_SOC_CURVE_MISSING';

export interface VoltageIssue {
  code: VoltageIssueCode;
  message: string;
  deviceIds: string[];
}

export interface NodalSolution {
  /** False when there is no battery or the conductance matrix cannot be solved. */
  solved: boolean;
  /** Solved node voltages, including ground at 0 V and the ideal source. */
  voltageByNode: Map<string, number>;
  issues: VoltageIssue[];
}

const SINGULAR_PIVOT = 1e-12;

/**
 * Solve G v = i by Gauss-Jordan elimination with partial pivoting.
 * Returns null when a pivot is ~0 (the matrix is singular).
 */
function solveLinearSystem(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | null {
  const n = rhs.length;
  if (n === 0) return [];

  const augmented: number[][] = [];
  for (let row = 0; row < n; row += 1) {
    const source = matrix[row];
    const injected = rhs[row];
    if (!source || injected === undefined || source.length !== n) return null;
    const copy = source.slice();
    copy.push(injected);
    augmented.push(copy);
  }

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let pivotMagnitude = Math.abs(augmented[col]?.[col] ?? 0);
    for (let row = col + 1; row < n; row += 1) {
      const magnitude = Math.abs(augmented[row]?.[col] ?? 0);
      if (magnitude > pivotMagnitude) {
        pivotMagnitude = magnitude;
        pivotRow = row;
      }
    }
    if (pivotMagnitude < SINGULAR_PIVOT) return null;

    const pivot = augmented[pivotRow];
    const current = augmented[col];
    if (!pivot || !current) return null;
    if (pivotRow !== col) {
      augmented[pivotRow] = current;
      augmented[col] = pivot;
    }

    const active = augmented[col];
    const diagonal = active?.[col];
    if (!active || diagonal === undefined || diagonal === 0) return null;
    for (let column = col; column <= n; column += 1) {
      const cell = active[column];
      if (cell === undefined) return null;
      active[column] = cell / diagonal;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const target = augmented[row];
      const factor = target?.[col];
      if (!target || factor === undefined || factor === 0) continue;
      for (let column = col; column <= n; column += 1) {
        const cell = target[column];
        const fromPivot = active[column];
        if (cell === undefined || fromPivot === undefined) return null;
        target[column] = cell - factor * fromPivot;
      }
    }
  }

  const solution: number[] = [];
  for (const row of augmented) {
    const value = row[n];
    if (value === undefined || !Number.isFinite(value)) return null;
    solution.push(value);
  }
  return solution;
}

/**
 * Nodal solution of the power network.
 *
 * Resistor stamp. A resistor R between nodes a and b has conductance g = 1/R.
 * Ohm's law says the current leaving a toward b is i_ab = g (v_a - v_b).
 * Kirchhoff's current law puts injected current on the right-hand side, so
 * that resistor contributes:
 *
 *   G_aa += g,  G_bb += g,  G_ab -= g,  G_ba -= g
 *
 * because g v_a - g v_b is the current leaving a, and the same current
 * arrives at b.
 *
 * Source stamp. The battery is an ideal voltage v_s in series with R_int.
 * The ideal node is not an unknown: it is held at v_s. For the resistor from
 * that known node to an unknown node k, KCL at k is g (v_k - v_s) = i_k.
 * Moving the known voltage across the equation gives
 *
 *   G_kk += g,  i_k += g v_s
 *
 * which is the Norton equivalent (current v_s / R_int injected at the battery
 * terminal, in parallel with conductance 1/R_int to ground). A load that
 * draws I amps is a current sink, so it stamps i_k -= I. Ground is the 0 V
 * reference and is removed from the unknown vector.
 *
 * Wiring loops make a cyclic conductance matrix, which this elimination still
 * solves. They produce a diagnostic and do not throw. A node with no
 * conductive path back to the battery is left out of G and reported as floating.
 */
export function solvePowerNetwork(
  network: PowerNetwork,
  loadCurrentByDevice: ReadonlyMap<string, number>,
): NodalSolution {
  const issues: VoltageIssue[] = [];
  const battery = network.battery;

  if (!battery) {
    return {
      solved: false,
      voltageByNode: new Map([[GROUND_NODE_ID, 0]]),
      issues: [
        {
          code: 'NO_BATTERY',
          message: 'No battery is on the robot, so node voltages are undefined.',
          deviceIds: deviceIdsOf(network),
        },
      ],
    };
  }

  const loop = detectLoops(network);
  if (loop.hasLoop) {
    issues.push({
      code: 'POWER_LOOP_DETECTED',
      message:
        'Power wiring contains a loop. Nodal analysis solved the loop; current splits across the parallel paths.',
      deviceIds: deviceIdsForNodes(network, loop.nodeIds),
    });
  }

  const reachable = nodesReachableFrom(network, battery.sourceNodeId);
  const floatingNodes = network.nodes.filter(
    (node) => node.id !== GROUND_NODE_ID && !reachable.has(node.id),
  );
  // A closed breaker is two nodes. An open breaker keeps the line stud powered,
  // so the device is floating only when every one of its nodes is unreachable.
  const poweredDevices = new Set(
    network.nodes.flatMap((node) =>
      node.deviceId !== undefined && reachable.has(node.id) ? [node.deviceId] : [],
    ),
  );
  const floatingDevices = [
    ...new Set(
      floatingNodes.flatMap((node) =>
        node.deviceId !== undefined && !poweredDevices.has(node.deviceId) ? [node.deviceId] : [],
      ),
    ),
  ];
  if (floatingDevices.length > 0) {
    issues.push({
      code: 'FLOATING_NODE',
      message: `No conductive path to the battery, so voltage is undefined for ${floatingDevices.join(', ')}.`,
      deviceIds: floatingDevices,
    });
  }

  const unknownIds = network.nodes
    .map((node) => node.id)
    .filter((id) => id !== GROUND_NODE_ID && id !== battery.sourceNodeId && reachable.has(id));
  const indexOf = new Map(unknownIds.map((id, index) => [id, index]));
  const size = unknownIds.length;
  const conductance = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  const injected = Array.from({ length: size }, () => 0);

  const knownVoltage = (nodeId: string): number | undefined => {
    if (nodeId === GROUND_NODE_ID) return 0;
    if (nodeId === battery.sourceNodeId) return battery.nominalVoltage;
    return undefined;
  };

  for (const resistor of network.resistors) {
    stampResistor(conductance, injected, indexOf, knownVoltage, resistor.from, resistor.to, resistor.resistanceOhms);
  }

  for (const [deviceId, amps] of loadCurrentByDevice) {
    const index = indexOf.get(deviceId);
    const row = index === undefined ? undefined : injected[index];
    if (index === undefined || row === undefined || !Number.isFinite(amps)) continue;
    injected[index] = row - amps;
  }

  const solvedVoltages = solveLinearSystem(conductance, injected);
  if (!solvedVoltages) {
    issues.push({
      code: 'SINGULAR_NETWORK',
      message: 'The conductance matrix is singular, so node voltages were not solved.',
      deviceIds: deviceIdsOf(network),
    });
    return { solved: false, voltageByNode: new Map([[GROUND_NODE_ID, 0]]), issues };
  }

  const voltageByNode = new Map<string, number>([
    [GROUND_NODE_ID, 0],
    [battery.sourceNodeId, battery.nominalVoltage],
  ]);
  unknownIds.forEach((id, index) => {
    const voltage = solvedVoltages[index];
    if (voltage !== undefined) voltageByNode.set(id, voltage);
  });

  return { solved: true, voltageByNode, issues };
}

/**
 * G v = i stamp for one resistor. See the derivation on solvePowerNetwork.
 * Non-positive resistance is an open circuit and is left out of G.
 */
function stampResistor(
  conductance: number[][],
  injected: number[],
  indexOf: ReadonlyMap<string, number>,
  knownVoltage: (nodeId: string) => number | undefined,
  from: string,
  to: string,
  resistanceOhms: number,
): void {
  if (!(resistanceOhms > 0) || !Number.isFinite(resistanceOhms)) return;
  const g = 1 / resistanceOhms;

  const stampUnknown = (nodeId: string, otherVoltage: number | undefined, otherIndex: number | undefined): void => {
    const index = indexOf.get(nodeId);
    if (index === undefined) return;
    const diagonal = conductance[index];
    const rowInjected = injected[index];
    if (!diagonal || rowInjected === undefined) return;
    const self = diagonal[index] ?? 0;
    diagonal[index] = self + g;
    if (otherIndex !== undefined) {
      const off = diagonal[otherIndex] ?? 0;
      diagonal[otherIndex] = off - g;
    }
    if (otherVoltage !== undefined) {
      injected[index] = rowInjected + g * otherVoltage;
    }
  };

  const fromKnown = knownVoltage(from);
  const toKnown = knownVoltage(to);
  const fromIndex = indexOf.get(from);
  const toIndex = indexOf.get(to);

  if (fromKnown === undefined && fromIndex !== undefined) {
    stampUnknown(from, toKnown, toKnown === undefined ? toIndex : undefined);
  }
  if (toKnown === undefined && toIndex !== undefined) {
    stampUnknown(to, fromKnown, fromKnown === undefined ? fromIndex : undefined);
  }
}

function nodesReachableFrom(network: PowerNetwork, startId: string): Set<string> {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacency.get(a) ?? [];
    list.push(b);
    adjacency.set(a, list);
  };

  for (const resistor of network.resistors) {
    if (!(resistor.resistanceOhms > 0) || !Number.isFinite(resistor.resistanceOhms)) continue;
    link(resistor.from, resistor.to);
    link(resistor.to, resistor.from);
  }

  const reachable = new Set<string>();
  const queue = [startId];
  reachable.add(startId);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const next of adjacency.get(current) ?? []) {
      if (reachable.has(next)) continue;
      reachable.add(next);
      queue.push(next);
    }
  }
  return reachable;
}

function detectLoops(network: PowerNetwork): { hasLoop: boolean; nodeIds: string[] } {
  const parent = new Map<string, string>();
  const loopedRoots = new Set<string>();

  const find = (id: string): string => {
    const existing = parent.get(id);
    if (existing === undefined) {
      parent.set(id, id);
      return id;
    }
    if (existing === id) return id;
    const root = find(existing);
    parent.set(id, root);
    return root;
  };

  const unite = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) {
      loopedRoots.add(rootA);
      return;
    }
    parent.set(rootB, rootA);
    if (loopedRoots.has(rootB)) loopedRoots.add(rootA);
  };

  for (const resistor of network.resistors) {
    if (!(resistor.resistanceOhms > 0) || !Number.isFinite(resistor.resistanceOhms)) continue;
    unite(resistor.from, resistor.to);
  }

  const nodeIds: string[] = [];
  for (const id of parent.keys()) {
    if (loopedRoots.has(find(id))) nodeIds.push(id);
  }
  return { hasLoop: loopedRoots.size > 0, nodeIds };
}

function deviceIdsOf(network: PowerNetwork): string[] {
  return [...new Set(network.nodes.flatMap((node) => (node.deviceId === undefined ? [] : [node.deviceId])))];
}

function deviceIdsForNodes(network: PowerNetwork, nodeIds: readonly string[]): string[] {
  const wanted = new Set(nodeIds);
  return [
    ...new Set(
      network.nodes.flatMap((node) =>
        node.deviceId !== undefined && wanted.has(node.id) ? [node.deviceId] : [],
      ),
    ),
  ];
}
