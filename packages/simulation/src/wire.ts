import type { Connection } from '@691sim/core';

/** Standard copper wire gauges used in FRC wiring. */
export type AwgGauge = 6 | 10 | 12 | 14 | 18;

export const SUPPORTED_GAUGES: readonly AwgGauge[] = [6, 10, 12, 14, 18] as const;

export interface AwgSpec {
  gauge: AwgGauge;
  /** Resistance of solid copper conductor, ohms per foot (round-trip ignored). */
  ohmsPerFoot: number;
  /** Conservative continuous ampacity (max amps) for chassis wiring. */
  maxAmps: number;
  label: string;
}

/**
 * Resistance-per-foot from standard copper AWG tables. Ampacity values are
 * conservative continuous-current ratings appropriate for FRC chassis wiring.
 */
export const AWG_TABLE: Record<AwgGauge, AwgSpec> = {
  6: { gauge: 6, ohmsPerFoot: 0.0003951, maxAmps: 120, label: '6 AWG' },
  10: { gauge: 10, ohmsPerFoot: 0.0009989, maxAmps: 55, label: '10 AWG' },
  12: { gauge: 12, ohmsPerFoot: 0.001588, maxAmps: 41, label: '12 AWG' },
  14: { gauge: 14, ohmsPerFoot: 0.002525, maxAmps: 32, label: '14 AWG' },
  18: { gauge: 18, ohmsPerFoot: 0.006385, maxAmps: 16, label: '18 AWG' },
};

export const DEFAULT_WIRE_GAUGE: AwgGauge = 12;
export const DEFAULT_WIRE_LENGTH_INCHES = 24;
/** Reference temperature for AWG table ohms-per-foot values. */
export const WIRE_REFERENCE_TEMPERATURE_C = 20;
/**
 * Copper resistance temperature coefficient (per °C) near 20 °C.
 * R(T) = R_20 · (1 + α · (T − 20)).
 */
export const COPPER_RESISTANCE_TEMP_COEFF_PER_C = 0.00393;

function coerceGauge(value: unknown, fallback: AwgGauge): AwgGauge {
  const n = typeof value === 'number' ? value : Number(value);
  return (SUPPORTED_GAUGES as readonly number[]).includes(n) ? (n as AwgGauge) : fallback;
}

function coerceLength(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * A physical wire with a gauge and length. Encapsulates the electrical
 * behaviour (resistance, voltage drop, ampacity) independent of any UI.
 */
export class SimWire {
  readonly connectionId: string;
  readonly gauge: AwgGauge;
  readonly lengthInches: number;
  /** Conductor temperature in °C. Defaults to the AWG table reference (20 °C). */
  readonly temperatureCelsius: number;

  constructor(
    connectionId: string,
    gauge: AwgGauge,
    lengthInches: number,
    temperatureCelsius: number = WIRE_REFERENCE_TEMPERATURE_C,
  ) {
    this.connectionId = connectionId;
    this.gauge = gauge;
    this.lengthInches = lengthInches;
    this.temperatureCelsius = temperatureCelsius;
  }

  get spec(): AwgSpec {
    return AWG_TABLE[this.gauge];
  }

  get lengthFeet(): number {
    return this.lengthInches / 12;
  }

  /** Resistance at the AWG table reference temperature (20 °C), before the copper temp factor. */
  get resistanceOhmsAt20C(): number {
    return this.spec.ohmsPerFoot * this.lengthFeet;
  }

  /**
   * Conductor resistance for this wire, in ohms, at `temperatureCelsius`.
   * R(T) = R_20 · (1 + 0.00393 · (T − 20)).
   */
  get resistanceOhms(): number {
    const deltaT = this.temperatureCelsius - WIRE_REFERENCE_TEMPERATURE_C;
    return this.resistanceOhmsAt20C * (1 + COPPER_RESISTANCE_TEMP_COEFF_PER_C * deltaT);
  }

  get maxAmps(): number {
    return this.spec.maxAmps;
  }

  /** Voltage dropped across this wire when carrying `currentAmps` (V = I·R). */
  voltageDrop(currentAmps: number): number {
    return currentAmps * this.resistanceOhms;
  }

  exceedsAmpacity(currentAmps: number): boolean {
    return currentAmps > this.maxAmps;
  }
}

/** Read AWG gauge/length from a connection's metadata, applying defaults. */
export function wireFromConnection(
  connection: Connection,
  defaultGauge: AwgGauge = DEFAULT_WIRE_GAUGE,
  defaultLengthInches: number = DEFAULT_WIRE_LENGTH_INCHES,
): SimWire {
  const meta = connection.metadata ?? {};
  const gauge = coerceGauge(meta.gauge, defaultGauge);
  const lengthInches = coerceLength(meta.lengthInches, defaultLengthInches);
  return new SimWire(connection.id, gauge, lengthInches);
}
