import { PROJECT_SCHEMA_VERSION, type Connection, type DeviceInstance, type RobotModel } from '@691sim/core';
import { krakenSupplyCurrentAmps, type KrakenVariant } from './kraken.js';
import { MATCH_DURATION_SECONDS, type MatchLoadSample } from './match.js';

export const SWERVE_MODULE_IDS = ['fl', 'fr', 'bl', 'br'] as const;
export type SwerveCorner = (typeof SWERVE_MODULE_IDS)[number];

/**
 * Channel map for a four-module drivetrain. These are placement choices, not
 * rulebook fuse ratings. Fuse amps are passed in by the caller.
 *
 * drives 0–3, steers 4–7, pigeon 8, CANcoders 20–23.
 */
export function swerveChannels(corner: SwerveCorner): { drive: number; steer: number; cancoder: number } {
  const index = SWERVE_MODULE_IDS.indexOf(corner);
  return { drive: index, steer: 4 + index, cancoder: 20 + index };
}

export const PIGEON_CHANNEL = 8;

export function swerveDeviceId(corner: SwerveCorner, role: 'drive' | 'steer' | 'cancoder'): string {
  return `swerve-${corner}-${role}`;
}

export const SWERVE_PIGEON_ID = 'swerve-pigeon';

export interface SwerveBreakers {
  /** Caller-supplied fuse rating for each drive channel. Not a rulebook default. */
  driveAmps: number;
  steerAmps: number;
  cancoderAmps: number;
  pigeonAmps: number;
}

export interface CanEndpoint {
  deviceId: string;
  portId?: string;
}

export interface ExpandedSubsystem {
  devices: DeviceInstance[];
  connections: Connection[];
}

export interface SwerveModuleExpansion extends ExpandedSubsystem {
  driveId: string;
  steerId: string;
  cancoderId: string;
  /** Last device in this module's CAN chain. The next module attaches here. */
  canTail: CanEndpoint;
}

/**
 * One swerve module as three ordinary devices: drive TalonFX, steer TalonFX,
 * and a CANcoder. Power for each lands on its own PDH channel. CAN is a
 * daisy chain through the three, so the verifier and the solver see normal
 * devices and normal wires.
 */
export function createSwerveModule(options: {
  corner: SwerveCorner;
  pdhId: string;
  breakers: Pick<SwerveBreakers, 'driveAmps' | 'steerAmps' | 'cancoderAmps'>;
  canUpstream: CanEndpoint;
  variant?: KrakenVariant;
  canIds?: { drive: number; steer: number; cancoder: number };
}): SwerveModuleExpansion {
  const variant = options.variant ?? 'X60';
  const index = SWERVE_MODULE_IDS.indexOf(options.corner);
  const canIds = options.canIds ?? {
    drive: 2 + index * 3,
    steer: 3 + index * 3,
    cancoder: 4 + index * 3,
  };
  const channels = swerveChannels(options.corner);
  const driveId = swerveDeviceId(options.corner, 'drive');
  const steerId = swerveDeviceId(options.corner, 'steer');
  const cancoderId = swerveDeviceId(options.corner, 'cancoder');
  const origin = { x: 200 + index * 220, y: 80 };

  const devices: DeviceInstance[] = [
    talon(driveId, `${options.corner} drive`, canIds.drive, variant, { x: origin.x, y: origin.y }),
    talon(steerId, `${options.corner} steer`, canIds.steer, variant, { x: origin.x, y: origin.y + 140 }),
    {
      id: cancoderId,
      type: 'CANcoder',
      label: `${options.corner} encoder`,
      position: { x: origin.x, y: origin.y + 280 },
      metadata: { canId: canIds.cancoder },
    },
  ];

  const connections: Connection[] = [
    ...pdhPair(options.pdhId, channels.drive, driveId, options.breakers.driveAmps, `${driveId}`),
    ...pdhPair(options.pdhId, channels.steer, steerId, options.breakers.steerAmps, `${steerId}`),
    ...pdhPair(options.pdhId, channels.cancoder, cancoderId, options.breakers.cancoderAmps, `${cancoderId}`),
    canLink(`${options.corner}-can-drive`, options.canUpstream, { deviceId: driveId }),
    canLink(`${options.corner}-can-steer`, { deviceId: driveId }, { deviceId: steerId }),
    canLink(`${options.corner}-can-coder`, { deviceId: steerId }, { deviceId: cancoderId }),
  ];

  return {
    devices,
    connections,
    driveId,
    steerId,
    cancoderId,
    canTail: { deviceId: cancoderId, portId: 'can_bus' },
  };
}

