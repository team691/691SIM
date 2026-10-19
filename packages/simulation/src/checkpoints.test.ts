import { describe, expect, it } from 'vitest';
import {
  Battery,
  BROWNOUT_VOLTAGE_THRESHOLD,
  MotorController,
  ROBORIO_MIN_VOLTAGE_VOLTS,
  SPARKMAX_MIN_VOLTAGE_VOLTS,
  SWERVE_PHASE_STATOR,
  SimWire,
  buildSwerveMatchProfile,
  buildSwervePhaseProfile,
  createComponent,
  createSwerveModule,
  createSwerveRobotModel,
  interpolateBatteryElectricals,
  krakenSupplyCurrentAmps,
  placeholderBatterySocModel,
  requireKrakenNumber,
  simulateCircuit,
  simulateMatch,
  simulateVoltage,
  swerveDriveIds,
  swerveSteerIds,
  type BatteryStateOfChargeModel,
  type PowerEdge,
} from './index.js';

const BREAKERS = { driveAmps: 25, steerAmps: 15, cancoderAmps: 10, pigeonAmps: 5 };

describe('per-device voltage limits', () => {
  it('keeps the roboRIO at 6.3 V and leaves every other minimum unset', () => {
    expect(ROBORIO_MIN_VOLTAGE_VOLTS).toBe(BROWNOUT_VOLTAGE_THRESHOLD);
    expect(SPARKMAX_MIN_VOLTAGE_VOLTS).toBeNull();
    expect(createComponent({ id: 'rio-1', type: 'RoboRIO' }).minVoltage).toBe(6.3);
    expect(createComponent({ id: 'spark-1', type: 'SparkMax' }).minVoltage).toBeNull();
  });

  it('lists devices under their minimum and names the deepest deficit as the first failure', () => {
    const amps = 10;
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const wireA = new SimWire('wire-a', 12, 12);
    const wireB = new SimWire('wire-b', 18, 120);
    const sharedDrop = (amps + amps) * 0.011;
    const voltageA = 12.6 - sharedDrop - amps * 2 * wireA.resistanceOhms;
    const voltageB = 12.6 - sharedDrop - amps * 2 * wireB.resistanceOhms;
    const sparkA = createComponent({
      id: 'spark-a',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: amps, peakCurrentAmps: amps, minVoltage: voltageA - 0.5 },
    });
    const sparkB = createComponent({
      id: 'spark-b',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: amps, peakCurrentAmps: amps, minVoltage: voltageB + 1 },
    });
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [sparkA.id, sparkA],
        [sparkB.id, sparkB],
      ]),
      [
        { connectionId: wireA.connectionId, from: battery.id, to: sparkA.id, wire: wireA },
        { connectionId: wireB.connectionId, from: battery.id, to: sparkB.id, wire: wireB },
      ],
      'peak',
    );

    expect(result.undervoltage.map((device) => device.deviceId)).toEqual(['spark-b']);
    expect(result.firstFailure?.deviceId).toBe('spark-b');
    expect(result.firstFailure?.deficitVolts).toBeGreaterThan(0.5);
  });

  it('does not flag a device whose datasheet minimum is still unknown', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { peakCurrentAmps: 400, continuousCurrentAmps: 400 },
    });
    const wire = new SimWire('battery-spark', 18, 120);
    const result = simulateVoltage(
      new Map([
        [battery.id, battery],
        [spark.id, spark],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: spark.id, wire }],
      'peak',
    );
    expect(result.deviceVoltages.find((device) => device.deviceId === 'spark-1')?.voltage).toBeLessThan(6);
    expect(result.undervoltage).toHaveLength(0);
    expect(result.firstFailure).toBeNull();
  });
});

