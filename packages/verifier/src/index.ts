import {
  DeviceCategory,
  PortDirection,
  PortType,
  Severity,
  type Connection,
  type DeviceDefinition,
  type DeviceInstance,
  type Diagnostic,
  type Port,
  type RobotModel,
} from "@691sim/core";
import {
  createDefaultDeviceRegistry,
  type DeviceRegistry,
} from "@691sim/registry";

export interface DeviceNode {
  id: string;
  instance: DeviceInstance;
  definition: DeviceDefinition;
}

export interface PortNode {
  id: string;
  deviceId: string;
  portId: string;
  port: Port;
  definition: DeviceDefinition;
}

export interface GraphEdge {
  id: string;
  connection: Connection;
  source: PortNode;
  target: PortNode;
}

export interface BuildGraphOptions {
  registry?: DeviceRegistry;
}

function portNodeId(deviceId: string, portId: string): string {
  return `${deviceId}:${portId}`;
}

function portTypeName(type: PortType): string {
  return PortType[type] ?? String(type);
}

function directionName(direction: PortDirection): string {
  return PortDirection[direction] ?? String(direction);
}

function deviceHasPortType(node: DeviceNode, type: PortType): boolean {
  return node.definition.ports.some((port) => port.type === type);
}

function isPowerSource(node: DeviceNode): boolean {
  return (
    node.definition.type === "Battery" ||
    node.definition.metadata?.role === "primary-power-source"
  );
}

function isGroundSource(node: DeviceNode): boolean {
  return node.definition.ports.some(
    (port) =>
      port.type === PortType.GROUND && port.direction === PortDirection.OUTPUT,
  );
}

function isMainBreakerOpen(device: DeviceNode): boolean {
  return (
    device.definition.type === "MainBreaker" &&
    device.instance.metadata?.breakerClosed === false
  );
}

function blocksPowerTraversal(
  device: DeviceNode,
  edge: GraphEdge,
  portType?: PortType,
): boolean {
  if (portType !== PortType.POWER && portType !== undefined) {
    return false;
  }
  if (!isMainBreakerOpen(device)) {
    return false;
  }
  const atSource =
    edge.source.deviceId === device.id && edge.source.port.id === "power_out";
  const atTarget =
    edge.target.deviceId === device.id && edge.target.port.id === "power_out";
  return atSource || atTarget;
}

function isController(node: DeviceNode): boolean {
  return node.definition.category === DeviceCategory.CONTROLLER;
}

function deviceRequiresPoweredPath(node: DeviceNode): boolean {
  if (isPowerSource(node)) {
    return false;
  }

  return node.definition.ports.some(
    (port) =>
      port.type === PortType.POWER &&
      port.direction === PortDirection.INPUT &&
      port.required,
  );
}

function deviceRequiresGroundPath(node: DeviceNode): boolean {
  if (isPowerSource(node)) {
    return false;
  }

  return node.definition.ports.some(
    (port) =>
      port.type === PortType.GROUND &&
      port.direction === PortDirection.INPUT &&
      port.required,
  );
}

/** Device IDs that lack a battery power or ground path (for live UI highlighting). */
export function getUnpoweredDeviceIds(graph: RobotGraph): string[] {
  const ids = new Set<string>();

  for (const device of graph.devices) {
    if (deviceRequiresPoweredPath(device) && !graph.powerReachable(device.id)) {
      ids.add(device.id);
    }
    if (deviceRequiresGroundPath(device) && !graph.groundReachable(device.id)) {
      ids.add(device.id);
    }
  }

  return [...ids];
}

export class RobotGraph {
  readonly devices: DeviceNode[];
  readonly ports: PortNode[];
  readonly edges: GraphEdge[];

  private readonly devicesById = new Map<string, DeviceNode>();
  private readonly portsById = new Map<string, PortNode>();
  private readonly edgesByDevice = new Map<string, GraphEdge[]>();

  constructor(devices: DeviceNode[], ports: PortNode[], edges: GraphEdge[]) {
    this.devices = devices;
    this.ports = ports;
    this.edges = edges;

    for (const device of devices) {
      this.devicesById.set(device.id, device);
      this.edgesByDevice.set(device.id, []);
    }

    for (const graphPort of ports) {
      this.portsById.set(graphPort.id, graphPort);
    }

    for (const edge of edges) {
      this.edgesByDevice.get(edge.source.deviceId)?.push(edge);
      this.edgesByDevice.get(edge.target.deviceId)?.push(edge);
    }
  }

