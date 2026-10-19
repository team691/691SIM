import { DeviceCategory, type DeviceDefinition, type DeviceInstance } from '@691sim/core';
import type { BatteryStateOfChargeModel } from './batterySoc.js';
import type { KrakenVariant } from './kraken.js';
import { readTalonVariant } from './kraken.js';
import { minVoltageForType } from './limits.js';

/** Whether a component is evaluated at its steady-state or worst-case draw. */
export type LoadMode = 'continuous' | 'peak';

export const DEFAULT_MAX_VOLTAGE = 12.6;
export const BATTERY_NOMINAL_VOLTAGE = 12.6;
export const BATTERY_INTERNAL_RESISTANCE_OHM = 0.011;

export interface CurrentProfile {
  continuousAmps: number;
  peakAmps: number;
  maxVoltage: number;
}

/**
 * Realistic default current draws (amps) per device type. These describe the
 * load a device places on the 12V bus, not the electronics idle draw.
 */
const CURRENT_DEFAULTS: Record<string, CurrentProfile> = {
  Battery: { continuousAmps: 0, peakAmps: 0, maxVoltage: BATTERY_NOMINAL_VOLTAGE },
  RoboRIO: { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE },
  SystemCore: { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE },
  PDH: { continuousAmps: 0.1, peakAmps: 0.2, maxVoltage: DEFAULT_MAX_VOLTAGE },
  PDP: { continuousAmps: 0.1, peakAmps: 0.2, maxVoltage: DEFAULT_MAX_VOLTAGE },
  VRM: { continuousAmps: 0.5, peakAmps: 1, maxVoltage: DEFAULT_MAX_VOLTAGE },
  SparkMax: { continuousAmps: 30, peakAmps: 50, maxVoltage: DEFAULT_MAX_VOLTAGE },
  SparkFlex: { continuousAmps: 40, peakAmps: 60, maxVoltage: DEFAULT_MAX_VOLTAGE },
  TalonFX: { continuousAmps: 40, peakAmps: 60, maxVoltage: DEFAULT_MAX_VOLTAGE },
  CANcoder: { continuousAmps: 0.1, peakAmps: 0.15, maxVoltage: DEFAULT_MAX_VOLTAGE },
  Pigeon2: { continuousAmps: 0.1, peakAmps: 0.15, maxVoltage: DEFAULT_MAX_VOLTAGE },
  Limelight: { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE },
  PhotonVision: { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE },
  OrangePi: { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE },
  Radio: { continuousAmps: 1, peakAmps: 1.5, maxVoltage: DEFAULT_MAX_VOLTAGE },
  EthernetSwitch: { continuousAmps: 0.5, peakAmps: 0.7, maxVoltage: DEFAULT_MAX_VOLTAGE },
  // TODO(arihant): datasheet value
  CANivore: { continuousAmps: 0, peakAmps: 0, maxVoltage: DEFAULT_MAX_VOLTAGE },
};

const FALLBACK_PROFILE: CurrentProfile = {
  continuousAmps: 1,
  peakAmps: 1.5,
  maxVoltage: DEFAULT_MAX_VOLTAGE,
};

export interface ComponentInit {
  id: string;
  type: string;
  canId?: number;
  maxVoltage: number;
  continuousCurrentAmps: number;
  peakCurrentAmps: number;
  /** Null until a datasheet minimum is known. The roboRIO uses 6.3 V. */
  minVoltage: number | null;
}

/**
 * Base class for every simulated FRC component. Tracks the electrical limits
 * the simulation engine reasons about: voltage ceiling, continuous vs. peak
 * current draw, and an optional CAN ID. Pure model — no rendering concerns.
 */
export abstract class CircuitComponent {
  readonly id: string;
  readonly type: string;
  canId?: number;
  maxVoltage: number;
  continuousCurrentAmps: number;
  peakCurrentAmps: number;
  /** Lowest acceptable bus voltage. Null means the datasheet value is not entered yet. */
  minVoltage: number | null;

