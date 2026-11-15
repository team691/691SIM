import { describe, expect, it } from 'vitest';
import { SimWire, type PowerEdge, type WireCurrentResult } from '@691sim/simulation';
import { pathVoltageCloses, tracePowerPath } from './tracePowerPath';

function edge(id: string, from: string, to: string, gauge: 6 | 10 | 12 | 14 | 18 = 12, inches = 12): PowerEdge {
  const wire = new SimWire(id, gauge, inches);
  return { connectionId: id, from, to, wire };
}

function currents(edges: PowerEdge[], ampsById: Record<string, number>): WireCurrentResult[] {
  return edges.map((e) => {
    const amps = ampsById[e.connectionId] ?? 0;
    const r = e.wire.resistanceOhms * 2;
    return {
      connectionId: e.connectionId,
      from: e.from,
      to: e.to,
      gauge: e.wire.gauge,
      lengthInches: e.wire.lengthInches,
      resistanceOhms: r,
      currentAmps: amps,
      voltageDrop: amps * r,
      maxAmps: e.wire.maxAmps,
      exceedsAmpacity: false,
    };
  });
}

describe('tracePowerPath', () => {
  it('follows a simple battery → load chain', () => {
    const edges = [edge('w1', 'battery-1', 'spark-1')];
    const wireCurrents = currents(edges, { w1: 10 });
    const path = tracePowerPath(edges, wireCurrents, 'battery-1', 'spark-1');
    expect(path.found).toBe(true);
    if (!path.found) return;
    expect(path.hops.map((h) => h.connectionId)).toEqual(['w1']);
    expect(path.usedShortestOfMultiple).toBe(false);
    expect(
      pathVoltageCloses(12.6, 10 * 0.011, path.hops, 12.6 - 10 * 0.011 - path.hops[0]!.voltageDrop),
    ).toBe(true);
  });

  it('traces a branch through the PDH', () => {
    const edges = [
      edge('bat-pdh', 'battery-1', 'pdh-1', 6),
      edge('pdh-rio', 'pdh-1', 'rio-1', 12),
      edge('pdh-spark', 'pdh-1', 'spark-1', 10),
    ];
    const wireCurrents = currents(edges, {
      'bat-pdh': 53,
      'pdh-rio': 3,
      'pdh-spark': 50,
    });
    const path = tracePowerPath(edges, wireCurrents, 'battery-1', 'spark-1');
    expect(path.found).toBe(true);
    if (!path.found) return;
    expect(path.hops.map((h) => h.connectionId)).toEqual(['bat-pdh', 'pdh-spark']);
    expect(path.hops.map((h) => h.to)).toEqual(['pdh-1', 'spark-1']);
  });

  it('returns no-path when the target is unreachable', () => {
    const edges = [edge('w1', 'battery-1', 'spark-1')];
    const path = tracePowerPath(edges, currents(edges, { w1: 1 }), 'battery-1', 'rio-1');
    expect(path.found).toBe(false);
    if (path.found) return;
    expect(path.reason).toBe('no-path');
  });

  it('picks the shortest path when a loop offers multiple routes', () => {
    const edges = [
      edge('short', 'battery-1', 'spark-1', 12, 12),
      edge('long-a', 'battery-1', 'pdh-1', 12, 24),
      edge('long-b', 'pdh-1', 'spark-1', 12, 24),
    ];
    const wireCurrents = currents(edges, { short: 5, 'long-a': 5, 'long-b': 5 });
    const path = tracePowerPath(edges, wireCurrents, 'battery-1', 'spark-1');
    expect(path.found).toBe(true);
    if (!path.found) return;
    expect(path.hops).toHaveLength(1);
    expect(path.hops[0]?.connectionId).toBe('short');
    expect(path.usedShortestOfMultiple).toBe(true);
  });

  it('asserts battery OCV minus drops equals target voltage on a series chain', () => {
    const amps = 20;
    const rInt = 0.011;
    const edges = [
      edge('a', 'battery-1', 'mid', 12, 24),
      edge('b', 'mid', 'load', 12, 24),
    ];
    const wireCurrents = currents(edges, { a: amps, b: amps });
    const path = tracePowerPath(edges, wireCurrents, 'battery-1', 'load');
    expect(path.found).toBe(true);
    if (!path.found) return;
    const batteryVoltage = 12.6;
    const internalDrop = amps * rInt;
    const target =
      batteryVoltage - internalDrop - path.hops.reduce((s, h) => s + h.voltageDrop, 0);
    expect(pathVoltageCloses(batteryVoltage, internalDrop, path.hops, target, 1e-9)).toBe(true);
  });
});