describe('simulateMatch', () => {
  it('follows a step load with the series voltage formula and reports the first brownout', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const rio = createComponent({ id: 'rio-1', type: 'RoboRIO' });
    const wire = new SimWire('battery-rio', 12, 12);
    const seriesOhms = 0.011 + 2 * wire.resistanceOhms;
    const lowAmps = 1;
    const highAmps = (12.6 - 6.3) / seriesOhms + 20;
    const components = new Map([
      [battery.id, battery],
      [rio.id, rio],
    ]);
    const edges: PowerEdge[] = [
      { connectionId: wire.connectionId, from: battery.id, to: rio.id, wire },
    ];

    const result = simulateMatch(
      [
        { t: 0, loadsByDeviceId: { 'rio-1': lowAmps } },
        { t: 135, loadsByDeviceId: { 'rio-1': highAmps } },
      ],
      components,
      edges,
    );

    const low = result.samples[0];
    const high = result.samples[1];
    expect(low?.t).toBe(0);
    expect(high?.t).toBe(135);
    expect(low?.deviceVoltages.find((device) => device.deviceId === 'rio-1')?.voltage).toBeCloseTo(
      12.6 - lowAmps * seriesOhms,
      6,
    );
    expect(high?.deviceVoltages.find((device) => device.deviceId === 'rio-1')?.voltage).toBeCloseTo(
      12.6 - highAmps * seriesOhms,
      6,
    );
    expect(result.firstBrownout?.t).toBe(135);
    expect(result.firstBrownout?.deviceId).toBe('rio-1');
    expect(result.firstBrownout?.minVoltage).toBe(6.3);
  });

  it('ignores SoC when the curve is still a null placeholder and reports an issue', () => {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    expect(battery).toBeInstanceOf(Battery);
    (battery as Battery).stateOfChargeModel = placeholderBatterySocModel(1);
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: 10, peakCurrentAmps: 10 },
    });
    const wire = new SimWire('battery-spark', 12, 12);
    const result = simulateMatch(
      [
        { t: 0, loadsByDeviceId: { 'spark-1': 10 } },
        { t: 10, loadsByDeviceId: { 'spark-1': 10 } },
      ],
      new Map([
        [battery.id, battery],
        [spark.id, spark],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: spark.id, wire }],
    );
    expect(result.issues.some((issue) => issue.code === 'BATTERY_SOC_CURVE_MISSING')).toBe(true);
    expect(result.samples[0]?.stateOfCharge).toBeUndefined();
    // Unchanged series formula: V = 12.6 - 10*(0.011 + 2R)
    const expected = 12.6 - 10 * (0.011 + 2 * wire.resistanceOhms);
    expect(result.samples[0]?.systemVoltage).toBeCloseTo(expected, 6);
  });

  it('tracks SoC with a test-only two-point linear curve', () => {
    // TEST-ONLY curve (not a datasheet): SoC 1 → Voc=12.6 / R=0.011, SoC 0 → Voc=11.0 / R=0.020.
    const testCurve: BatteryStateOfChargeModel = {
      capacityAh: 5,
      initialStateOfCharge: 1,
      curve: {
        points: [
          { stateOfCharge: 0, openCircuitVoltage: 11.0, internalResistanceOhms: 0.02 },
          { stateOfCharge: 1, openCircuitVoltage: 12.6, internalResistanceOhms: 0.011 },
        ],
      },
    };
    const mid = interpolateBatteryElectricals(testCurve.curve, 0.5);
    // Midpoint: Voc = (12.6+11)/2 = 11.8, R = (0.011+0.02)/2 = 0.0155
    expect(mid?.openCircuitVoltage).toBeCloseTo(11.8, 9);
    expect(mid?.internalResistanceOhms).toBeCloseTo(0.0155, 9);

    const battery = createComponent({ id: 'battery-1', type: 'Battery' }) as Battery;
    battery.stateOfChargeModel = testCurve;
    const spark = createComponent({
      id: 'spark-1',
      type: 'SparkMax',
      metadata: { continuousCurrentAmps: 10, peakCurrentAmps: 10 },
    });
    const wire = new SimWire('battery-spark', 12, 12);
    const rRt = 2 * wire.resistanceOhms;
    const loadAmps = 10;
    // Draw 10 A for 1800 s → 10*(1800/3600)=5 Ah → SoC 1→0 on a 5 Ah pack.
    const result = simulateMatch(
      [
        { t: 0, loadsByDeviceId: { 'spark-1': loadAmps } },
        { t: 1800, loadsByDeviceId: { 'spark-1': loadAmps } },
      ],
      new Map([
        [battery.id, battery],
        [spark.id, spark],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: spark.id, wire }],
    );

    const t0 = result.samples[0];
    const t1 = result.samples[1];
    // t=0, SoC=1: V_load = 12.6 - 10*(0.011 + R_rt)
    expect(t0?.stateOfCharge).toBeCloseTo(1, 9);
    expect(t0?.systemVoltage).toBeCloseTo(12.6 - loadAmps * (0.011 + rRt), 6);
    // After 5 Ah: SoC=0: V_load = 11.0 - 10*(0.020 + R_rt)
    expect(t1?.stateOfCharge).toBeCloseTo(0, 9);
    expect(t1?.systemVoltage).toBeCloseTo(11.0 - loadAmps * (0.02 + rRt), 6);
    expect(result.issues.some((issue) => issue.code === 'BATTERY_SOC_CURVE_MISSING')).toBe(false);
  });
});