/**
 * Four swerve modules plus one Pigeon 2. CAN runs from `canUpstream` (usually
 * the roboRIO) through every module and the pigeon, then optionally into
 * `canTerminator` (usually the PDH) so the bus is one daisy chain.
 */
export function createSwerveDrivetrain(options: {
  pdhId: string;
  canUpstream: CanEndpoint;
  canTerminator?: CanEndpoint;
  breakers: SwerveBreakers;
  variant?: KrakenVariant;
}): ExpandedSubsystem {
  const devices: DeviceInstance[] = [];
  const connections: Connection[] = [];
  let upstream = options.canUpstream;

  for (const corner of SWERVE_MODULE_IDS) {
    const module = createSwerveModule({
      corner,
      pdhId: options.pdhId,
      breakers: options.breakers,
      canUpstream: upstream,
      variant: options.variant,
    });
    devices.push(...module.devices);
    connections.push(...module.connections);
    upstream = module.canTail;
  }

  devices.push({
    id: SWERVE_PIGEON_ID,
    type: 'Pigeon2',
    label: 'Pigeon 2',
    position: { x: 1100, y: 80 },
    metadata: { canId: 20 },
  });
  connections.push(
    ...pdhPair(options.pdhId, PIGEON_CHANNEL, SWERVE_PIGEON_ID, options.breakers.pigeonAmps, SWERVE_PIGEON_ID),
    canLink('swerve-can-pigeon', upstream, { deviceId: SWERVE_PIGEON_ID }),
  );

  if (options.canTerminator) {
    connections.push(canLink('swerve-can-terminator', { deviceId: SWERVE_PIGEON_ID }, options.canTerminator));
  }

  return { devices, connections };
}

/**
 * Relative stator currents for three driving regimes. These are scenario
 * inputs for the match profile, not CTRE datasheet ratings. Acceleration and
 * a hard reverse ask for more stator current than steady driving. The battery
 * still sees supply current, capped by `supplyLimitAmps`.
 */
export const SWERVE_PHASE_STATOR = {
  acceleration: { driveStatorAmps: 100, steerStatorAmps: 20, dutyCycle: 1 },
  steady: { driveStatorAmps: 10, steerStatorAmps: 5, dutyCycle: 1 },
  reverse: { driveStatorAmps: 100, steerStatorAmps: 20, dutyCycle: 1 },
} as const;

export type SwervePhase = keyof typeof SWERVE_PHASE_STATOR;

export function swerveDriveIds(): string[] {
  return SWERVE_MODULE_IDS.map((corner) => swerveDeviceId(corner, 'drive'));
}

export function swerveSteerIds(): string[] {
  return SWERVE_MODULE_IDS.map((corner) => swerveDeviceId(corner, 'steer'));
}

/**
 * One phase of a match, sampled at the given times. Each motor's load is the
 * supply current min(supplyLimit, stator × duty), not the stator current.
 */
export function buildSwervePhaseProfile(options: {
  phase: SwervePhase;
  supplyLimitAmps: number;
  times?: readonly number[];
  driveIds?: readonly string[];
  steerIds?: readonly string[];
}): MatchLoadSample[] {
  const phase = SWERVE_PHASE_STATOR[options.phase];
  const driveSupply = krakenSupplyCurrentAmps({
    statorCurrentAmps: phase.driveStatorAmps,
    dutyCycle: phase.dutyCycle,
    supplyLimitAmps: options.supplyLimitAmps,
  });
  const steerSupply = krakenSupplyCurrentAmps({
    statorCurrentAmps: phase.steerStatorAmps,
    dutyCycle: phase.dutyCycle,
    supplyLimitAmps: options.supplyLimitAmps,
  });
  const loadsByDeviceId: Record<string, number> = {};
  for (const id of options.driveIds ?? swerveDriveIds()) loadsByDeviceId[id] = driveSupply;
  for (const id of options.steerIds ?? swerveSteerIds()) loadsByDeviceId[id] = steerSupply;
  const times = options.times ?? [0];
  return times.map((t) => ({ t, loadsByDeviceId }));
}

