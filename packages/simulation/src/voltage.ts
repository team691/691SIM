import {
  Battery,
  Breaker,
  MotorController,
  type CircuitComponent,
  type LoadMode,
} from './components.js';
import { resolveTalonBusCurrent } from './kraken.js';
import { evaluateUndervoltage, type UndervoltageDevice } from './limits.js';
import { breakerLineNodeId, buildPowerNetwork } from './network.js';
import { solvePowerNetwork, type VoltageIssue } from './solve.js';
import type { SimWire } from './wire.js';

/** RoboRIO brownout protection begins around 6.3V. */
export const BROWNOUT_VOLTAGE_THRESHOLD = 6.3;
export const BROWNOUT_MESSAGE = 'ROBORIO BROWNOUT RISK DETECTED';

export interface PowerEdge {
  connectionId: string;
  from: string;
  to: string;
  wire: SimWire;
  /**
   * Extra series resistance on this connection (ohms), stamped once in addition
   * to the wire's round-trip 2·R. Defaults to 0 (connectors, sense resistors, etc.).
   */
  seriesResistanceOhms?: number;
}

export interface WireCurrentResult {
  connectionId: string;
  from: string;
  to: string;
  gauge: number;
  lengthInches: number;
  /**
   * Round-trip resistance stamped into the solver (supply conductor + return
   * conductor). Current is not doubled: the same amps flow out and back.
   */
  resistanceOhms: number;
  currentAmps: number;
  voltageDrop: number;
  maxAmps: number;
  exceedsAmpacity: boolean;
}

export interface DeviceVoltage {
  deviceId: string;
  /** Null when the device is floating or the network could not be solved. */
  voltage: number | null;
}

/**
 * Maps a device's solved node voltage to its bus supply current (amps).
 * When omitted, the device keeps a constant current sink.
 */
export type LoadCurrentModel = (nodeVoltageVolts: number) => number;

export interface SimulateVoltageOptions {
  /** Replace steady draws for listed devices (amps). */
  loadOverride?: ReadonlyMap<string, number>;
  /**
   * Optional per-device I(V) models. When empty/undefined, the solve is a
   * single constant-current pass (bit-for-bit with the previous behavior).
   */
  loadModels?: ReadonlyMap<string, LoadCurrentModel>;
}

export const LOAD_ITERATION_TOLERANCE_VOLTS = 1e-6;
export const LOAD_ITERATION_MAX = 50;
/** Mixing factor when successive voltage updates grow (oscillation). */
export const LOAD_ITERATION_DAMPING = 0.5;

export interface VoltageSimResult {
  hasBattery: boolean;
  mode: LoadMode;
  batteryVoltage: number;
  internalResistanceOhms: number;
  totalCurrentAmps: number;
  internalVoltageDrop: number;
  /**
   * Drop from the battery terminal to the lowest solved device. This is the
   * shared path plus that device's own branch, not the sum of every wire.
   * Prefer `dropToLowestDeviceVolts` (same value; clearer name).
   */
  wireVoltageDropTotal: number;
  /**
   * Battery open-circuit voltage minus internal drop minus the lowest device
   * voltage. Depends on which device is lowest; it is not Σ wire drops.
   */
  dropToLowestDeviceVolts?: number;
  /** Lowest solved device voltage. The per-device values live on `deviceVoltages`. */
  systemVoltage: number;
  brownoutThreshold: number;
  brownoutRisk: boolean;
  wireCurrents: WireCurrentResult[];
  deviceVoltages: DeviceVoltage[];
  issues: VoltageIssue[];
  /** Devices below their datasheet minimum, deepest deficit first. */
  undervoltage: UndervoltageDevice[];
  /** The undervoltage device with the largest deficit, or null if none. */
  firstFailure: UndervoltageDevice | null;
  /** Present when voltage-dependent load iteration ran. */
  loadIterations?: number;
}