  getDevice(deviceId: string): DeviceNode | undefined {
    return this.devicesById.get(deviceId);
  }

  requireDevice(deviceId: string): DeviceNode {
    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Unknown graph device: ${deviceId}`);
    }
    return device;
  }

  getPort(deviceId: string, portId: string): PortNode | undefined {
    return this.portsById.get(portNodeId(deviceId, portId));
  }

  requirePort(deviceId: string, portId: string): PortNode {
    const port = this.getPort(deviceId, portId);
    if (!port) {
      throw new Error(`Unknown graph port: ${deviceId}.${portId}`);
    }
    return port;
  }

  getDeviceEdges(deviceId: string): GraphEdge[] {
    return this.edgesByDevice.get(deviceId) ?? [];
  }

  getPortEdges(deviceId: string, portId: string): GraphEdge[] {
    const id = portNodeId(deviceId, portId);
    return this.edges.filter(
      (edge) => edge.source.id === id || edge.target.id === id,
    );
  }

  traverse(startDeviceId: string, portType?: PortType): DeviceNode[] {
    const visited = new Set<string>();
    const queue = [startDeviceId];

    while (queue.length > 0) {
      const deviceId = queue.shift();
      if (!deviceId || visited.has(deviceId)) {
        continue;
      }

      const device = this.getDevice(deviceId);
      if (!device) {
        continue;
      }

      visited.add(deviceId);

      for (const edge of this.getDeviceEdges(deviceId)) {
        if (portType !== undefined && !edgeUsesPortType(edge, portType)) {
          continue;
        }

        if (blocksPowerTraversal(device, edge, portType)) {
          continue;
        }

        const nextDeviceId =
          edge.source.deviceId === deviceId
            ? edge.target.deviceId
            : edge.source.deviceId;
        if (!visited.has(nextDeviceId)) {
          queue.push(nextDeviceId);
        }
      }
    }

    return [...visited].map((deviceId) => this.requireDevice(deviceId));
  }

  shortestPath(
    startDeviceId: string,
    targetDeviceId: string,
    portType?: PortType,
  ): DeviceNode[] | undefined {
    const visited = new Set<string>();
    const queue: string[][] = [[startDeviceId]];

    while (queue.length > 0) {
      const path = queue.shift();
      const currentDeviceId = path?.[path.length - 1];
      if (!path || !currentDeviceId || visited.has(currentDeviceId)) {
        continue;
      }

      if (currentDeviceId === targetDeviceId) {
        return path.map((deviceId) => this.requireDevice(deviceId));
      }

      visited.add(currentDeviceId);
      const currentDevice = this.getDevice(currentDeviceId);
      if (!currentDevice) continue;

      for (const edge of this.getDeviceEdges(currentDeviceId)) {
        if (portType !== undefined && !edgeUsesPortType(edge, portType)) {
          continue;
        }

        if (blocksPowerTraversal(currentDevice, edge, portType)) {
          continue;
        }

        const nextDeviceId =
          edge.source.deviceId === currentDeviceId
            ? edge.target.deviceId
            : edge.source.deviceId;
        if (!visited.has(nextDeviceId)) {
          queue.push([...path, nextDeviceId]);
        }
      }
    }

    return undefined;
  }

  connectedComponents(portType?: PortType): DeviceNode[][] {
    const remaining = new Set(this.devices.map((device) => device.id));
    const components: DeviceNode[][] = [];

    for (const device of this.devices) {
      if (!remaining.has(device.id)) {
        continue;
      }

      const component = this.traverse(device.id, portType);
      for (const componentDevice of component) {
        remaining.delete(componentDevice.id);
      }
      components.push(component);
    }

    return components;
  }

  isReachable(
    startDeviceId: string,
    targetDeviceId: string,
    portType?: PortType,
  ): boolean {
    return (
      this.shortestPath(startDeviceId, targetDeviceId, portType) !== undefined
    );
  }

  isReachableFromAny(
    sourceDeviceIds: string[],
    targetDeviceId: string,
    portType?: PortType,
  ): boolean {
    return sourceDeviceIds.some((sourceDeviceId) =>
      this.isReachable(sourceDeviceId, targetDeviceId, portType),
    );
  }

  powerSources(): DeviceNode[] {
    return this.devices.filter(isPowerSource);
  }

  groundSources(): DeviceNode[] {
    return this.devices.filter(isGroundSource);
  }

  powerReachable(deviceId: string): boolean {
    return this.isReachableFromAny(
      this.powerSources().map((device) => device.id),
      deviceId,
      PortType.POWER,
    );
  }

  groundReachable(deviceId: string): boolean {
    const device = this.getDevice(deviceId);
    if (!device || !deviceHasPortType(device, PortType.GROUND)) {
      return true;
    }

    return this.isReachableFromAny(
      this.groundSources().map((source) => source.id),
      deviceId,
      PortType.GROUND,
    );
  }

  canReachable(deviceId: string): boolean {
    return this.isReachableFromAny(
      this.devices
        .filter(
          (device) =>
            isController(device) && deviceHasPortType(device, PortType.CAN),
        )
        .map((device) => device.id),
      deviceId,
      PortType.CAN,
    );
  }

  networkReachable(deviceId: string): boolean {
    return this.isReachableFromAny(
      this.devices
        .filter((device) => device.definition.type === "Radio")
        .map((device) => device.id),
      deviceId,
      PortType.ETHERNET,
    );
  }
}

function edgeUsesPortType(edge: GraphEdge, portType: PortType): boolean {
  return (
    edge.source.port.type === portType && edge.target.port.type === portType
  );
}

export function buildGraph(
  model: RobotModel,
  options: BuildGraphOptions = {},
): RobotGraph {
  const registry = options.registry ?? createDefaultDeviceRegistry();
  const devices: DeviceNode[] = model.devices.map((instance) => ({
    id: instance.id,
    instance,
    definition: registry.require(instance.type),
  }));

  const ports: PortNode[] = devices.flatMap((device) =>
    device.definition.ports.map((port) => ({
      id: portNodeId(device.id, port.id),
      deviceId: device.id,
      portId: port.id,
      port,
      definition: device.definition,
    })),
  );

  const portsById = new Map(ports.map((port) => [port.id, port]));
  const edges: GraphEdge[] = [];

  for (const connection of model.connections) {
    const source = portsById.get(
      portNodeId(connection.sourceDevice, connection.sourcePort),
    );
    const target = portsById.get(
      portNodeId(connection.targetDevice, connection.targetPort),
    );

    if (source && target) {
      edges.push({ id: connection.id, connection, source, target });
    }
  }

  return new RobotGraph(devices, ports, edges);
}

export interface VerificationContext {
  model: RobotModel;
  graph: RobotGraph;
  registry: DeviceRegistry;
}

export interface VerificationPass {
  id: string;
  run: (context: VerificationContext) => Diagnostic[];
}

export class DiagnosticCollection {
  private readonly diagnostics: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  addMany(diagnostics: Diagnostic[]): void {
    this.diagnostics.push(...diagnostics);
  }

  list(): Diagnostic[] {
    return [...this.diagnostics];
  }

  hasErrors(): boolean {
    return this.diagnostics.some(
      (diagnostic) => diagnostic.severity === Severity.ERROR,
    );
  }
}

export interface VerificationResult {
  diagnostics: Diagnostic[];
  hasErrors: boolean;
}

export interface VerifyOptions {
  registry?: DeviceRegistry;
  passes?: VerificationPass[];
}

let diagnosticSequence = 0;

function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  details: Pick<Diagnostic, "deviceIds" | "connectionIds"> = {},
): Diagnostic {
  diagnosticSequence += 1;
  return {
    id: `${code.toLowerCase()}-${diagnosticSequence}`,
    code,
    severity,
    message,
    ...details,
  };
}

function connectionCount(
  graph: RobotGraph,
  deviceId: string,
  port: Port,
): number {
  return graph.getPortEdges(deviceId, port.id).length;
}

function connectionCountByPortType(
  graph: RobotGraph,
  device: DeviceNode,
  portType: PortType,
): number {
  return device.definition.ports
    .filter((port) => port.type === portType)
    .reduce(
      (count, port) => count + connectionCount(graph, device.id, port),
      0,
    );
}

function sourceDirectionAllowed(direction: PortDirection): boolean {
  return (
    direction === PortDirection.OUTPUT ||
    direction === PortDirection.BIDIRECTIONAL
  );
}

function targetDirectionAllowed(direction: PortDirection): boolean {
  return (
    direction === PortDirection.INPUT ||
    direction === PortDirection.BIDIRECTIONAL
  );
}

export const connectionValidationPass: VerificationPass = {
  id: "connection-validation",
  run: ({ model, graph }) => {
    const diagnostics: Diagnostic[] = [];

    for (const connection of model.connections) {
      const source = graph.getPort(
        connection.sourceDevice,
        connection.sourcePort,
      );
      const target = graph.getPort(
        connection.targetDevice,
        connection.targetPort,
      );

      if (!source) {
        diagnostics.push(
          diagnostic(
            "UNKNOWN_SOURCE_PORT",
            Severity.ERROR,
            `Connection ${connection.id} references missing source port ${connection.sourceDevice}.${connection.sourcePort}.`,
            {
              deviceIds: [connection.sourceDevice],
              connectionIds: [connection.id],
            },
          ),
        );
        continue;
      }

      if (!target) {
        diagnostics.push(
          diagnostic(
            "UNKNOWN_TARGET_PORT",
            Severity.ERROR,
            `Connection ${connection.id} references missing target port ${connection.targetDevice}.${connection.targetPort}.`,
            {
              deviceIds: [connection.targetDevice],
              connectionIds: [connection.id],
            },
          ),
        );
        continue;
      }

      if (source.port.type !== target.port.type) {
        diagnostics.push(
          diagnostic(
            "INCOMPATIBLE_PORT_TYPES",
            Severity.ERROR,
            `Connection ${connection.id} connects ${portTypeName(source.port.type)} to ${portTypeName(target.port.type)}.`,
            {
              deviceIds: [source.deviceId, target.deviceId],
              connectionIds: [connection.id],
            },
          ),
        );
      }

      if (!sourceDirectionAllowed(source.port.direction)) {
        diagnostics.push(
          diagnostic(
            "INVALID_SOURCE_DIRECTION",
            Severity.ERROR,
            `Connection ${connection.id} uses ${source.deviceId}.${source.portId} as a source, but that port is ${directionName(source.port.direction)}.`,
            {
              deviceIds: [source.deviceId],
              connectionIds: [connection.id],
            },
          ),
        );
      }

      if (!targetDirectionAllowed(target.port.direction)) {
        diagnostics.push(
          diagnostic(
            "INVALID_TARGET_DIRECTION",
            Severity.ERROR,
            `Connection ${connection.id} uses ${target.deviceId}.${target.portId} as a target, but that port is ${directionName(target.port.direction)}.`,
            {
              deviceIds: [target.deviceId],
              connectionIds: [connection.id],
            },
          ),
        );
      }
    }

    for (const device of graph.devices) {
      for (const port of device.definition.ports) {
        if (port.maxConnections === undefined) {
          continue;
        }

        const count = connectionCount(graph, device.id, port);
        if (count > port.maxConnections) {
          diagnostics.push(
            diagnostic(
              "MAX_CONNECTIONS_EXCEEDED",
              Severity.ERROR,
              `${device.id}.${port.id} has ${count} connections, but allows at most ${port.maxConnections}.`,
              { deviceIds: [device.id] },
            ),
          );
        }
      }
    }

    return diagnostics;
  },
};

export const requiredConnectionsPass: VerificationPass = {
  id: "required-connections",
  run: ({ graph }) => {
    const diagnostics: Diagnostic[] = [];

    for (const device of graph.devices) {
      for (const port of device.definition.ports) {
        if (port.required && connectionCount(graph, device.id, port) === 0) {
          diagnostics.push(
            diagnostic(
              "REQUIRED_PORT_UNCONNECTED",
              Severity.ERROR,
              `${device.id}.${port.id} is required but has no connections.`,
              { deviceIds: [device.id] },
            ),
          );
        }
      }

      for (const requirement of device.definition.requirements ?? []) {
        const count = connectionCountByPortType(
          graph,
          device,
          requirement.portType,
        );
        if (count < requirement.minConnections) {
          diagnostics.push(
            diagnostic(
              "REQUIREMENT_NOT_MET",
              Severity.ERROR,
              `${device.id} requires at least ${requirement.minConnections} ${portTypeName(requirement.portType)} connection(s), but has ${count}.`,
              { deviceIds: [device.id] },
            ),
          );
        }
      }
    }

    return diagnostics;
  },
};

export const powerVerificationPass: VerificationPass = {
  id: "power-verification",
  run: ({ graph }) => {
    const diagnostics: Diagnostic[] = [];
    const powerSources = graph.powerSources();

    if (powerSources.length === 0) {
      diagnostics.push(
        diagnostic(
          "BATTERY_MISSING",
          Severity.ERROR,
          "Robot model does not include a battery or equivalent power source.",
        ),
      );
    }

    for (const device of graph.devices) {
      if (isMainBreakerOpen(device)) {
        diagnostics.push(
          diagnostic(
            "BREAKER_OPEN",
            Severity.ERROR,
            "Breaker is stopping current flow.",
            { deviceIds: [device.id] },
          ),
        );
      }
    }

    for (const device of graph.devices) {
      if (!deviceRequiresPoweredPath(device)) {
        continue;
      }

      if (!graph.powerReachable(device.id)) {
        diagnostics.push(
          diagnostic(
            "POWER_NOT_REACHABLE",
            Severity.ERROR,
            `${device.id} is not reachable from a battery over power connections.`,
            { deviceIds: [device.id] },
          ),
        );
      }

      if (deviceRequiresGroundPath(device) && !graph.groundReachable(device.id)) {
        diagnostics.push(
          diagnostic(
            "GROUND_NOT_REACHABLE",
            Severity.ERROR,
            `${device.id} is not reachable from a battery over ground connections.`,
            { deviceIds: [device.id] },
          ),
        );
      }
    }

    return diagnostics;
  },
};

export const canVerificationPass: VerificationPass = {
  id: "can-verification",
  run: ({ graph }) => {
    const diagnostics: Diagnostic[] = [];
    const canDevices = graph.devices.filter((device) =>
      deviceHasPortType(device, PortType.CAN),
    );
    const canControllers = canDevices.filter(isController);

    if (canControllers.length === 0 && canDevices.length > 0) {
      diagnostics.push(
        diagnostic(
          "CAN_CONTROLLER_MISSING",
          Severity.ERROR,
          "CAN devices exist, but no controller with a CAN port is present.",
          { deviceIds: canDevices.map((device) => device.id) },
        ),
      );
    }

    const seenCanIds = new Map<string, string>();
    for (const device of canDevices) {
      const canId = device.instance.metadata?.canId;
      if (canId === undefined || canId === null) {
        continue;
      }

      const key = String(canId);
      const existingDeviceId = seenCanIds.get(key);
      if (existingDeviceId) {
        diagnostics.push(
          diagnostic(
            "DUPLICATE_CAN_ID",
            Severity.ERROR,
            `${device.id} and ${existingDeviceId} both use CAN ID ${key}.`,
            { deviceIds: [existingDeviceId, device.id] },
          ),
        );
      } else {
        seenCanIds.set(key, device.id);
      }
    }

    const canComponents = graph.connectedComponents(PortType.CAN);
    const componentOf = (deviceId: string): DeviceNode[] =>
      canComponents.find((component) => component.some((device) => device.id === deviceId)) ?? [];
    const busChoice = (device: DeviceNode): "rio" | "canivore" =>
      device.instance.metadata?.canBus === "canivore" ? "canivore" : "rio";

    for (const device of canDevices) {
      if (isController(device) || device.definition.type === "CANivore") {
        continue;
      }

      const group = componentOf(device.id);
      const onCanivore = group.some((member) => member.definition.type === "CANivore");
      const onRio = group.some(isController);
      const declared = busChoice(device);
      const requiresCan = (device.definition.requirements ?? []).some(
        (requirement) => requirement.portType === PortType.CAN,
      );

      if (declared === "canivore" && (!onCanivore || onRio)) {
        diagnostics.push(
          diagnostic(
            "CAN_WRONG_BUS",
            Severity.ERROR,
            onRio
              ? `${device.id} is marked for the CANivore bus but shares the roboRIO CAN chain.`
              : `${device.id} is marked for the CANivore bus but is not wired to a CANivore.`,
            { deviceIds: [device.id] },
          ),
        );
      } else if (declared === "rio" && onCanivore) {
        diagnostics.push(
          diagnostic(
            "CAN_WRONG_BUS",
            Severity.ERROR,
            `${device.id} is on the CANivore bus. Mark it with canBus: 'canivore', or move it to the roboRIO chain.`,
            { deviceIds: [device.id] },
          ),
        );
      } else if (requiresCan && declared === "rio" && !graph.canReachable(device.id)) {
        diagnostics.push(
          diagnostic(
            "CAN_NOT_REACHABLE",
            Severity.ERROR,
            `${device.id} is not reachable from a controller over CAN connections.`,
            { deviceIds: [device.id] },
          ),
        );
      }
    }

    const isolatedCanComponents = canComponents
      .filter(
        (component) =>
          component.some((device) => deviceHasPortType(device, PortType.CAN)) &&
          !component.some(isController) &&
          !component.some((device) => device.definition.type === "CANivore"),
      );

    for (const component of isolatedCanComponents) {
      diagnostics.push(
        diagnostic(
          "ISOLATED_CAN_SEGMENT",
          Severity.ERROR,
          `CAN segment is isolated from a controller: ${component.map((device) => device.id).join(", ")}.`,
          { deviceIds: component.map((device) => device.id) },
        ),
      );
    }

    return diagnostics;
  },
};

export const networkVerificationPass: VerificationPass = {
  id: "network-verification",
  run: ({ graph }) => {
    const diagnostics: Diagnostic[] = [];
    const radios = graph.devices.filter(
      (device) => device.definition.type === "Radio",
    );
    const ethernetDevices = graph.devices.filter((device) =>
      deviceHasPortType(device, PortType.ETHERNET),
    );

    if (radios.length === 0) {
      diagnostics.push(
        diagnostic(
          "RADIO_MISSING",
          Severity.ERROR,
          "Robot model does not include a radio.",
        ),
      );
    }

    const seenIps = new Map<string, string>();
    for (const device of ethernetDevices) {
      const ipAddress = device.instance.metadata?.ipAddress;
      if (typeof ipAddress !== "string" || ipAddress.length === 0) {
        continue;
      }

      const existingDeviceId = seenIps.get(ipAddress);
      if (existingDeviceId) {
        diagnostics.push(
          diagnostic(
            "DUPLICATE_IP_ADDRESS",
            Severity.ERROR,
            `${device.id} and ${existingDeviceId} both use IP address ${ipAddress}.`,
            { deviceIds: [existingDeviceId, device.id] },
          ),
        );
      } else {
        seenIps.set(ipAddress, device.id);
      }
    }

    for (const device of ethernetDevices) {
      if (device.definition.type === "Radio") {
        continue;
      }

      const requiresNetwork = (device.definition.requirements ?? []).some(
        (requirement) => requirement.portType === PortType.ETHERNET,
      );

      if (requiresNetwork && !graph.networkReachable(device.id)) {
        diagnostics.push(
          diagnostic(
            "NETWORK_NOT_REACHABLE",
            Severity.ERROR,
            `${device.id} is not reachable from a radio over Ethernet connections.`,
            { deviceIds: [device.id] },
          ),
        );
      }
    }

    return diagnostics;
  },
};

export const defaultVerificationPasses: VerificationPass[] = [
  connectionValidationPass,
  requiredConnectionsPass,
  powerVerificationPass,
  canVerificationPass,
  networkVerificationPass,
];

export function verifyRobotModel(
  model: RobotModel,
  options: VerifyOptions = {},
): VerificationResult {
  const registry = options.registry ?? createDefaultDeviceRegistry();
  const graph = buildGraph(model, { registry });
  const context: VerificationContext = { model, graph, registry };
  const collection = new DiagnosticCollection();

  for (const pass of options.passes ?? defaultVerificationPasses) {
    collection.addMany(pass.run(context));
  }

  return {
    diagnostics: collection.list(),
    hasErrors: collection.hasErrors(),
  };
}
