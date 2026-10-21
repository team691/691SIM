import {
  DeviceCategory,
  PortDirection,
  PortType,
  type DeviceDefinition,
  type Port,
} from "@691sim/core";

export interface DeviceRegistryPlugin {
  name: string;
  devices?: DeviceDefinition[];
  register?: (registry: DeviceRegistry) => void;
}

export interface RegisterOptions {
  overwrite?: boolean;
}

function port(
  id: string,
  type: PortType,
  direction: PortDirection,
  required = false,
  maxConnections = 1,
): Port {
  return { id, type, direction, required, maxConnections };
}

function powerOutput(id: string, maxConnections = 1): Port {
  return port(id, PortType.POWER, PortDirection.OUTPUT, false, maxConnections);
}

function powerInput(id = "power_in", required = true): Port {
  return port(id, PortType.POWER, PortDirection.INPUT, required, 1);
}

function groundInput(id = "ground", required = true): Port {
  return port(id, PortType.GROUND, PortDirection.INPUT, required, 1);
}

function groundOutput(id: string, maxConnections = 8): Port {
  return port(id, PortType.GROUND, PortDirection.OUTPUT, false, maxConnections);
}

function canPort(id = "can_bus", maxConnections = 2, required = false): Port {
  return port(
    id,
    PortType.CAN,
    PortDirection.BIDIRECTIONAL,
    required,
    maxConnections,
  );
}

function ethernetPort(
  id: string,
  required = false,
  maxConnections = 1,
): Port {
  return port(
    id,
    PortType.ETHERNET,
    PortDirection.BIDIRECTIONAL,
    required,
    maxConnections,
  );
}

function pdhChannelPorts(): Port[] {
  return Array.from({ length: 24 }, (_, index) =>
    powerOutput(`channel_${index}`, 1),
  );
}

function pdpChannelPorts(): Port[] {
  return Array.from({ length: 16 }, (_, index) =>
    powerOutput(`channel_${index}`, 1),
  );
}

function vrmRegulatedOutputs(): Port[] {
  const outputs: Port[] = [];
  for (let index = 0; index < 2; index++) {
    outputs.push(powerOutput(`12v_2a_${index}`, 1));
    outputs.push(groundOutput(`ground_12v_2a_${index}`, 1));
    outputs.push(powerOutput(`12v_500ma_${index}`, 1));
    outputs.push(groundOutput(`ground_12v_500ma_${index}`, 1));
    outputs.push(powerOutput(`5v_2a_${index}`, 1));
    outputs.push(groundOutput(`ground_5v_2a_${index}`, 1));
    outputs.push(powerOutput(`5v_500ma_${index}`, 1));
    outputs.push(groundOutput(`ground_5v_500ma_${index}`, 1));
  }
  return outputs;
}

function poweredDeviceRequirements(): DeviceDefinition["requirements"] {
  return [
    { portType: PortType.POWER, minConnections: 1 },
    { portType: PortType.GROUND, minConnections: 1 },
  ];
}