/**
 * Assumption for motor controllers: at fixed mechanical load / duty, bus
 * supply current scales approximately with available bus voltage,
 * I(V) = I_nominal · (V_node / V_nominal). Controllers and sensors without a
 * model stay constant-current. This is not a datasheet motor curve.
 */
export function motorSupplyCurrentModel(
  ampsAtNominal: number,
  nominalVoltageVolts: number,
): LoadCurrentModel {
  const vNom = nominalVoltageVolts > 0 ? nominalVoltageVolts : 12.6;
  return (nodeVoltageVolts: number) => {
    const v = Math.max(0, nodeVoltageVolts);
    return ampsAtNominal * (v / vNom);
  };
}

/** Build I(V) models for every MotorController using its resolved bus draw at V_nominal. */
export function buildMotorVoltageLoadModels(
  components: Map<string, CircuitComponent>,
  mode: LoadMode,
  nominalVoltageVolts: number,
  loadOverride?: ReadonlyMap<string, number>,
): Map<string, LoadCurrentModel> {
  const models = new Map<string, LoadCurrentModel>();
  for (const component of components.values()) {
    if (!(component instanceof MotorController)) continue;
    const override = loadOverride?.get(component.id);
    const resolved =
      override !== undefined
        ? { ok: true as const, amps: override }
        : busLoadAmps(component, mode);
    if (!resolved.ok) continue;
    models.set(component.id, motorSupplyCurrentModel(resolved.amps, nominalVoltageVolts));
  }
  return models;
}

/**
 * Per-device voltage from the nodal network.
 *
 * Each load is a current sink at its own node. A wire contributes 2·R, so the
 * return conductor is in the drop, and only wires on the path to that node
 * move its voltage. `systemVoltage` remains the lowest of those voltages so
 * existing brownout checks still have one number to read.
 */
