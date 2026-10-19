import {
  PortType,
  Severity,
  type Diagnostic,
  type RobotModel,
} from '@691sim/core';
import { createDefaultDeviceRegistry, type DeviceRegistry } from '@691sim/registry';
import { type CircuitComponent, createComponent, type LoadMode, Breaker } from './components.js';
import { type AwgGauge, wireFromConnection } from './wire.js';
import {
  BROWNOUT_MESSAGE,
  simulateVoltage,
  type PowerEdge,
  type VoltageSimResult,
  type WireCurrentResult,
} from './voltage.js';
import { verifyCanTopology, type CanEdge, type CanTopologyResult } from './canTopology.js';

export * from './components.js';
export * from './wire.js';
export * from './voltage.js';
export * from './network.js';
export * from './solve.js';
export * from './limits.js';
export * from './kraken.js';
export * from './batterySoc.js';
export * from './match.js';
export * from './matchLogCompare.js';
export * from './swerve.js';
export * from './canTopology.js';

export const SIMULATION_PACKAGE_NAME = '@691sim/simulation';

export interface SimulateOptions {
  registry?: DeviceRegistry;
  mode?: LoadMode;
}

export interface SimulationResult {
  mode: LoadMode;
  voltage: VoltageSimResult;
  can: CanTopologyResult;
  ampacityViolations: WireCurrentResult[];
  diagnostics: Diagnostic[];
}

function resolvePortType(
  registry: DeviceRegistry,
  deviceType: string,
  portId: string,
): PortType | undefined {
  return registry.get(deviceType)?.ports.find((port) => port.id === portId)?.type;
}

/** Sensible default AWG for a wire based on what it powers. */
function defaultGaugeFor(sourceType: string, sourcePort: string): AwgGauge {
  if (sourceType === 'Battery') return 6; // main battery leads (120A FRC breaker)
  if (sourceType === 'MainBreaker' && sourcePort === 'power_out') return 6;
  if (sourcePort === 'vrm_out') return 10;
  const channel = /^channel_(\d+)$/.exec(sourcePort);
  if (channel) {
    const index = Number(channel[1]);
    if (index >= 20) return 14; // low-current channels
    return 10; // high-current channels (0-19)
  }
  return 12;
}

let diagnosticSequence = 0;
function diag(
  code: string,
  severity: Severity,
  message: string,
  details: Pick<Diagnostic, 'deviceIds' | 'connectionIds'> = {},
): Diagnostic {
  diagnosticSequence += 1;
  return { id: `sim-${code.toLowerCase()}-${diagnosticSequence}`, code, severity, message, ...details };
}

function buildDiagnostics(
  voltage: VoltageSimResult,
  can: CanTopologyResult,
  ampacityViolations: WireCurrentResult[],
  components: Map<string, CircuitComponent>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const component of components.values()) {
    if (component instanceof Breaker && component.blocksDownstreamPower()) {
      diagnostics.push(
        diag(
          'BREAKER_OPEN',
          Severity.ERROR,
          'Breaker is stopping current flow.',
          { deviceIds: [component.id] },
        ),
      );
    }
  }

  if (voltage.brownoutRisk) {
    diagnostics.push(
      diag(
        'BROWNOUT_RISK',
        Severity.ERROR,
        `${BROWNOUT_MESSAGE} — system sags to ${voltage.systemVoltage.toFixed(2)}V under ${voltage.totalCurrentAmps.toFixed(1)}A (${voltage.mode}).`,
      ),
    );
  }

  if (voltage.firstFailure) {
    const others = voltage.undervoltage
      .filter((device) => device.deviceId !== voltage.firstFailure?.deviceId)
      .map((device) => device.deviceId);
    const extra = others.length > 0 ? ` Also under the minimum: ${others.join(', ')}.` : '';
    diagnostics.push(
      diag(
        'DEVICE_UNDERVOLTAGE',
        Severity.ERROR,
        `${voltage.firstFailure.deviceId} fails first at ${voltage.firstFailure.voltage.toFixed(2)}V, below its ${voltage.firstFailure.minVoltage}V minimum.${extra}`,
        { deviceIds: voltage.undervoltage.map((device) => device.deviceId) },
      ),
    );
  }

  for (const issue of voltage.issues) {
    const severity =
      issue.code === 'POWER_LOOP_DETECTED' || issue.code === 'FLOATING_NODE'
        ? Severity.WARNING
        : Severity.ERROR;
    diagnostics.push(
      diag(issue.code, severity, issue.message, { deviceIds: issue.deviceIds }),
    );
  }

  for (const wire of ampacityViolations) {
    diagnostics.push(
      diag(
        'WIRE_AMPACITY_EXCEEDED',
        Severity.ERROR,
        `Exceeds Ampacity: Safety Hazard! ${wire.gauge} AWG wire (${wire.maxAmps}A max) carries ~${wire.currentAmps.toFixed(0)}A from ${wire.from} to ${wire.to}.`,
        { connectionIds: [wire.connectionId], deviceIds: [wire.from, wire.to] },
      ),
    );
  }

  for (const issue of can.issues) {
    diagnostics.push(diag(issue.code, Severity.ERROR, issue.message, { deviceIds: issue.deviceIds }));
  }

  return diagnostics;
}

export interface CircuitGraph {
  components: Map<string, CircuitComponent>;
  powerEdges: PowerEdge[];
  canEdges: CanEdge[];
}

/** Build component + edge maps used by voltage and match solvers. */
export function buildCircuitGraph(
  model: RobotModel,
  registry: DeviceRegistry = createDefaultDeviceRegistry(),
): CircuitGraph {
  const components = new Map<string, CircuitComponent>();
  const typeById = new Map<string, string>();
  for (const instance of model.devices) {
    components.set(instance.id, createComponent(instance, registry.get(instance.type)));
    typeById.set(instance.id, instance.type);
  }

  const powerEdges: PowerEdge[] = [];
  const canEdges: CanEdge[] = [];

  for (const connection of model.connections) {
    const sourceType = typeById.get(connection.sourceDevice);
    if (!sourceType) continue;
    const portType = resolvePortType(registry, sourceType, connection.sourcePort);

    if (portType === PortType.POWER) {
      powerEdges.push({
        connectionId: connection.id,
        from: connection.sourceDevice,
        to: connection.targetDevice,
        wire: wireFromConnection(connection, defaultGaugeFor(sourceType, connection.sourcePort)),
      });
    } else if (portType === PortType.CAN) {
      canEdges.push({
        connectionId: connection.id,
        a: connection.sourceDevice,
        b: connection.targetDevice,
      });
    }
  }

  return { components, powerEdges, canEdges };
}

/**
 * Run the full circuit simulation for a robot model: builds the OOP component
 * graph, computes dynamic voltage drop / brownout risk, validates wire
 * ampacity, and checks CAN bus topology. Decoupled from any UI framework.
 */
export function simulateCircuit(
  model: RobotModel,
  options: SimulateOptions = {},
): SimulationResult {
  const registry = options.registry ?? createDefaultDeviceRegistry();
  const mode = options.mode ?? 'peak';
  const { components, powerEdges, canEdges } = buildCircuitGraph(model, registry);

  const voltage = simulateVoltage(components, powerEdges, mode);
  const can = verifyCanTopology(components, canEdges);
  const ampacityViolations = voltage.wireCurrents.filter((wire) => wire.exceedsAmpacity);
  const diagnostics = buildDiagnostics(voltage, can, ampacityViolations, components);

  return { mode, voltage, can, ampacityViolations, diagnostics };
}