describe('Kraken supply current', () => {
  it('defaults TalonFX to X60 and accepts X44 without a new device type', () => {
    const x60 = createComponent({ id: 'fx-1', type: 'TalonFX' });
    const x44 = createComponent({ id: 'fx-2', type: 'TalonFX', metadata: { variant: 'X44' } });
    expect(x60).toBeInstanceOf(MotorController);
    expect(x60.type).toBe('TalonFX');
    expect((x60 as MotorController).variant).toBe('X60');
    expect((x44 as MotorController).variant).toBe('X44');
    expect(requireKrakenNumber('X60', 'stallCurrentAmps').ok).toBe(false);
  });

  it('loads the battery with the supply limit when stator current is larger', () => {
    const statorAmps = 200;
    const supplyLimitAmps = 40;
    const dutyCycle = 1;
    expect(
      krakenSupplyCurrentAmps({ statorCurrentAmps: statorAmps, dutyCycle, supplyLimitAmps }),
    ).toBe(supplyLimitAmps);

    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const talon = createComponent({
      id: 'fx-1',
      type: 'TalonFX',
      metadata: { statorCurrentAmps: statorAmps, dutyCycle, supplyLimitAmps },
    });
    const wire = new SimWire('battery-fx', 12, 12);
    const capped = simulateVoltage(
      new Map([
        [battery.id, battery],
        [talon.id, talon],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: talon.id, wire }],
      'peak',
    );
    const seriesOhms = 0.011 + 2 * wire.resistanceOhms;
    expect(capped.totalCurrentAmps).toBeCloseTo(supplyLimitAmps, 6);
    expect(capped.deviceVoltages.find((device) => device.deviceId === 'fx-1')?.voltage).toBeCloseTo(
      12.6 - supplyLimitAmps * seriesOhms,
      6,
    );
    expect(capped.wireCurrents[0]?.currentAmps).toBeCloseTo(supplyLimitAmps, 6);

    const uncappedTalon = createComponent({
      id: 'fx-1',
      type: 'TalonFX',
      metadata: { statorCurrentAmps: statorAmps, dutyCycle },
    });
    const refused = simulateVoltage(
      new Map([
        [battery.id, battery],
        [uncappedTalon.id, uncappedTalon],
      ]),
      [{ connectionId: wire.connectionId, from: battery.id, to: uncappedTalon.id, wire }],
      'peak',
    );
    expect(refused.issues.some((issue) => issue.code === 'PLACEHOLDER_CONSTANT')).toBe(true);
    expect(refused.deviceVoltages[0]?.voltage).toBeNull();
    expect(refused.totalCurrentAmps).toBe(0);
  });
});

describe('swerve module template', () => {
  it('expands one module into a drive, a steer, and a CANcoder on a CAN chain', () => {
    const module = createSwerveModule({
      corner: 'fl',
      pdhId: 'pdh-1',
      breakers: BREAKERS,
      canUpstream: { deviceId: 'rio-1' },
    });
    expect(module.devices.map((device) => device.type)).toEqual(['TalonFX', 'TalonFX', 'CANcoder']);
    expect(module.devices.map((device) => device.metadata?.variant)).toEqual(['X60', 'X60', undefined]);
    const power = module.connections.filter((connection) => connection.targetPort === 'power_in');
    expect(power.map((connection) => connection.metadata?.fuseRatingAmps)).toEqual([
      BREAKERS.driveAmps,
      BREAKERS.steerAmps,
      BREAKERS.cancoderAmps,
    ]);
    const can = module.connections.filter((connection) => connection.sourcePort === 'can_bus');
    expect(can.map((connection) => [connection.sourceDevice, connection.targetDevice])).toEqual([
      ['rio-1', module.driveId],
      [module.driveId, module.steerId],
      [module.steerId, module.cancoderId],
    ]);
  });

  it('places four modules and a Pigeon as ordinary devices the solver already understands', () => {
    const model = createSwerveRobotModel({ breakers: BREAKERS, rioBreakerAmps: 12 });
    const swerveDevices = model.devices.filter((device) => device.id.startsWith('swerve-'));
    expect(swerveDevices).toHaveLength(13);
    expect(swerveDevices.filter((device) => device.type === 'TalonFX')).toHaveLength(8);
    expect(swerveDevices.filter((device) => device.type === 'CANcoder')).toHaveLength(4);
    expect(swerveDevices.filter((device) => device.type === 'Pigeon2')).toHaveLength(1);

    const result = simulateCircuit(model, { mode: 'continuous' });
    expect(result.can.isValidChain).toBe(true);
    expect(result.can.issues).toHaveLength(0);
    expect(result.voltage.deviceVoltages.find((device) => device.deviceId === 'swerve-fl-drive')?.voltage).not.toBeNull();
    expect(result.voltage.issues.some((issue) => issue.code === 'PLACEHOLDER_CONSTANT')).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'CAN_BRANCH_DETECTED')).toBe(false);
  });
});

