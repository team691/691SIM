import { Battery, Breaker, type CircuitComponent } from './components.js';
import type { PowerEdge } from './voltage.js';

/**
 * Closed-breaker contact resistance. Small on purpose: the breaker is a series
 * element in the branch, and this value is a model constant, not a datasheet
 * reading. An open breaker contributes no resistor (open circuit).
 */
export const BREAKER_SERIES_RESISTANCE_OHMS = 0.001;

/** Reference node. Voltage everywhere else is measured against this datum. */
export const GROUND_NODE_ID = 'gnd';

export type NetworkNodeKind = 'ground' | 'source' | 'device' | 'breaker-line';

export interface NetworkNode {
  id: string;
  kind: NetworkNodeKind;
  /** Set for every node except ground. */
  deviceId?: string;
}

export type ResistorKind = 'battery-internal' | 'wire' | 'breaker';

export interface NetworkResistor {
  id: string;
  from: string;
  to: string;
  resistanceOhms: number;
  kind: ResistorKind;
  /** Power-edge id, present on wire resistors. */
  connectionId?: string;
  /** One-conductor resistance, before the supply + return doubling. */
  conductorResistanceOhms?: number;
}

export interface BatterySource {
  deviceId: string;
  /** Ideal voltage-source node, ahead of internal resistance. */
  sourceNodeId: string;
  /** Battery positive terminal, after internal resistance. */
  terminalNodeId: string;
  nominalVoltage: number;
  internalResistanceOhms: number;
}

export interface PowerNetwork {
  nodes: NetworkNode[];
  resistors: NetworkResistor[];
  /** Absent when the component map has no battery. */
  battery?: BatterySource;
}

export function sourceNodeId(batteryId: string): string {
  return `source:${batteryId}`;
}

export function breakerLineNodeId(breakerId: string): string {
  return `${breakerId}#line`;
}

/**
 * Build the resistive network for nodal analysis. Does not solve it.
 *
 * Each device is one node: the voltage there is the positive terminal relative
 * to ground. The return conductor is not drawn as its own wire. Current that
 * goes out on the positive conductor comes back on the ground conductor, so a
 * power wire of conductor resistance R is stamped as 2R.
 *
 * The battery is an ideal source node in series with its internal resistance,
 * then the terminal node. A closed breaker is split into a line-side node and
 * a load-side node with a small resistor between them, so the device voltage
 * is the voltage on the load side of that contact. An open breaker leaves the
 * two nodes disconnected.
 */
export function buildPowerNetwork(
  components: Map<string, CircuitComponent>,
  powerEdges: PowerEdge[],
): PowerNetwork {
  const battery = [...components.values()].find(
    (component): component is Battery => component instanceof Battery,
  );

  const nodes: NetworkNode[] = [];
  const seen = new Set<string>();

  const addNode = (node: NetworkNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  addNode({ id: GROUND_NODE_ID, kind: 'ground' });

  if (battery) {
    addNode({
      id: sourceNodeId(battery.id),
      kind: 'source',
      deviceId: battery.id,
    });
  }

  for (const component of components.values()) {
    if (component instanceof Breaker) {
      addNode({
        id: breakerLineNodeId(component.id),
        kind: 'breaker-line',
        deviceId: component.id,
      });
    }
    addNode({ id: component.id, kind: 'device', deviceId: component.id });
  }

  for (const edge of powerEdges) {
    for (const deviceId of [edge.from, edge.to]) {
      if (!components.has(deviceId)) {
        addNode({ id: deviceId, kind: 'device', deviceId });
      }
    }
  }

  const resistors: NetworkResistor[] = [];

  if (battery) {
    resistors.push({
      id: `r:battery-internal:${battery.id}`,
      from: sourceNodeId(battery.id),
      to: battery.id,
      resistanceOhms: battery.internalResistanceOhms,
      kind: 'battery-internal',
    });
  }

  for (const component of components.values()) {
    if (!(component instanceof Breaker) || component.blocksDownstreamPower()) continue;
    resistors.push({
      id: `r:breaker:${component.id}`,
      from: breakerLineNodeId(component.id),
      to: component.id,
      resistanceOhms: BREAKER_SERIES_RESISTANCE_OHMS,
      kind: 'breaker',
    });
  }

  for (const edge of powerEdges) {
    const seriesExtra = edge.seriesResistanceOhms ?? 0;
    resistors.push({
      id: `r:wire:${edge.connectionId}`,
      from: wireEndpoint(components, edge.from, 'upstream'),
      to: wireEndpoint(components, edge.to, 'downstream'),
      // Round-trip conductor (2R) plus any optional one-time series add-on.
      resistanceOhms: edge.wire.resistanceOhms * 2 + seriesExtra,
      kind: 'wire',
      connectionId: edge.connectionId,
      conductorResistanceOhms: edge.wire.resistanceOhms,
    });
  }

  const network: PowerNetwork = { nodes, resistors };
  if (battery) {
    network.battery = {
      deviceId: battery.id,
      sourceNodeId: sourceNodeId(battery.id),
      terminalNodeId: battery.id,
      nominalVoltage: battery.nominalVoltage,
      internalResistanceOhms: battery.internalResistanceOhms,
    };
  }
  return network;
}

/**
 * A directed power edge arrives on the line side of a breaker and leaves on
 * the load side. Every other device is a single node, so both sides match.
 */
function wireEndpoint(
  components: Map<string, CircuitComponent>,
  deviceId: string,
  side: 'upstream' | 'downstream',
): string {
  const component = components.get(deviceId);
  if (component instanceof Breaker && side === 'downstream') {
    return breakerLineNodeId(deviceId);
  }
  return deviceId;
}
