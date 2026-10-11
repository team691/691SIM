import { createHealthyRobotModel } from '@691sim/core';
import { describe, expect, it } from 'vitest';
import {
  AWG_TABLE,
  BREAKER_SERIES_RESISTANCE_OHMS,
  Battery,
  MotorController,
  SimWire,
  buildPowerNetwork,
  createComponent,
  simulateCircuit,
  simulateVoltage,
  verifyCanTopology,
  type CanEdge,
  type PowerEdge,
  type VoltageSimResult,
} from './index.js';

describe('CircuitComponent model', () => {
  it('builds the correct subclass and tracks current/voltage/CAN attributes', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    expect(battery).toBeInstanceOf(Battery);
    expect(battery.isPowerSource()).toBe(true);
    expect(battery.currentDraw('peak')).toBe(0);

    const spark = createComponent({ id: 'spark-1', type: 'SparkMax', metadata: { canId: 7 } });
    expect(spark).toBeInstanceOf(MotorController);
    expect(spark.canId).toBe(7);
    expect(spark.peakCurrentAmps).toBeGreaterThan(spark.continuousCurrentAmps);
  });

  it('honours instance metadata overrides for current limits', () => {
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: 12, peakCurrentAmps: 99 },
    });
    expect(spark.continuousCurrentAmps).toBe(12);
    expect(spark.peakCurrentAmps).toBe(99);
  });
});

describe('SimWire (AWG / ampacity)', () => {
  it('computes resistance from gauge and length and flags ampacity', () => {
    const wire = new SimWire('w1', 18, 24); // 18 AWG, 24 inches = 2 ft
    expect(wire.resistanceOhms).toBeCloseTo(AWG_TABLE[18].ohmsPerFoot * 2, 6);
    expect(wire.exceedsAmpacity(30)).toBe(true); // 18 AWG max is 16A
    expect(wire.exceedsAmpacity(10)).toBe(false);
    expect(wire.voltageDrop(10)).toBeCloseTo(10 * wire.resistanceOhms, 6);
  });
});

describe('buildPowerNetwork', () => {
  it('builds a 3-device chain with round-trip wire resistance and a series breaker', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const breaker = createComponent({
      id: 'breaker-1',
      type: 'MainBreaker',
      metadata: { breakerClosed: true },
    });
    const spark = createComponent({ id: 'spark-1', type: 'SparkMax' });
    const components = new Map([
      [battery.id, battery],
      [breaker.id, breaker],
      [spark.id, spark],
    ]);

    const batteryLead = new SimWire('battery-breaker', 6, 12);
    const branchLead = new SimWire('breaker-spark', 10, 24);
    const edges: PowerEdge[] = [
      { connectionId: batteryLead.connectionId, from: battery.id, to: breaker.id, wire: batteryLead },
      { connectionId: branchLead.connectionId, from: breaker.id, to: spark.id, wire: branchLead },
    ];

    const network = buildPowerNetwork(components, edges);

    expect(network.nodes.map((node) => node.id)).toEqual([
      'gnd',
      'source:battery-1',
      'battery-1',
      'breaker-1#line',
      'breaker-1',
      'spark-1',
    ]);
    expect(network.battery?.nominalVoltage).toBe(12.6);
    expect(network.battery?.internalResistanceOhms).toBeCloseTo(0.011, 6);

    const internal = network.resistors.find((resistor) => resistor.kind === 'battery-internal');
    expect(internal?.from).toBe('source:battery-1');
    expect(internal?.to).toBe('battery-1');
    expect(internal?.resistanceOhms).toBeCloseTo(0.011, 6);

    const breakerResistor = network.resistors.find((resistor) => resistor.kind === 'breaker');
    expect(breakerResistor?.from).toBe('breaker-1#line');
    expect(breakerResistor?.to).toBe('breaker-1');
    expect(breakerResistor?.resistanceOhms).toBe(BREAKER_SERIES_RESISTANCE_OHMS);

    const leads = network.resistors.filter((resistor) => resistor.kind === 'wire');
    expect(leads).toHaveLength(2);
    expect(leads[0]?.resistanceOhms).toBeCloseTo(2 * batteryLead.resistanceOhms, 8);
    expect(leads[0]?.from).toBe('battery-1');
    expect(leads[0]?.to).toBe('breaker-1#line');
    expect(leads[1]?.resistanceOhms).toBeCloseTo(2 * branchLead.resistanceOhms, 8);
    expect(leads[1]?.from).toBe('breaker-1');
    expect(leads[1]?.to).toBe('spark-1');
  });
});