export const builtInDeviceDefinitions: DeviceDefinition[] = [
  {
    type: "Battery",
    displayName: "12V Battery",
    category: DeviceCategory.POWER,
    ports: [
      powerOutput("main_power", 1),
      groundOutput("ground", 4),
    ],
    metadata: {
      nominalVoltage: 12,
      role: "primary-power-source",
      wireColorPositive: "red",
      wireColorNegative: "black",
      weightLbs: 13,
    },
  },
  {
    type: "MainBreaker",
    displayName: "120A Main Breaker",
    category: DeviceCategory.POWER,
    ports: [
      port("power_in", PortType.POWER, PortDirection.INPUT, true, 1),
      powerOutput("power_out", 1),
      port("ground_in", PortType.GROUND, PortDirection.INPUT, true, 1),
      groundOutput("ground_out", 1),
    ],
    metadata: {
      role: "main-breaker",
      ratingAmps: 120,
    },
  },
  {
    type: "PDP",
    displayName: "Power Distribution Panel",
    category: DeviceCategory.POWER,
    ports: [
      port("main_power_in", PortType.POWER, PortDirection.INPUT, true, 1),
      groundInput("ground_in", true),
      ...pdpChannelPorts(),
      groundOutput("ground_bus", 24),
      canPort("can_bus"),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "CTR Electronics",
      shortName: "PDP",
      channelCount: 16,
      defaultCanId: 0,
    },
  },
  {
    type: "PDH",
    displayName: "Power Distribution Hub",
    category: DeviceCategory.POWER,
    ports: [
      port("main_power_in", PortType.POWER, PortDirection.INPUT, true, 1),
      groundInput("ground_in", true),
      ...pdhChannelPorts(),
      powerOutput("vrm_out", 1),
      groundOutput("ground_bus", 32),
      canPort("can_bus", 2),
      port("usb_c", PortType.USBC, PortDirection.BIDIRECTIONAL, false, 1),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "REV Robotics",
      shortName: "PDH",
      partNumber: "REV-11-1850",
      highCurrentChannels: "0-19",
      lowCurrentChannels: "20-22",
      switchedChannel: "23",
      defaultCanId: 1,
      weightLbs: 1.5,
    },
  },
  {
    type: "VRM",
    displayName: "Voltage Regulator Module",
    category: DeviceCategory.POWER,
    ports: [powerInput(), groundInput(), ...vrmRegulatedOutputs()],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "CTR Electronics",
      note: "Radio is typically powered from a 12V/2A output",
      weightLbs: 0.4,
    },
  },
  {
    type: "RoboRIO",
    displayName: "RoboRIO",
    category: DeviceCategory.CONTROLLER,
    ports: [
      powerInput(),
      groundInput(),
      canPort("can_bus", 2, true),
      ethernetPort("eth_0", true),
      port("usb_b", PortType.USBA, PortDirection.BIDIRECTIONAL, false, 1),
      port("pwm_0", PortType.PWM, PortDirection.OUTPUT, false, 1),
      port("dio_0", PortType.DIO, PortDirection.BIDIRECTIONAL, false, 1),
      port("i2c", PortType.I2C, PortDirection.BIDIRECTIONAL, false, 4),
      port("spi", PortType.SPI, PortDirection.BIDIRECTIONAL, false, 4),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "NI",
      role: "main-controller",
      defaultIpAddress: "10.6.91.2",
      nominalCurrentAmps: 2.5,
      peakCurrentAmps: 4,
      weightLbs: 1.1,
    },
  },
  {
    type: "SystemCore",
    displayName: "SystemCore",
    category: DeviceCategory.CONTROLLER,
    ports: [
      powerInput(),
      groundInput(),
      canPort("can_bus", 2, true),
      ethernetPort("eth_0"),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: { manufacturer: "REV Robotics" },
  },
  {
    type: "SparkMax",
    displayName: "Spark MAX",
    category: DeviceCategory.MOTOR_CONTROLLER,
    ports: [
      powerInput(),
      groundInput(),
      powerOutput("motor_a", 1),
      powerOutput("motor_b", 1),
      powerOutput("motor_c", 1),
      canPort("can_bus", 2),
      port("usb_c", PortType.USBC, PortDirection.BIDIRECTIONAL, false, 1),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "REV Robotics",
      partNumber: "REV-11-2158",
      motorType: "brushless-3-phase",
      nominalCurrentAmps: 15,
      peakCurrentAmps: 40,
      weightLbs: 0.7,
    },
  },
  {
    type: "SparkFlex",
    displayName: "Spark Flex",
    category: DeviceCategory.MOTOR_CONTROLLER,
    ports: [
      powerInput(),
      groundInput(),
      powerOutput("motor_a", 1),
      powerOutput("motor_b", 1),
      powerOutput("motor_c", 1),
      canPort("can_bus", 2),
      port("usb_c", PortType.USBC, PortDirection.BIDIRECTIONAL, false, 1),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "REV Robotics",
      motorType: "brushless-3-phase",
      nominalCurrentAmps: 15,
      peakCurrentAmps: 40,
      weightLbs: 0.65,
    },
  },
  {
    type: "TalonFX",
    displayName: "Talon FX",
    category: DeviceCategory.MOTOR_CONTROLLER,
    ports: [
      powerInput(),
      groundInput(),
      powerOutput("motor_a", 1),
      powerOutput("motor_b", 1),
      powerOutput("motor_c", 1),
      canPort("can_bus", 2),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "CTR Electronics",
      motorType: "brushless-3-phase",
      nominalCurrentAmps: 18,
      peakCurrentAmps: 60,
      weightLbs: 0.8,
    },
  },
  {
    type: "CANcoder",
    displayName: "CANcoder",
    category: DeviceCategory.SENSOR,
    ports: [powerInput(), groundInput(), canPort("can_bus", 2, true)],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.CAN, minConnections: 1 },
    ],
    metadata: {
      manufacturer: "CTR Electronics",
      nominalCurrentAmps: 0.1,
      peakCurrentAmps: 0.2,
      weightLbs: 0.3,
    },
  },
  {
    type: "Pigeon2",
    displayName: "Pigeon 2",
    category: DeviceCategory.SENSOR,
    ports: [powerInput(), groundInput(), canPort("can_bus", 2, true)],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.CAN, minConnections: 1 },
    ],
    metadata: {
      manufacturer: "CTR Electronics",
      nominalCurrentAmps: 0.1,
      peakCurrentAmps: 0.2,
      weightLbs: 0.3,
    },
  },
  {
    type: "Limelight",
    displayName: "Limelight",
    category: DeviceCategory.VISION,
    ports: [powerInput(), groundInput(), ethernetPort("eth_0", true)],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.ETHERNET, minConnections: 1 },
    ],
    metadata: { role: "vision-camera", nominalCurrentAmps: 2, peakCurrentAmps: 3, weightLbs: 1.2 },
  },
  {
    type: "USBCamera",
    displayName: "USB Camera",
    category: DeviceCategory.VISION,
    // Bus-powered over USB — no separate 12V power/ground terminals.
    ports: [port("usb", PortType.USBA, PortDirection.BIDIRECTIONAL, true, 1)],
    requirements: [{ portType: PortType.USBA, minConnections: 1 }],
    metadata: { role: "usb-vision-camera", weightLbs: 0.2 },
  },
  {
    type: "OrangePi",
    displayName: "Orange Pi",
    category: DeviceCategory.VISION,
    ports: [
      powerInput(),
      groundInput(),
      ethernetPort("eth_0", true),
      port("usb_a", PortType.USBA, PortDirection.BIDIRECTIONAL, false, 4),
    ],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.ETHERNET, minConnections: 1 },
    ],
    metadata: { role: "coprocessor" },
  },
  {
    type: "RaspberryPi",
    displayName: "Raspberry Pi",
    category: DeviceCategory.VISION,
    ports: [
      powerInput(),
      groundInput(),
      ethernetPort("eth_0", true),
      port("usb_a", PortType.USBA, PortDirection.BIDIRECTIONAL, false, 4),
    ],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.ETHERNET, minConnections: 1 },
    ],
    metadata: { role: "coprocessor" },
  },
  {
    type: "Radio",
    displayName: "OpenMesh Radio",
    category: DeviceCategory.NETWORK,
    ports: [
      powerInput(),
      groundInput(),
      ethernetPort("eth_poe", true),
      ethernetPort("eth_aux"),
    ],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.ETHERNET, minConnections: 1 },
    ],
    metadata: {
      role: "field-network-bridge",
      models: ["OM5P-AN", "OM5P-AC"],
      nominalVoltage: 12,
      maxCurrentAmps: 2,
      nominalCurrentAmps: 1.5,
      peakCurrentAmps: 2,
      weightLbs: 0.5,
      note: "Power from VRM 12V/2A; eth_poe is the port nearest the barrel jack",
    },
  },
  {
    type: "EthernetSwitch",
    displayName: "Ethernet Switch",
    category: DeviceCategory.NETWORK,
    ports: [
      powerInput(),
      groundInput(),
      ethernetPort("eth_0"),
      ethernetPort("eth_1"),
      ethernetPort("eth_2"),
      ethernetPort("eth_3"),
      ethernetPort("eth_4"),
    ],
    requirements: [
      ...poweredDeviceRequirements()!,
      { portType: PortType.ETHERNET, minConnections: 1 },
    ],
    metadata: {
      role: 'network-switch',
      nominalCurrentAmps: 0.5,
      peakCurrentAmps: 0.7,
      weightLbs: 0.4,
    },
  },
  {
    type: "CANivore",
    displayName: "CANivore",
    category: DeviceCategory.NETWORK,
    ports: [
      powerInput(),
      groundInput(),
      canPort("can_bus", 2, true),
      port("usb", PortType.USBA, PortDirection.BIDIRECTIONAL, false, 1),
    ],
    requirements: poweredDeviceRequirements(),
    metadata: {
      manufacturer: "CTR Electronics",
      role: "can-bus",
      // TODO(arihant): datasheet value
      note: "Second CAN bus. Devices on this bus are not on the roboRIO daisy chain.",
    },
  },
];