  constructor(init: ComponentInit) {
    this.id = init.id;
    this.type = init.type;
    this.canId = init.canId;
    this.maxVoltage = init.maxVoltage;
    this.continuousCurrentAmps = init.continuousCurrentAmps;
    this.peakCurrentAmps = init.peakCurrentAmps;
    this.minVoltage = init.minVoltage;
  }

  /** Current this component draws from the 12V bus in the given load mode. */
  currentDraw(mode: LoadMode = 'continuous'): number {
    return mode === 'peak' ? this.peakCurrentAmps : this.continuousCurrentAmps;
  }

  /** Whether this component supplies power to the bus (only the battery does). */
  isPowerSource(): boolean {
    return false;
  }

  abstract readonly category: string;
}

export class Battery extends CircuitComponent {
  readonly category = 'battery';
  readonly nominalVoltage: number;
  readonly internalResistanceOhms: number;
  /**
   * Optional coulomb-counting model for match sims. When null/undefined,
   * simulateMatch leaves Voc and R_int fixed (previous behavior).
   */
  stateOfChargeModel: BatteryStateOfChargeModel | null;

  constructor(
    init: ComponentInit,
    nominalVoltage: number = BATTERY_NOMINAL_VOLTAGE,
    internalResistanceOhms: number = BATTERY_INTERNAL_RESISTANCE_OHM,
    stateOfChargeModel: BatteryStateOfChargeModel | null = null,
  ) {
    super(init);
    this.nominalVoltage = nominalVoltage;
    this.internalResistanceOhms = internalResistanceOhms;
    this.stateOfChargeModel = stateOfChargeModel;
  }

  override isPowerSource(): boolean {
    return true;
  }

  override currentDraw(): number {
    return 0;
  }

  /** Copy with different Voc / R_int, preserving the SoC model reference. */
  withElectricals(openCircuitVoltage: number, internalResistanceOhms: number): Battery {
    return new Battery(
      {
        id: this.id,
        type: this.type,
        canId: this.canId,
        maxVoltage: this.maxVoltage,
        continuousCurrentAmps: this.continuousCurrentAmps,
        peakCurrentAmps: this.peakCurrentAmps,
        minVoltage: this.minVoltage,
      },
      openCircuitVoltage,
      internalResistanceOhms,
      this.stateOfChargeModel,
    );
  }
}

export class Controller extends CircuitComponent {
  readonly category = 'controller';
}

export class PowerDistribution extends CircuitComponent {
  readonly category = 'power-distribution';
}

export class VoltageRegulator extends CircuitComponent {
  readonly category = 'voltage-regulator';
}

export interface MotorBehavior {
  variant?: KrakenVariant;
  /** Set when metadata names a variant that is not X60 or X44. */
  variantError?: string;
  statorCurrentAmps?: number;
  dutyCycle?: number;
  supplyLimitAmps?: number;
}

export class MotorController extends CircuitComponent {
  readonly category = 'motor-controller';
  /** TalonFX only. Defaults to X60 when metadata omits `variant`. */
  readonly variant: KrakenVariant | undefined;
  readonly variantError: string | undefined;
  readonly statorCurrentAmps: number | undefined;
  readonly dutyCycle: number | undefined;
  readonly supplyLimitAmps: number | undefined;

  constructor(init: ComponentInit, behavior: MotorBehavior = {}) {
    super(init);
    this.variant = behavior.variant;
    this.variantError = behavior.variantError;
    this.statorCurrentAmps = behavior.statorCurrentAmps;
    this.dutyCycle = behavior.dutyCycle;
    this.supplyLimitAmps = behavior.supplyLimitAmps;
  }
}

export class GenericLoad extends CircuitComponent {
  readonly category = 'load';
}

export class Breaker extends CircuitComponent {
  readonly category = 'breaker';
  readonly isClosed: boolean;

  constructor(init: ComponentInit, isClosed = true) {
    super(init);
    this.isClosed = isClosed;
  }

  blocksDownstreamPower(): boolean {
    return !this.isClosed;
  }

