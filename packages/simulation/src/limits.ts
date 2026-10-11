/**
 * Minimum bus voltage for each device type.
 *
 * The roboRIO value is the existing brownout threshold (6.3 V). Every other
 * constant is intentionally empty: do not fill it in without a datasheet.
 */
export const ROBORIO_MIN_VOLTAGE_VOLTS = 6.3;

// TODO(arihant): datasheet value
export const BATTERY_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const SYSTEMCORE_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const PDH_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const PDP_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const VRM_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const SPARKMAX_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const SPARKFLEX_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const TALONFX_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const CANCODER_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const PIGEON2_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const LIMELIGHT_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const PHOTONVISION_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const ORANGEPI_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const RADIO_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const ETHERNET_SWITCH_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const MAIN_BREAKER_MIN_VOLTAGE_VOLTS: number | null = null;
// TODO(arihant): datasheet value
export const CANIVORE_MIN_VOLTAGE_VOLTS: number | null = null;

const MIN_VOLTAGE_BY_TYPE: Record<string, number | null> = {
  RoboRIO: ROBORIO_MIN_VOLTAGE_VOLTS,
  Battery: BATTERY_MIN_VOLTAGE_VOLTS,
  SystemCore: SYSTEMCORE_MIN_VOLTAGE_VOLTS,
  PDH: PDH_MIN_VOLTAGE_VOLTS,
  PDP: PDP_MIN_VOLTAGE_VOLTS,
  VRM: VRM_MIN_VOLTAGE_VOLTS,
  SparkMax: SPARKMAX_MIN_VOLTAGE_VOLTS,
  SparkFlex: SPARKFLEX_MIN_VOLTAGE_VOLTS,
  TalonFX: TALONFX_MIN_VOLTAGE_VOLTS,
  CANcoder: CANCODER_MIN_VOLTAGE_VOLTS,
  Pigeon2: PIGEON2_MIN_VOLTAGE_VOLTS,
  Limelight: LIMELIGHT_MIN_VOLTAGE_VOLTS,
  PhotonVision: PHOTONVISION_MIN_VOLTAGE_VOLTS,
  OrangePi: ORANGEPI_MIN_VOLTAGE_VOLTS,
  Radio: RADIO_MIN_VOLTAGE_VOLTS,
  EthernetSwitch: ETHERNET_SWITCH_MIN_VOLTAGE_VOLTS,
  MainBreaker: MAIN_BREAKER_MIN_VOLTAGE_VOLTS,
  CANivore: CANIVORE_MIN_VOLTAGE_VOLTS,
};

/** Datasheet minimum for this type, or null when that datasheet value is still unknown. */
export function minVoltageForType(type: string): number | null {
  return MIN_VOLTAGE_BY_TYPE[type] ?? null;
}

export interface UndervoltageDevice {
  deviceId: string;
  type: string;
  voltage: number;
  minVoltage: number;
  /** minVoltage − voltage. Larger means this device crossed its limit by more. */
  deficitVolts: number;
}

export interface UndervoltageReport {
  /** Every device whose solved voltage is below its minimum, deepest deficit first. */
  undervoltage: UndervoltageDevice[];
  /**
   * The device that fails first: the largest deficit. A device with no
   * datasheet minimum is not a candidate.
   */
  firstFailure: UndervoltageDevice | null;
}

/**
 * Compare each solved voltage with that device's minimum. Devices whose
 * minimum is still null are skipped rather than compared to an invented number.
 */
export function evaluateUndervoltage(
  rows: readonly {
    deviceId: string;
    type: string;
    voltage: number | null;
    minVoltage: number | null;
  }[],
): UndervoltageReport {
  const undervoltage: UndervoltageDevice[] = [];
  for (const row of rows) {
    if (row.voltage === null || row.minVoltage === null) continue;
    if (row.voltage >= row.minVoltage) continue;
    undervoltage.push({
      deviceId: row.deviceId,
      type: row.type,
      voltage: row.voltage,
      minVoltage: row.minVoltage,
      deficitVolts: row.minVoltage - row.voltage,
    });
  }
  undervoltage.sort(
    (a, b) => b.deficitVolts - a.deficitVolts || a.deviceId.localeCompare(b.deviceId),
  );
  return { undervoltage, firstFailure: undervoltage[0] ?? null };
}