/**
 * Example 135 s match: acceleration off the line, steady driving, then a hard
 * stop and reverse near the end. Times are a scenario shape, not a rule.
 */
export function buildSwerveMatchProfile(options: {
  supplyLimitAmps: number;
  driveIds?: readonly string[];
  steerIds?: readonly string[];
}): MatchLoadSample[] {
  const shared = {
    supplyLimitAmps: options.supplyLimitAmps,
    driveIds: options.driveIds,
    steerIds: options.steerIds,
  };
  return [
    ...buildSwervePhaseProfile({ ...shared, phase: 'acceleration', times: [0] }),
    ...buildSwervePhaseProfile({ ...shared, phase: 'steady', times: [15] }),
    ...buildSwervePhaseProfile({ ...shared, phase: 'reverse', times: [120, MATCH_DURATION_SECONDS] }),
  ];
}

/** PDH channel used to power the roboRIO on the example swerve robot. */
export const RIO_CHANNEL = 9;

/**
 * Battery, breaker, PDH, and roboRIO plus a swerve drivetrain.
 * `rioBreakerAmps` is required so the roboRIO channel is not given a rulebook fuse.
 */
export function createSwerveRobotModel(options: {
  breakers: SwerveBreakers;
  rioBreakerAmps: number;
  variant?: KrakenVariant;
}): RobotModel {
  const drivetrain = createSwerveDrivetrain({
    pdhId: 'pdh-1',
    canUpstream: { deviceId: 'rio-1' },
    canTerminator: { deviceId: 'pdh-1' },
    breakers: options.breakers,
    variant: options.variant,
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: 'swerve-robot',
    name: 'Swerve Drivetrain',
    devices: [
      { id: 'battery-1', type: 'Battery', position: { x: 40, y: 320 } },
      {
        id: 'breaker-1',
        type: 'MainBreaker',
        metadata: { breakerClosed: true },
        position: { x: 180, y: 320 },
      },
      { id: 'pdh-1', type: 'PDH', metadata: { canId: 1 }, position: { x: 360, y: 320 } },
      { id: 'rio-1', type: 'RoboRIO', position: { x: 40, y: 80 } },
      ...drivetrain.devices,
    ],
    connections: [
      {
        id: 'battery-breaker-power',
        sourceDevice: 'battery-1',
        sourcePort: 'main_power',
        targetDevice: 'breaker-1',
        targetPort: 'power_in',
      },
      {
        id: 'battery-breaker-ground',
        sourceDevice: 'battery-1',
        sourcePort: 'ground',
        targetDevice: 'breaker-1',
        targetPort: 'ground_in',
      },
      {
        id: 'breaker-pdh-power',
        sourceDevice: 'breaker-1',
        sourcePort: 'power_out',
        targetDevice: 'pdh-1',
        targetPort: 'main_power_in',
      },
      {
        id: 'breaker-pdh-ground',
        sourceDevice: 'breaker-1',
        sourcePort: 'ground_out',
        targetDevice: 'pdh-1',
        targetPort: 'ground_in',
      },
      ...drivetrain.connections,
      ...pdhPair('pdh-1', RIO_CHANNEL, 'rio-1', options.rioBreakerAmps, 'rio-1'),
    ],
  };
}

function talon(
  id: string,
  label: string,
  canId: number,
  variant: KrakenVariant,
  position: { x: number; y: number },
): DeviceInstance {
  return {
    id,
    type: 'TalonFX',
    label,
    position,
    metadata: { canId, variant },
  };
}

function pdhPair(
  pdhId: string,
  channel: number,
  deviceId: string,
  breakerAmps: number,
  idPrefix: string,
): Connection[] {
  return [
    {
      id: `${idPrefix}-power`,
      sourceDevice: pdhId,
      sourcePort: `channel_${channel}`,
      targetDevice: deviceId,
      targetPort: 'power_in',
      metadata: { fuseRatingAmps: breakerAmps },
    },
    {
      id: `${idPrefix}-ground`,
      sourceDevice: pdhId,
      sourcePort: 'ground_bus',
      targetDevice: deviceId,
      targetPort: 'ground',
    },
  ];
}

function canLink(id: string, from: CanEndpoint, to: CanEndpoint): Connection {
  return {
    id,
    sourceDevice: from.deviceId,
    sourcePort: from.portId ?? 'can_bus',
    targetDevice: to.deviceId,
    targetPort: to.portId ?? 'can_bus',
  };
}
