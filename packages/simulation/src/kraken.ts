import type { VoltageIssue } from './solve.js';

/** Talon FX motor paired with the controller. Default is X60 so existing models stay put. */
export type KrakenVariant = 'X60' | 'X44';

export interface KrakenVariantSpec {
  freeSpeedRpm: number | null;
  stallCurrentAmps: number | null;
  stallTorqueNm: number | null;
  defaultSupplyCurrentLimitAmps: number | null;
  defaultStatorCurrentLimitAmps: number | null;
}

/**
 * Datasheet columns for each Kraken. Every number is still a placeholder.
 * `requireKrakenNumber` refuses a sim that would need one of these.
 */
export const KRAKEN_VARIANTS: Record<KrakenVariant, KrakenVariantSpec> = {
  X60: {
    // TODO(arihant): verify against CTRE datasheet
    freeSpeedRpm: null,
    // TODO(arihant): verify against CTRE datasheet
    stallCurrentAmps: null,
    // TODO(arihant): verify against CTRE datasheet
    stallTorqueNm: null,
    // TODO(arihant): verify against CTRE datasheet
    defaultSupplyCurrentLimitAmps: null,
    // TODO(arihant): verify against CTRE datasheet
    defaultStatorCurrentLimitAmps: null,
  },
  X44: {
    // TODO(arihant): verify against CTRE datasheet
    freeSpeedRpm: null,
    // TODO(arihant): verify against CTRE datasheet
    stallCurrentAmps: null,
    // TODO(arihant): verify against CTRE datasheet
    stallTorqueNm: null,
    // TODO(arihant): verify against CTRE datasheet
    defaultSupplyCurrentLimitAmps: null,
    // TODO(arihant): verify against CTRE datasheet
    defaultStatorCurrentLimitAmps: null,
  },
};

export interface TalonSupplyInput {
  statorCurrentAmps: number;
  /** Fraction of the PWM period the bridge is on, from 0 to 1. */
  dutyCycle: number;
  supplyLimitAmps: number;
}

/**
 * Battery current for one Talon FX.
 *
 * The stator current is the current in the motor windings. The battery does
 * not carry that whole current. It carries the winding current scaled by how
 * much of the time the output stage is on, and the supply-current limit caps
 * the result:
 *
 *   battery-side current = min(supplyLimit, stator current × duty cycle)
 *
 * The nodal solver must be loaded with this supply current, never the stator
 * current. A 200 A stator at a 40 A supply limit pulls 40 A from the battery.
 */
export function krakenSupplyCurrentAmps(input: TalonSupplyInput): number {
  const duty = Math.min(1, Math.max(0, input.dutyCycle));
  const stator = Math.max(0, input.statorCurrentAmps);
  const limit = Math.max(0, input.supplyLimitAmps);
  return Math.min(limit, stator * duty);
}

export function readTalonVariant(
  metadata: Record<string, unknown> | undefined,
): { ok: true; variant: KrakenVariant } | { ok: false; message: string } {
  const raw = metadata?.variant;
  if (raw === undefined) return { ok: true, variant: 'X60' };
  if (raw === 'X60' || raw === 'X44') return { ok: true, variant: raw };
  return {
    ok: false,
    message: `TalonFX variant ${String(raw)} is not supported. Use 'X60' or 'X44'.`,
  };
}

/** Read one datasheet field. A null placeholder refuses the sim instead of inventing a number. */
export function requireKrakenNumber(
  variant: KrakenVariant,
  field: keyof KrakenVariantSpec,
): { ok: true; value: number } | { ok: false; message: string } {
  const value = KRAKEN_VARIANTS[variant][field];
  if (value === null) {
    return {
      ok: false,
      message: `TalonFX ${variant} ${field} is still a placeholder. Refusing to simulate until it is verified against the CTRE datasheet.`,
    };
  }
  return { ok: true, value };
}

export interface TalonBusRequest {
  deviceId: string;
  variant: KrakenVariant;
  variantError?: string;
  /** Absent when this Talon should keep its legacy continuous/peak draw. */
  statorCurrentAmps?: number;
  dutyCycle?: number;
  /** Explicit limit. When absent, the datasheet default is required. */
  supplyLimitAmps?: number;
  legacyAmps: number;
}

export type TalonBusLoad = { ok: true; amps: number } | { ok: false; issue: VoltageIssue };

/**
 * Amps to stamp on the battery bus for one Talon. Legacy models that never
 * set a stator current keep their existing draw. A stator current is converted
 * to supply current, and a missing datasheet limit refuses the whole sim.
 */
export function resolveTalonBusCurrent(request: TalonBusRequest): TalonBusLoad {
  if (request.variantError) {
    return {
      ok: false,
      issue: {
        code: 'TALON_SUPPLY_UNRESOLVED',
        message: request.variantError,
        deviceIds: [request.deviceId],
      },
    };
  }

  if (request.statorCurrentAmps === undefined) {
    return { ok: true, amps: request.legacyAmps };
  }

  if (request.dutyCycle === undefined) {
    return {
      ok: false,
      issue: {
        code: 'TALON_SUPPLY_UNRESOLVED',
        message: `${request.deviceId} has a stator current but no duty cycle, so supply current is undefined.`,
        deviceIds: [request.deviceId],
      },
    };
  }

  let supplyLimit = request.supplyLimitAmps;
  if (supplyLimit === undefined) {
    const required = requireKrakenNumber(request.variant, 'defaultSupplyCurrentLimitAmps');
    if (!required.ok) {
      return {
        ok: false,
        issue: {
          code: 'PLACEHOLDER_CONSTANT',
          message: required.message,
          deviceIds: [request.deviceId],
        },
      };
    }
    supplyLimit = required.value;
  }

  return {
    ok: true,
    amps: krakenSupplyCurrentAmps({
      statorCurrentAmps: request.statorCurrentAmps,
      dutyCycle: request.dutyCycle,
      supplyLimitAmps: supplyLimit,
    }),
  };
}