describe('nodal voltage solve', () => {
  function volts(result: VoltageSimResult, deviceId: string): number {
    const row = result.deviceVoltages.find((device) => device.deviceId === deviceId);
    const voltage = row?.voltage;
    if (voltage === undefined || voltage === null) {
      throw new Error(`expected a solved voltage for ${deviceId}`);
    }
    return voltage;
  }

  it('drops V_batt - I(R_int + 2 R_wire) across one wire and one load', () => {
    const amps = 10;
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: amps, peakCurrentAmps: amps },
    });
    const wire = new SimWire('battery-spark', 12, 12);
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [spark.id, spark],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: spark.id, wire }],
      'peak',
    );

    // Series path: internal resistance, then the supply conductor and the return.
    const expected = 12.6 - amps * (0.011 + 2 * wire.resistanceOhms);
    expect(volts(result, 'spark-1')).toBeCloseTo(expected, 6);
    expect(volts(result, 'battery-1')).toBeCloseTo(12.6 - amps * 0.011, 6);
    expect(result.totalCurrentAmps).toBeCloseTo(amps, 6);
    expect(result.issues).toHaveLength(0);
  });

  it('does not let a long branch pull down the other load past the shared path', () => {
    const ampsA = 10;
    const ampsB = 20;
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const bus = createComponent({
      id: 'pdh-1',
      type: 'PDH',
      metadata: { continuousCurrentAmps: 0, peakCurrentAmps: 0 },
    });
    const loadA = createComponent({
      id: 'spark-a',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: ampsA, peakCurrentAmps: ampsA },
    });
    const loadB = createComponent({
      id: 'spark-b',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: ampsB, peakCurrentAmps: ampsB },
    });
    const shared = new SimWire('battery-pdh', 6, 12);
    const branchA = new SimWire('pdh-a', 10, 12);
    const branchB = new SimWire('pdh-b', 18, 120);
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [bus.id, bus],
        [loadA.id, loadA],
        [loadB.id, loadB],
      ]),
      [
        { connectionId: shared.connectionId, from: battery.id, to: bus.id, wire: shared },
        { connectionId: branchA.connectionId, from: bus.id, to: loadA.id, wire: branchA },
        { connectionId: branchB.connectionId, from: bus.id, to: loadB.id, wire: branchB },
      ],
      'peak',
    );

    const sharedAmps = ampsA + ampsB;
    const busVoltage = 12.6 - sharedAmps * (0.011 + 2 * shared.resistanceOhms);
    const expectedA = busVoltage - ampsA * 2 * branchA.resistanceOhms;
    const expectedB = busVoltage - ampsB * 2 * branchB.resistanceOhms;
    // The old lumped model also subtracted B's wire from A.
    const lumpedOntoA = expectedA - ampsB * 2 * branchB.resistanceOhms;

    expect(volts(result, 'spark-a')).toBeCloseTo(expectedA, 6);
    expect(volts(result, 'spark-b')).toBeCloseTo(expectedB, 6);
    expect(volts(result, 'pdh-1')).toBeCloseTo(busVoltage, 6);
    expect(volts(result, 'spark-a')).toBeGreaterThan(lumpedOntoA + 1);
    expect(volts(result, 'spark-b')).toBeLessThan(volts(result, 'spark-a'));
  });

  it('satisfies Kirchhoff current law at every device node', () => {
    const ampsA = 10;
    const ampsB = 20;
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const bus = createComponent({
      id: 'pdh-1',
      type: 'PDH',
      metadata: { continuousCurrentAmps: 0, peakCurrentAmps: 0 },
    });
    const loadA = createComponent({
      id: 'spark-a',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: ampsA, peakCurrentAmps: ampsA },
    });
    const loadB = createComponent({
      id: 'spark-b',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: ampsB, peakCurrentAmps: ampsB },
    });
    const shared = new SimWire('battery-pdh', 6, 12);
    const branchA = new SimWire('pdh-a', 10, 12);
    const branchB = new SimWire('pdh-b', 18, 120);
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [bus.id, bus],
        [loadA.id, loadA],
        [loadB.id, loadB],
      ]),
      [
        { connectionId: shared.connectionId, from: battery.id, to: bus.id, wire: shared },
        { connectionId: branchA.connectionId, from: bus.id, to: loadA.id, wire: branchA },
        { connectionId: branchB.connectionId, from: bus.id, to: loadB.id, wire: branchB },
      ],
      'peak',
    );

    const batteryV = volts(result, 'battery-1');
    const busV = volts(result, 'pdh-1');
    const loadAV = volts(result, 'spark-a');
    const loadBV = volts(result, 'spark-b');
    const intoBattery = (12.6 - batteryV) / 0.011;
    const sharedCurrent = (batteryV - busV) / (2 * shared.resistanceOhms);
    const branchCurrentA = (busV - loadAV) / (2 * branchA.resistanceOhms);
    const branchCurrentB = (busV - loadBV) / (2 * branchB.resistanceOhms);

    // Source node: internal-resistor current equals every connected load.
    expect(intoBattery).toBeCloseTo(ampsA + ampsB, 6);
    // Battery terminal: current in from the source equals current out the shared wire.
    expect(intoBattery - sharedCurrent).toBeCloseTo(0, 6);
    // Bus: shared wire in, two branches out, and the PDH itself draws 0 A.
    expect(sharedCurrent - branchCurrentA - branchCurrentB).toBeCloseTo(0, 6);
    // Each load: wire current equals the current sunk at that node.
    expect(branchCurrentA).toBeCloseTo(ampsA, 6);
    expect(branchCurrentB).toBeCloseTo(ampsB, 6);
  });

  it('reports a floating device and a missing battery instead of throwing', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: 4, peakCurrentAmps: 4 },
    });
    const unwired = createComponent({ id: 'spark-2', type: 'SparkMax' });
    const wire = new SimWire('battery-spark', 12, 24);
    const partial = simulateVoltage(
      new Map([
        [battery.id, battery],
        [spark.id, spark],
        [unwired.id, unwired],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: spark.id, wire }],
      'peak',
    );
    expect(partial.deviceVoltages.find((device) => device.deviceId === 'spark-2')?.voltage).toBeNull();
    expect(partial.issues.some((issue) => issue.code === 'FLOATING_NODE' && issue.deviceIds.includes('spark-2'))).toBe(
      true,
    );
    expect(volts(partial, 'spark-1')).toBeCloseTo(12.6 - 4 * (0.011 + 2 * wire.resistanceOhms), 6);

    const noBattery = simulateVoltage(new Map([[spark.id, spark]]), [], 'peak');
    expect(noBattery.hasBattery).toBe(false);
    expect(noBattery.brownoutRisk).toBe(false);
    expect(noBattery.issues.some((issue) => issue.code === 'NO_BATTERY')).toBe(true);
    expect(noBattery.deviceVoltages[0]?.voltage).toBeNull();
  });

  it('solves a parallel wiring loop and splits the current', () => {
    const amps = 10;
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: amps, peakCurrentAmps: amps },
    });
    const wireA = new SimWire('wire-a', 12, 12);
    const wireB = new SimWire('wire-b', 12, 12);
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [spark.id, spark],
      ]),
      [
        { connectionId: wireA.connectionId, from: battery.id, to: spark.id, wire: wireA },
        { connectionId: wireB.connectionId, from: battery.id, to: spark.id, wire: wireB },
      ],
      'peak',
    );

    const roundTrip = 2 * wireA.resistanceOhms;
    const expected = 12.6 - amps * (0.011 + roundTrip / 2);
    expect(result.issues.some((issue) => issue.code === 'POWER_LOOP_DETECTED')).toBe(true);
    expect(volts(result, 'spark-1')).toBeCloseTo(expected, 6);
    expect(result.wireCurrents[0]?.currentAmps).toBeCloseTo(amps / 2, 6);
    expect(result.wireCurrents[1]?.currentAmps).toBeCloseTo(amps / 2, 6);
  });
});