describe('swerve match profiles', () => {
  function motorBus() {
    const battery = createComponent({ id: 'battery-1', type: 'Battery' });
    const pdh = createComponent({
      id: 'pdh-1',
      type: 'PDH',
      metadata: { continuousCurrentAmps: 0, peakCurrentAmps: 0 },
    });
    const motors = [...swerveDriveIds(), ...swerveSteerIds()].map((id) =>
      createComponent({
        id,
        type: 'TalonFX',
        metadata: { continuousCurrentAmps: 0, peakCurrentAmps: 0 },
      }),
    );
    const components = new Map<string, ReturnType<typeof createComponent>>([
      [battery.id, battery],
      [pdh.id, pdh],
      ...motors.map((motor) => [motor.id, motor] as const),
    ]);
    const shared = new SimWire('battery-pdh', 6, 12);
    const edges: PowerEdge[] = [
      { connectionId: shared.connectionId, from: battery.id, to: pdh.id, wire: shared },
      ...motors.map((motor) => {
        const wire = new SimWire(`pdh-${motor.id}`, 10, 12);
        return { connectionId: wire.connectionId, from: pdh.id, to: motor.id, wire };
      }),
    ];
    return { components, edges };
  }

  it('sags more in full acceleration than in steady driving, and a higher supply limit sags further', () => {
    const { components, edges } = motorBus();
    const acceleration = simulateMatch(
      buildSwervePhaseProfile({ phase: 'acceleration', supplyLimitAmps: 30 }),
      components,
      edges,
    );
    const steady = simulateMatch(
      buildSwervePhaseProfile({ phase: 'steady', supplyLimitAmps: 30 }),
      components,
      edges,
    );
    const harder = simulateMatch(
      buildSwervePhaseProfile({ phase: 'acceleration', supplyLimitAmps: 80 }),
      components,
      edges,
    );

    const accelSupply = krakenSupplyCurrentAmps({
      statorCurrentAmps: SWERVE_PHASE_STATOR.acceleration.driveStatorAmps,
      dutyCycle: 1,
      supplyLimitAmps: 30,
    });
    const steadySupply = krakenSupplyCurrentAmps({
      statorCurrentAmps: SWERVE_PHASE_STATOR.steady.driveStatorAmps,
      dutyCycle: 1,
      supplyLimitAmps: 30,
    });
    expect(accelSupply).toBeLessThan(SWERVE_PHASE_STATOR.acceleration.driveStatorAmps);
    expect(steadySupply).toBe(SWERVE_PHASE_STATOR.steady.driveStatorAmps);
    expect(acceleration.samples[0]?.totalCurrentAmps).toBeGreaterThan(steady.samples[0]?.totalCurrentAmps ?? 0);
    expect(acceleration.samples[0]?.systemVoltage).toBeLessThan(steady.samples[0]?.systemVoltage ?? 0);
    expect(harder.samples[0]?.totalCurrentAmps).toBeGreaterThan(acceleration.samples[0]?.totalCurrentAmps ?? 0);
    expect(harder.samples[0]?.systemVoltage).toBeLessThan(acceleration.samples[0]?.systemVoltage ?? 0);

    const match = buildSwerveMatchProfile({ supplyLimitAmps: 30 });
    expect(match[0]?.t).toBe(0);
    expect(match[match.length - 1]?.t).toBe(135);
    expect(match.map((sample) => sample.loadsByDeviceId[swerveDriveIds()[0] ?? ''])).toEqual([30, 10, 30, 30]);
  });
});
