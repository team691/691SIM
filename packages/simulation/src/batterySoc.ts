/**
 * Battery state-of-charge helpers for match simulation.
 *
 * The Voc(SoC) and R_int(SoC) curves are datasheet or measured values. The
 * default curve is intentionally null — do not invent numbers here.
 */

export interface BatterySocPoint {
  /** Fraction of remaining capacity, 0 (empty) to 1 (full). */
  stateOfCharge: number;
  /** Open-circuit voltage at this SoC. Null until a datasheet value is entered. */
  openCircuitVoltage: number | null;
  /** Internal resistance at this SoC. Null until a datasheet value is entered. */
  internalResistanceOhms: number | null;
}

export interface BatterySocCurve {
  /**
   * PLACEHOLDER CURVE — points are null by default.
   * When non-null, points must be sorted by ascending stateOfCharge and every
   * openCircuitVoltage / internalResistanceOhms entry used for interpolation
   * must be a finite number (not null).
   */
  points: BatterySocPoint[] | null;
}

export interface BatteryStateOfChargeModel {
  /**
   * Amp-hour capacity used for coulomb counting.
   * TODO(arihant): datasheet value
   */
  capacityAh: number | null;
  /** Initial SoC at match start, 0..1. */
  initialStateOfCharge: number;
  /**
   * PLACEHOLDER: SoC → Voc / R_int. Null means simulateMatch must ignore SoC.
   * TODO(arihant): datasheet value
   */
  curve: BatterySocCurve | null;
}

export interface BatteryElectricalAtSoc {
  openCircuitVoltage: number;
  internalResistanceOhms: number;
}

/** Default model with every datasheet field null — SoC tracking is disabled. */
export function placeholderBatterySocModel(
  initialStateOfCharge = 1,
): BatteryStateOfChargeModel {
  return {
    capacityAh: null, // TODO(arihant): datasheet value
    initialStateOfCharge,
    curve: { points: null }, // TODO(arihant): datasheet value
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Piecewise-linear interpolation of Voc and R_int vs SoC.
 * Returns null when the curve is missing or any bracket value is null.
 */
export function interpolateBatteryElectricals(
  curve: BatterySocCurve | null | undefined,
  stateOfCharge: number,
): BatteryElectricalAtSoc | null {
  const points = curve?.points;
  if (!points || points.length === 0) return null;

  const soc = Math.min(1, Math.max(0, stateOfCharge));
  const sorted = [...points].sort((a, b) => a.stateOfCharge - b.stateOfCharge);

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (
    first.openCircuitVoltage === null ||
    first.internalResistanceOhms === null ||
    last.openCircuitVoltage === null ||
    last.internalResistanceOhms === null
  ) {
    return null;
  }

  if (soc <= first.stateOfCharge) {
    return {
      openCircuitVoltage: first.openCircuitVoltage,
      internalResistanceOhms: first.internalResistanceOhms,
    };
  }
  if (soc >= last.stateOfCharge) {
    return {
      openCircuitVoltage: last.openCircuitVoltage,
      internalResistanceOhms: last.internalResistanceOhms,
    };
  }

  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1]!;
    const hi = sorted[i]!;
    if (soc > hi.stateOfCharge) continue;
    if (
      lo.openCircuitVoltage === null ||
      lo.internalResistanceOhms === null ||
      hi.openCircuitVoltage === null ||
      hi.internalResistanceOhms === null
    ) {
      return null;
    }
    const span = hi.stateOfCharge - lo.stateOfCharge;
    const t = span === 0 ? 0 : (soc - lo.stateOfCharge) / span;
    return {
      openCircuitVoltage: lerp(lo.openCircuitVoltage, hi.openCircuitVoltage, t),
      internalResistanceOhms: lerp(lo.internalResistanceOhms, hi.internalResistanceOhms, t),
    };
  }

  return null;
}

/** True when capacity and a fully numeric curve are present. */
export function isBatterySocModelUsable(model: BatteryStateOfChargeModel | null | undefined): boolean {
  if (!model || model.capacityAh === null || model.capacityAh <= 0) return false;
  if (!model.curve?.points || model.curve.points.length < 2) return false;
  return model.curve.points.every(
    (point) =>
      point.openCircuitVoltage !== null &&
      point.internalResistanceOhms !== null &&
      Number.isFinite(point.openCircuitVoltage) &&
      Number.isFinite(point.internalResistanceOhms),
  );
}