export function simulateVoltage(
  components: Map<string, CircuitComponent>,
  powerEdges: PowerEdge[],
  mode: LoadMode = 'peak',
  loadOverride?: ReadonlyMap<string, number>,
  loadModels?: ReadonlyMap<string, LoadCurrentModel>,
): VoltageSimResult {
  const battery = [...components.values()].find(
    (component): component is Battery => component instanceof Battery,
  );
  const batteryVoltage = battery?.nominalVoltage ?? 12.6;
  const internalResistanceOhms = battery?.internalResistanceOhms ?? 0.011;
  const loads = resolveLoads(components, mode, loadOverride);
  if (!loads.ok) {
    return unsolvedResult(components, mode, battery, batteryVoltage, internalResistanceOhms, loads.issues);
  }

  const network = buildPowerNetwork(components, powerEdges);
  const hasModels = loadModels !== undefined && loadModels.size > 0;

  let amps = new Map(loads.amps);
  let solution = solvePowerNetwork(network, amps);
  let loadIterations = 0;
  const issues: VoltageIssue[] = [...solution.issues];

  if (hasModels && solution.solved) {
    let prevMaxDelta = Number.POSITIVE_INFINITY;
    let damping = 1;
    let converged = false;

    for (let iter = 0; iter < LOAD_ITERATION_MAX; iter += 1) {
      loadIterations = iter + 1;
      const prevVoltageByNode = solution.voltageByNode;
      const nextAmps = new Map(amps);

      for (const [deviceId, model] of loadModels) {
        const v = prevVoltageByNode.get(deviceId);
        if (v === undefined) continue;
        const target = model(v);
        const previous = amps.get(deviceId) ?? target;
        nextAmps.set(deviceId, (1 - damping) * previous + damping * target);
      }

      const nextSolution = solvePowerNetwork(network, nextAmps);
      if (!nextSolution.solved) {
        solution = nextSolution;
        amps = nextAmps;
        issues.push(...nextSolution.issues.filter((issue) => !issues.some((existing) => existing.code === issue.code)));
        break;
      }

      let maxDelta = 0;
      for (const [nodeId, voltage] of nextSolution.voltageByNode) {
        const previous = prevVoltageByNode.get(nodeId);
        if (previous === undefined) continue;
        maxDelta = Math.max(maxDelta, Math.abs(voltage - previous));
      }

      solution = nextSolution;
      amps = nextAmps;

      if (maxDelta < LOAD_ITERATION_TOLERANCE_VOLTS) {
        converged = true;
        break;
      }

      // If the update grew, the fixed point is oscillating — damp the next step.
      if (maxDelta > prevMaxDelta) {
        damping = LOAD_ITERATION_DAMPING;
      }
      prevMaxDelta = maxDelta;
    }

    if (!converged && solution.solved) {
      issues.push({
        code: 'LOAD_ITERATION_DIVERGED',
        message: `Voltage-dependent load iteration did not converge within ${LOAD_ITERATION_MAX} steps (tolerance ${LOAD_ITERATION_TOLERANCE_VOLTS} V). Returning the last iterate.`,
        deviceIds: [...loadModels.keys()],
      });
    }
  }

  const deviceVoltages: DeviceVoltage[] = [...components.values()].map((component) => ({
    deviceId: component.id,
    voltage: deviceVoltage(component, solution.voltageByNode),
  }));

  const solvedVoltages = deviceVoltages.flatMap((device) =>
    device.voltage === null ? [] : [device.voltage],
  );
  const systemVoltage = solvedVoltages.length > 0 ? Math.min(...solvedVoltages) : batteryVoltage;

  // Connected load current sum. With voltage-dependent models this is the
  // last iterate's sink currents on powered nodes.
  let totalCurrentAmps = 0;
  if (solution.solved) {
    for (const component of components.values()) {
      if (!solution.voltageByNode.has(component.id)) continue;
      totalCurrentAmps += amps.get(component.id) ?? 0;
    }
  }
  const internalVoltageDrop = totalCurrentAmps * internalResistanceOhms;
  const dropToLowestDeviceVolts = batteryVoltage - internalVoltageDrop - systemVoltage;
  const wireVoltageDropTotal = dropToLowestDeviceVolts;

  const wireCurrents: WireCurrentResult[] = powerEdges.map((edge) => {
    const resistor = network.resistors.find((candidate) => candidate.connectionId === edge.connectionId);
    const roundTripOhms = resistor?.resistanceOhms ?? edge.wire.resistanceOhms * 2;
    const fromVoltage = resistor ? solution.voltageByNode.get(resistor.from) : undefined;
    const toVoltage = resistor ? solution.voltageByNode.get(resistor.to) : undefined;
    const currentAmps =
      fromVoltage !== undefined && toVoltage !== undefined && roundTripOhms > 0
        ? Math.abs(fromVoltage - toVoltage) / roundTripOhms
        : 0;
    return {
      connectionId: edge.connectionId,
      from: edge.from,
      to: edge.to,
      gauge: edge.wire.gauge,
      lengthInches: edge.wire.lengthInches,
      resistanceOhms: roundTripOhms,
      currentAmps,
      voltageDrop: currentAmps * roundTripOhms,
      maxAmps: edge.wire.maxAmps,
      exceedsAmpacity: edge.wire.exceedsAmpacity(currentAmps),
    };
  });

  // Merge solver structural issues with iteration issues (dedupe by code+message).
  const mergedIssues = [...solution.issues];
  for (const issue of issues) {
    if (
      !mergedIssues.some(
        (existing) => existing.code === issue.code && existing.message === issue.message,
      )
    ) {
      mergedIssues.push(issue);
    }
  }

  return {
    hasBattery: battery !== undefined,
    mode,
    batteryVoltage,
    internalResistanceOhms,
    totalCurrentAmps,
    internalVoltageDrop,
    wireVoltageDropTotal,
    dropToLowestDeviceVolts,
    systemVoltage,
    brownoutThreshold: BROWNOUT_VOLTAGE_THRESHOLD,
    brownoutRisk: battery !== undefined && solution.solved && systemVoltage < BROWNOUT_VOLTAGE_THRESHOLD,
    wireCurrents,
    deviceVoltages,
    issues: mergedIssues,
    loadIterations: hasModels ? loadIterations : undefined,
    ...evaluateUndervoltage(
      deviceVoltages.map((row) => ({
        deviceId: row.deviceId,
        type: components.get(row.deviceId)?.type ?? '',
        voltage: row.voltage,
        minVoltage: components.get(row.deviceId)?.minVoltage ?? null,
      })),
    ),
  };
}