export class DeviceRegistry {
  private readonly definitions = new Map<string, DeviceDefinition>();

  constructor(definitions: DeviceDefinition[] = []) {
    this.registerMany(definitions);
  }

  register(
    definition: DeviceDefinition,
    options: RegisterOptions = {},
  ): DeviceDefinition {
    if (!options.overwrite && this.definitions.has(definition.type)) {
      throw new Error(
        `Device definition already registered: ${definition.type}`,
      );
    }

    this.definitions.set(definition.type, definition);
    return definition;
  }

  registerMany(
    definitions: DeviceDefinition[],
    options: RegisterOptions = {},
  ): DeviceDefinition[] {
    return definitions.map((definition) => this.register(definition, options));
  }

  loadPlugin(plugin: DeviceRegistryPlugin): void {
    this.registerMany(plugin.devices ?? []);
    plugin.register?.(this);
  }

  get(type: string): DeviceDefinition | undefined {
    return this.definitions.get(type);
  }

  require(type: string): DeviceDefinition {
    const definition = this.get(type);
    if (!definition) {
      throw new Error(`Unknown device definition: ${type}`);
    }
    return definition;
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  list(): DeviceDefinition[] {
    return [...this.definitions.values()];
  }

  listByCategory(category: DeviceCategory): DeviceDefinition[] {
    return this.list().filter((definition) => definition.category === category);
  }

  clear(): void {
    this.definitions.clear();
  }
}

export function createDefaultDeviceRegistry(): DeviceRegistry {
  return new DeviceRegistry(builtInDeviceDefinitions);
}

export const defaultDeviceRegistry = createDefaultDeviceRegistry();