describe('simulateCircuit voltage/brownout', () => {
  it('keeps a healthy robot above the brownout threshold', () => {
    const result = simulateCircuit(createHealthyRobotModel(), { mode: 'peak' });
    expect(result.voltage.hasBattery).toBe(true);
    expect(result.voltage.systemVoltage).toBeLessThan(result.voltage.batteryVoltage);
    expect(result.voltage.systemVoltage).toBeGreaterThan(6.3);
    expect(result.voltage.brownoutRisk).toBe(false);
  });

  it('detects brownout risk when loads are extreme', () => {
    const model = createHealthyRobotModel();
    // Crank the SparkMax to an unrealistic draw to force a sag below 6.3V.
    const spark = model.devices.find((d) => d.id === 'spark-1')!;
    spark.metadata = { ...spark.metadata, peakCurrentAmps: 900 };

    const result = simulateCircuit(model, { mode: 'peak' });
    expect(result.voltage.brownoutRisk).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'BROWNOUT_RISK')).toBe(true);
  });

  it('flags an ampacity hazard on an undersized wire', () => {
    const model = createHealthyRobotModel();
    const powerConn = model.connections.find((c) => c.id === 'pdh-spark-power')!;
    powerConn.metadata = { gauge: 18, lengthInches: 24 };

    const result = simulateCircuit(model, { mode: 'peak' });
    expect(result.ampacityViolations.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === 'WIRE_AMPACITY_EXCEEDED')).toBe(true);
  });

  it('reports when the main breaker is open', () => {
    const model = createHealthyRobotModel();
    const breaker = model.devices.find((d) => d.id === 'breaker-1')!;
    breaker.metadata = { ...breaker.metadata, breakerClosed: false };

    const result = simulateCircuit(model, { mode: 'peak' });
    expect(result.diagnostics.some((d) => d.code === 'BREAKER_OPEN')).toBe(true);
    expect(result.voltage.totalCurrentAmps).toBe(0);
  });
});