function resolveLoads(
  components: Map<string, CircuitComponent>,
  mode: LoadMode,
  loadOverride: ReadonlyMap<string, number> | undefined,
): { ok: true; amps: Map<string, number> } | { ok: false; issues: VoltageIssue[] } {
  const amps = new Map<string, number>();
  const issues: VoltageIssue[] = [];
  for (const component of components.values()) {
    const override = loadOverride?.get(component.id);
    if (override !== undefined) {
      amps.set(component.id, override);
      continue;
    }
    const resolved = busLoadAmps(component, mode);
    if (!resolved.ok) {
      issues.push(resolved.issue);
      continue;
    }
    amps.set(component.id, resolved.amps);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, amps };
}

/**
 * Legacy devices use continuous/peak draw. A Talon with a stator current
 * contributes its supply current instead, which can refuse the sim.
 */
function busLoadAmps(
  component: CircuitComponent,
  mode: LoadMode,
): { ok: true; amps: number } | { ok: false; issue: VoltageIssue } {
  if (component instanceof MotorController && component.type === 'TalonFX' && component.variant) {
    return resolveTalonBusCurrent({
      deviceId: component.id,
      variant: component.variant,
      variantError: component.variantError,
      statorCurrentAmps: component.statorCurrentAmps,
      dutyCycle: component.dutyCycle,
      supplyLimitAmps: component.supplyLimitAmps,
      legacyAmps: component.currentDraw(mode),
    });
  }
  if (component instanceof MotorController && component.variantError) {
    return {
      ok: false,
      issue: {
        code: 'TALON_SUPPLY_UNRESOLVED',
        message: component.variantError,
        deviceIds: [component.id],
      },
    };
  }
  return { ok: true, amps: component.currentDraw(mode) };
}

function unsolvedResult(
  components: Map<string, CircuitComponent>,
  mode: LoadMode,
  battery: Battery | undefined,
  batteryVoltage: number,
  internalResistanceOhms: number,
  issues: VoltageIssue[],
): VoltageSimResult {
  return {
    hasBattery: battery !== undefined,
    mode,
    batteryVoltage,
    internalResistanceOhms,
    totalCurrentAmps: 0,
    internalVoltageDrop: 0,
    wireVoltageDropTotal: 0,
    dropToLowestDeviceVolts: 0,
    systemVoltage: batteryVoltage,
    brownoutThreshold: BROWNOUT_VOLTAGE_THRESHOLD,
    brownoutRisk: false,
    wireCurrents: [],
    deviceVoltages: [...components.values()].map((component) => ({
      deviceId: component.id,
      voltage: null,
    })),
    issues,
    undervoltage: [],
    firstFailure: null,
  };
}

/**
 * Device voltage is the load-side node. An open breaker has no load-side
 * solution, so the line-side stud is reported instead when that stud is powered.
 */
function deviceVoltage(component: CircuitComponent, voltageByNode: ReadonlyMap<string, number>): number | null {
  const direct = voltageByNode.get(component.id);
  if (direct !== undefined) return direct;
  if (component instanceof Breaker) {
    const line = voltageByNode.get(breakerLineNodeId(component.id));
    if (line !== undefined) return line;
  }
  return null;
}
