import type { CircuitComponent } from './components.js';
import type { UndervoltageDevice } from './limits.js';
import type { VoltageIssue } from './solve.js';
import {
  simulateVoltage,
  type DeviceVoltage,
  type PowerEdge,
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
  totalCurrentAmps: number;
  undervoltage: UndervoltageDevice[];
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

/**
 * Solve the power network at each sample of a match profile.
 *
 * `loadsByDeviceId` replaces that device's steady draw for the sample and is
 * already supply current: callers convert stator current before it gets here.
 * Devices missing from a sample keep their component draw. The first brownout
 * is the earliest time a device with a known minimum falls below it.
 */
export function simulateMatch(
  profile: readonly MatchLoadSample[],
  components: Map<string, CircuitComponent>,
  powerEdges: PowerEdge[],
): MatchSimResult {
  const ordered = [...profile].sort((a, b) => a.t - b.t);
  const samples: MatchVoltageSample[] = [];
  let firstBrownout: FirstBrownout | null = null;

  for (const sample of ordered) {
    const result = simulateVoltage(
      components,
      powerEdges,
      'continuous',
      new Map(Object.entries(sample.loadsByDeviceId)),
    );
    if (result.issues.some((issue) => issue.code === 'PLACEHOLDER_CONSTANT' || issue.code === 'TALON_SUPPLY_UNRESOLVED')) {
      return { samples, firstBrownout, issues: result.issues };
    }

    samples.push({
      t: sample.t,
      deviceVoltages: result.deviceVoltages,
      systemVoltage: result.systemVoltage,
      totalCurrentAmps: result.totalCurrentAmps,
      undervoltage: result.undervoltage,
    });

    if (firstBrownout === null && result.firstFailure) {
      firstBrownout = {
        t: sample.t,
        deviceId: result.firstFailure.deviceId,
        voltage: result.firstFailure.voltage,
        minVoltage: result.firstFailure.minVoltage,
      };
    }
  }

  return { samples, firstBrownout, issues: [] };
}
