import {
  interpolateBatteryElectricals,
  isBatterySocModelUsable,
} from './batterySoc.js';
import { Battery, type CircuitComponent, type LoadMode } from './components.js';
import type { UndervoltageDevice } from './limits.js';
import type { VoltageIssue } from './solve.js';
import {
  simulateVoltage,
  type DeviceVoltage,
  type PowerEdge,
  type WireCurrentResult,
} from './voltage.js';

/** An FRC match, from the start of auto through the end of teleop. */
export const MATCH_DURATION_SECONDS = 135;

export interface MatchLoadSample {
  /** Seconds from match start. */
  t: number;
  /** Supply current (amps) drawn by each listed device at this instant. */
  loadsByDeviceId: Readonly<Record<string, number>>;
}

export interface MatchVoltageSample {
  t: number;
  deviceVoltages: DeviceVoltage[];
  systemVoltage: number;
  /**
   * Lowest solved RoboRIO voltage at this sample, or null when no powered
   * RoboRIO is in the model.
   */
  roborioVoltage: number | null;
  totalCurrentAmps: number;
  batteryVoltage: number;
  internalVoltageDrop: number;
  /** Per-connection currents and drops from this sample's solve. */
  wireCurrents: WireCurrentResult[];
  undervoltage: UndervoltageDevice[];
  /** Present when a usable battery SoC model drove this sample. */
  stateOfCharge?: number;
}

export interface FirstBrownout {
  t: number;
  deviceId: string;
  voltage: number;
  minVoltage: number;
}

export interface MatchSimResult {
  samples: MatchVoltageSample[];
  /** Earliest sample at which any device is below its minimum. */
  firstBrownout: FirstBrownout | null;
  issues: VoltageIssue[];
}

function cloneComponents(
  components: Map<string, CircuitComponent>,
): Map<string, CircuitComponent> {
  return new Map(components);
}

function lowestRoborioVoltage(
  components: Map<string, CircuitComponent>,
  deviceVoltages: DeviceVoltage[],
): number | null {
  const voltages = deviceVoltages.flatMap((row) => {
    if (row.voltage === null) return [];
    if (components.get(row.deviceId)?.type !== 'RoboRIO') return [];
    return [row.voltage];
  });
  return voltages.length > 0 ? Math.min(...voltages) : null;
}

/**
 * Solve the power network at each sample of a match profile.
 *
 * `loadsByDeviceId` replaces that device's steady draw for the sample and is
 * already supply current: callers convert stator current before it gets here.
 * Devices missing from a sample keep their component draw for `mode`
 * (`continuous` by default; pass `peak` for worst-case flat profiles).
 * The first brownout is the earliest time a device with a known minimum falls
 * below it.
 *
 * When the battery has a usable SoC model, open-circuit voltage and internal
 * resistance are updated between samples by coulomb counting. If the model is
 * present but the curve/capacity are still placeholders (null), SoC is ignored
 * and `BATTERY_SOC_CURVE_MISSING` is reported.
 */
export function simulateMatch(
  profile: readonly MatchLoadSample[],
  components: Map<string, CircuitComponent>,
  powerEdges: PowerEdge[],
  mode: LoadMode = 'continuous',
): MatchSimResult {
  const ordered = [...profile].sort((a, b) => a.t - b.t);
  const samples: MatchVoltageSample[] = [];
  let firstBrownout: FirstBrownout | null = null;
  const issues: VoltageIssue[] = [];

  const battery = [...components.values()].find(
    (component): component is Battery => component instanceof Battery,
  );
  const socModel = battery?.stateOfChargeModel ?? null;
  const socRequested = socModel !== null;
  const socUsable = isBatterySocModelUsable(socModel);

  if (socRequested && !socUsable) {
    issues.push({
      code: 'BATTERY_SOC_CURVE_MISSING',
      message:
        'Battery has a state-of-charge model but capacityAh and/or the Voc/R_int curve are still placeholders (null). SoC tracking is ignored for this match.',
      deviceIds: battery ? [battery.id] : [],
    });
  }

  let stateOfCharge = socUsable ? socModel!.initialStateOfCharge : null;
  let ampHoursUsed = 0;

  for (let index = 0; index < ordered.length; index += 1) {
    const sample = ordered[index]!;
    const working = cloneComponents(components);

    if (socUsable && battery && stateOfCharge !== null) {
      const electrical = interpolateBatteryElectricals(socModel!.curve, stateOfCharge);
      if (!electrical) {
        issues.push({
          code: 'BATTERY_SOC_CURVE_MISSING',
          message: 'Battery SoC curve interpolation failed; ignoring SoC for remaining samples.',
          deviceIds: [battery.id],
        });
        stateOfCharge = null;
      } else {
        working.set(battery.id, battery.withElectricals(
          electrical.openCircuitVoltage,
          electrical.internalResistanceOhms,
        ));
      }
    }

    const result = simulateVoltage(
      working,
      powerEdges,
      mode,
      new Map(Object.entries(sample.loadsByDeviceId)),
    );
    if (result.issues.some((issue) => issue.code === 'PLACEHOLDER_CONSTANT' || issue.code === 'TALON_SUPPLY_UNRESOLVED')) {
      return { samples, firstBrownout, issues: [...issues, ...result.issues] };
    }

    const matchSample: MatchVoltageSample = {
      t: sample.t,
      deviceVoltages: result.deviceVoltages,
      systemVoltage: result.systemVoltage,
      roborioVoltage: lowestRoborioVoltage(working, result.deviceVoltages),
      totalCurrentAmps: result.totalCurrentAmps,
      batteryVoltage: result.batteryVoltage,
      internalVoltageDrop: result.internalVoltageDrop,
      wireCurrents: result.wireCurrents,
      undervoltage: result.undervoltage,
    };
    if (socUsable && stateOfCharge !== null) {
      matchSample.stateOfCharge = stateOfCharge;
    }
    samples.push(matchSample);

    if (firstBrownout === null && result.firstFailure) {
      firstBrownout = {
        t: sample.t,
        deviceId: result.firstFailure.deviceId,
        voltage: result.firstFailure.voltage,
        minVoltage: result.firstFailure.minVoltage,
      };
    }

    // Coulomb count over the interval to the next sample (left Riemann).
    const next = ordered[index + 1];
    if (socUsable && stateOfCharge !== null && next && socModel?.capacityAh) {
      const dt = next.t - sample.t;
      if (dt > 0) {
        ampHoursUsed += (result.totalCurrentAmps * dt) / 3600;
        stateOfCharge = Math.min(
          1,
          Math.max(0, socModel.initialStateOfCharge - ampHoursUsed / socModel.capacityAh),
        );
      }
    }
  }

  return { samples, firstBrownout, issues };
}