describe('verifyCanTopology', () => {
  function components(entries: Array<[string, string]>) {
    const map = new Map();
    for (const [id, type] of entries) map.set(id, createComponent({ id, type }));
    return map;
  }

  it('accepts a linear RIO -> ... -> PDH chain', () => {
    const comps = components([
      ['rio-1', 'RoboRIO'],
      ['spark-1', 'SparkMax'],
      ['pdh-1', 'PDH'],
    ]);
    const edges: CanEdge[] = [
      { connectionId: 'c1', a: 'rio-1', b: 'spark-1' },
      { connectionId: 'c2', a: 'spark-1', b: 'pdh-1' },
    ];
    const result = verifyCanTopology(comps, edges);
    expect(result.isValidChain).toBe(true);
    expect(result.terminationOk).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects a branch (device with 3 CAN links)', () => {
    const comps = components([
      ['rio-1', 'RoboRIO'],
      ['spark-1', 'SparkMax'],
      ['spark-2', 'SparkMax'],
      ['pdh-1', 'PDH'],
    ]);
    const edges: CanEdge[] = [
      { connectionId: 'c1', a: 'rio-1', b: 'spark-1' },
      { connectionId: 'c2', a: 'spark-1', b: 'spark-2' },
      { connectionId: 'c3', a: 'spark-1', b: 'pdh-1' },
    ];
    const result = verifyCanTopology(comps, edges);
    expect(result.issues.some((i) => i.code === 'CAN_BRANCH_DETECTED')).toBe(true);
    expect(result.isValidChain).toBe(false);
  });

  it('detects a loop', () => {
    const comps = components([
      ['rio-1', 'RoboRIO'],
      ['spark-1', 'SparkMax'],
      ['pdh-1', 'PDH'],
    ]);
    const edges: CanEdge[] = [
      { connectionId: 'c1', a: 'rio-1', b: 'spark-1' },
      { connectionId: 'c2', a: 'spark-1', b: 'pdh-1' },
      { connectionId: 'c3', a: 'pdh-1', b: 'rio-1' },
    ];
    const result = verifyCanTopology(comps, edges);
    expect(result.issues.some((i) => i.code === 'CAN_LOOP_DETECTED')).toBe(true);
  });

  it('treats a CANivore chain as its own bus', () => {
    const comps = components([
      ['rio-1', 'RoboRIO'],
      ['spark-1', 'SparkMax'],
      ['pdh-1', 'PDH'],
      ['canivore-1', 'CANivore'],
      ['talon-1', 'TalonFX'],
    ]);
    const edges: CanEdge[] = [
      { connectionId: 'c1', a: 'rio-1', b: 'spark-1' },
      { connectionId: 'c2', a: 'spark-1', b: 'pdh-1' },
      { connectionId: 'c3', a: 'canivore-1', b: 'talon-1' },
    ];
    const result = verifyCanTopology(comps, edges);
    expect(result.isValidChain).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.segments).toBe(2);
    expect(result.buses.map((bus) => bus.kind).sort()).toEqual(['canivore', 'roborio']);
    expect(result.buses.every((bus) => bus.valid)).toBe(true);
  });

  it('flags missing termination when the chain does not end at RIO + PDH', () => {
    const comps = components([
      ['spark-1', 'SparkMax'],
      ['spark-2', 'SparkMax'],
    ]);
    const edges: CanEdge[] = [{ connectionId: 'c1', a: 'spark-1', b: 'spark-2' }];
    const result = verifyCanTopology(comps, edges);
    expect(result.terminationOk).toBe(false);
    expect(result.issues.some((i) => i.code === 'CAN_MISSING_TERMINATION')).toBe(true);
  });
});