  override currentDraw(): number {
    return 0;
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveMinVoltage(instance: DeviceInstance): number | null {
  const override = instance.metadata?.minVoltage;
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  return minVoltageForType(instance.type);
}

function resolveProfile(
  instance: DeviceInstance,
  definition?: DeviceDefinition,
): CurrentProfile {
  const base = CURRENT_DEFAULTS[instance.type] ?? categoryProfile(definition) ?? FALLBACK_PROFILE;
  const meta = instance.metadata ?? {};
  return {
    continuousAmps: num(meta.continuousCurrentAmps, base.continuousAmps),
    peakAmps: num(meta.peakCurrentAmps, base.peakAmps),
    maxVoltage: num(meta.maxVoltage, base.maxVoltage),
  };
}

function categoryProfile(definition?: DeviceDefinition): CurrentProfile | undefined {
  if (!definition) return undefined;
  switch (definition.category) {
    case DeviceCategory.MOTOR_CONTROLLER:
      return { continuousAmps: 30, peakAmps: 50, maxVoltage: DEFAULT_MAX_VOLTAGE };
    case DeviceCategory.CONTROLLER:
      return { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE };
    case DeviceCategory.VISION:
      return { continuousAmps: 2, peakAmps: 3, maxVoltage: DEFAULT_MAX_VOLTAGE };
    case DeviceCategory.SENSOR:
      return { continuousAmps: 0.1, peakAmps: 0.2, maxVoltage: DEFAULT_MAX_VOLTAGE };
    case DeviceCategory.NETWORK:
      return { continuousAmps: 1, peakAmps: 1.5, maxVoltage: DEFAULT_MAX_VOLTAGE };
    default:
      return undefined;
  }
}

/** Instantiate the appropriate `CircuitComponent` subclass for a device. */
export function createComponent(
  instance: DeviceInstance,
  definition?: DeviceDefinition,
): CircuitComponent {
  const profile = resolveProfile(instance, definition);
  const rawCanId = instance.metadata?.canId;
  const canId = typeof rawCanId === 'number' ? rawCanId : undefined;

  const init: ComponentInit = {
    id: instance.id,
    type: instance.type,
    canId,
    maxVoltage: profile.maxVoltage,
    continuousCurrentAmps: profile.continuousAmps,
    peakCurrentAmps: profile.peakAmps,
    minVoltage: resolveMinVoltage(instance),
  };

  switch (instance.type) {
    case 'Battery':
      return new Battery(
        init,
        num(definition?.metadata?.nominalVoltage, BATTERY_NOMINAL_VOLTAGE),
        num(definition?.metadata?.internalResistanceOhm, BATTERY_INTERNAL_RESISTANCE_OHM),
      );
    case 'RoboRIO':
    case 'SystemCore':
      return new Controller(init);
    case 'PDH':
    case 'PDP':
      return new PowerDistribution(init);
    case 'VRM':
      return new VoltageRegulator(init);
    case 'MainBreaker': {
      const closed = instance.metadata?.breakerClosed !== false;
      return new Breaker(init, closed);
    }
    case 'SparkMax':
    case 'SparkFlex':
      return new MotorController(init);
    case 'TalonFX': {
      const parsed = readTalonVariant(instance.metadata);
      return new MotorController(init, {
        variant: parsed.ok ? parsed.variant : undefined,
        variantError: parsed.ok ? undefined : parsed.message,
        statorCurrentAmps: optionalNumber(instance.metadata?.statorCurrentAmps),
        dutyCycle: optionalNumber(instance.metadata?.dutyCycle),
        supplyLimitAmps: optionalNumber(instance.metadata?.supplyLimitAmps),
      });
    }
    default:
      if (definition?.category === DeviceCategory.MOTOR_CONTROLLER) return new MotorController(init);
      if (definition?.category === DeviceCategory.POWER) return new PowerDistribution(init);
      if (definition?.category === DeviceCategory.CONTROLLER) return new Controller(init);
      return new GenericLoad(init);
  }
}
