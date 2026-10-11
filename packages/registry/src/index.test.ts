import {
  DeviceCategory,
  PortDirection,
  PortType,
  type DeviceDefinition,
} from "@691sim/core";
import { describe, expect, it } from "vitest";
import {
  builtInDeviceDefinitions,
  createDefaultDeviceRegistry,
  defaultDeviceRegistry,
  DeviceRegistry,
} from "./index.js";

describe("builtInDeviceDefinitions", () => {
  it("includes every Phase 2 device type", () => {
    expect(
      builtInDeviceDefinitions.map((definition) => definition.type),
    ).toEqual([
      "Battery",
      "MainBreaker",
      "PDP",
      "PDH",
      "VRM",
      "RoboRIO",
      "SystemCore",
      "SparkMax",
      "SparkFlex",
      "TalonFX",
      "CANcoder",
      "Pigeon2",
      "Limelight",
      "PhotonVision",
      "OrangePi",
      "Radio",
      "EthernetSwitch",
      "CANivore",
    ]);
  });

  it("assigns each listed Phase 2 category", () => {
    expect(
      createDefaultDeviceRegistry().listByCategory(DeviceCategory.POWER),
    ).toHaveLength(5);
    expect(
      createDefaultDeviceRegistry().listByCategory(DeviceCategory.CONTROLLER),
    ).toHaveLength(2);
    expect(
      createDefaultDeviceRegistry().listByCategory(
        DeviceCategory.MOTOR_CONTROLLER,
      ),
    ).toHaveLength(3);
    expect(
      createDefaultDeviceRegistry().listByCategory(DeviceCategory.SENSOR),
    ).toHaveLength(2);
    expect(
      createDefaultDeviceRegistry().listByCategory(DeviceCategory.VISION),
    ).toHaveLength(3);
    expect(
      createDefaultDeviceRegistry().listByCategory(DeviceCategory.NETWORK),
    ).toHaveLength(3);
  });

  it("describes expected ports for common FRC devices", () => {
    const registry = createDefaultDeviceRegistry();

    expect(registry.require("Battery").ports).toContainEqual({
      id: "main_power",
      type: PortType.POWER,
      direction: PortDirection.OUTPUT,
      required: false,
      maxConnections: 1,
    });

    expect(registry.require("Battery").ports).toContainEqual({
      id: "ground",
      type: PortType.GROUND,
      direction: PortDirection.OUTPUT,
      required: false,
      maxConnections: 4,
    });

    expect(
      registry
        .require("RoboRIO")
        .ports.some((port) => port.type === PortType.CAN),
    ).toBe(true);
    expect(registry.require("Limelight").requirements).toEqual([
      { portType: PortType.POWER, minConnections: 1 },
      { portType: PortType.GROUND, minConnections: 1 },
      { portType: PortType.ETHERNET, minConnections: 1 },
    ]);
  });
});

describe("DeviceRegistry", () => {
  const customDevice: DeviceDefinition = {
    type: "CustomSensor",
    displayName: "Custom Sensor",
    category: DeviceCategory.SENSOR,
    ports: [
      {
        id: "can_bus",
        type: PortType.CAN,
        direction: PortDirection.BIDIRECTIONAL,
      },
    ],
  };

  it("registers and looks up a device definition by type", () => {
    const registry = new DeviceRegistry();

    registry.register(customDevice);

    expect(registry.has("CustomSensor")).toBe(true);
    expect(registry.get("CustomSensor")).toBe(customDevice);
    expect(registry.require("CustomSensor")).toBe(customDevice);
  });

  it("rejects duplicate registrations unless overwrite is requested", () => {
    const registry = new DeviceRegistry([customDevice]);

    expect(() => registry.register(customDevice)).toThrow(/already registered/);

    const replacement = { ...customDevice, displayName: "Replacement Sensor" };
    registry.register(replacement, { overwrite: true });

    expect(registry.require("CustomSensor").displayName).toBe(
      "Replacement Sensor",
    );
  });

  it("throws when require cannot find a type", () => {
    expect(() => new DeviceRegistry().require("MissingDevice")).toThrow(
      /Unknown device/,
    );
  });

  it("loads plugin-provided devices and registration callbacks", () => {
    const registry = new DeviceRegistry();

    registry.loadPlugin({
      name: "test-plugin",
      devices: [customDevice],
      register: (pluginRegistry) => {
        pluginRegistry.register({
          type: "PluginMotor",
          displayName: "Plugin Motor",
          category: DeviceCategory.MOTOR_CONTROLLER,
          ports: [
            {
              id: "power_in",
              type: PortType.POWER,
              direction: PortDirection.INPUT,
            },
          ],
        });
      },
    });

    expect(registry.has("CustomSensor")).toBe(true);
    expect(registry.has("PluginMotor")).toBe(true);
  });

  it("exports a default registry loaded with built-ins", () => {
    expect(defaultDeviceRegistry.has("SparkMax")).toBe(true);
    expect(defaultDeviceRegistry.list()).toHaveLength(
      builtInDeviceDefinitions.length,
    );
  });
});
