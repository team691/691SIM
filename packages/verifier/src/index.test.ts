import { createHealthyRobotModel, Severity, type RobotModel } from "@691sim/core";
import { describe, expect, it } from "vitest";
import {
  buildGraph,
  canVerificationPass,
  DiagnosticCollection,
  getUnpoweredDeviceIds,
  verifyRobotModel,
  type VerificationPass,
} from "./index.js";

function healthyModel(): RobotModel {
  return createHealthyRobotModel();
}

describe("buildGraph", () => {
  it("constructs device nodes, port nodes, and connection edges", () => {
    const graph = buildGraph(healthyModel());

    expect(graph.getDevice("rio-1")?.definition.type).toBe("RoboRIO");
    expect(graph.getPort("spark-1", "can_bus")?.deviceId).toBe("spark-1");
    expect(graph.edges).toHaveLength(21);
  });

  it("traverses and finds shortest paths by connection type", () => {
    const graph = buildGraph(healthyModel());

    expect(graph.powerReachable("spark-1")).toBe(true);
    expect(graph.groundReachable("spark-1")).toBe(true);
    expect(graph.canReachable("coder-1")).toBe(true);
    expect(graph.networkReachable("limelight-1")).toBe(true);

    expect(
      graph.shortestPath("battery-1", "spark-1")?.map((device) => device.id),
    ).toEqual(["battery-1", "breaker-1", "pdh-1", "spark-1"]);
  });

  it("returns connected components for a selected port type", () => {
    const graph = buildGraph({
      ...healthyModel(),
      devices: [...healthyModel().devices, { id: "coder-2", type: "CANcoder" }],
    });

    const canComponents = graph
      .connectedComponents()
      .map((component) => component.map((device) => device.id));

    expect(
      canComponents.some((component) => component.includes("coder-2")),
    ).toBe(true);
  });
});

describe("verifyRobotModel", () => {
  it("returns no diagnostics for a healthy baseline robot", () => {
    const result = verifyRobotModel(healthyModel());

    expect(result.hasErrors).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("validates compatible port types, directions, and max connections", () => {
    const model = healthyModel();
    model.connections.push(
      {
        id: "bad-type",
        sourceDevice: "pdh-1",
        sourcePort: "channel_4",
        targetDevice: "rio-1",
        targetPort: "eth_0",
      },
      {
        id: "bad-direction",
        sourceDevice: "spark-1",
        sourcePort: "power_in",
        targetDevice: "pdh-1",
        targetPort: "channel_4",
      },
      {
        id: "too-many",
        sourceDevice: "pdh-1",
        sourcePort: "channel_1",
        targetDevice: "rio-1",
        targetPort: "power_in",
      },
    );

    const codes = verifyRobotModel(model).diagnostics.map(
      (diagnostic) => diagnostic.code,
    );

    expect(codes).toContain("INCOMPATIBLE_PORT_TYPES");
    expect(codes).toContain("INVALID_SOURCE_DIRECTION");
    expect(codes).toContain("MAX_CONNECTIONS_EXCEEDED");
  });

  it("validates required power, CAN, and Ethernet connections", () => {
    const model = healthyModel();
    model.connections = model.connections.filter(
      (connection) =>
        connection.id !== "pdh-spark-power" &&
        connection.id !== "spark-coder-can" &&
        connection.id !== "radio-limelight-eth",
    );

    const codes = verifyRobotModel(model).diagnostics.map(
      (diagnostic) => diagnostic.code,
    );

    expect(codes).toContain("REQUIRED_PORT_UNCONNECTED");
    expect(codes).toContain("POWER_NOT_REACHABLE");
    expect(codes).toContain("CAN_NOT_REACHABLE");
    expect(codes).toContain("NETWORK_NOT_REACHABLE");
  });

  it("verifies battery, radio, duplicate CAN IDs, and duplicate IP addresses", () => {
    const model = healthyModel();
    model.devices = model.devices
      .filter((device) => device.type !== "Battery" && device.type !== "Radio")
      .map((device) =>
        device.id === "spark-1"
          ? { ...device, metadata: { canId: 3 } }
          : device.id === "limelight-1"
            ? { ...device, metadata: { ipAddress: "10.6.91.2" } }
            : device,
      );
    model.connections = model.connections.filter(
      (connection) =>
        connection.sourceDevice !== "battery-1" &&
        connection.targetDevice !== "battery-1" &&
        connection.sourceDevice !== "radio-1" &&
        connection.targetDevice !== "radio-1" &&
        connection.sourceDevice !== "vrm-1" &&
        connection.targetDevice !== "vrm-1",
    );

    const codes = verifyRobotModel(model).diagnostics.map(
      (diagnostic) => diagnostic.code,
    );

    expect(codes).toContain("BATTERY_MISSING");
    expect(codes).toContain("RADIO_MISSING");
    expect(codes).toContain("DUPLICATE_CAN_ID");
    expect(codes).toContain("DUPLICATE_IP_ADDRESS");
  });

  it("runs custom verification passes through the diagnostic collection", () => {
    const pass: VerificationPass = {
      id: "custom-pass",
      run: () => [
        {
          id: "custom-1",
          severity: Severity.WARNING,
          message: "Custom warning",
          code: "CUSTOM_WARNING",
        },
      ],
    };

    const result = verifyRobotModel(healthyModel(), { passes: [pass] });
    const collection = new DiagnosticCollection();
    collection.addMany(result.diagnostics);

    expect(result.diagnostics).toHaveLength(1);
    expect(collection.hasErrors()).toBe(false);
  });

  it("flags all powered devices (including VRM and radio) when battery is removed", () => {
    const model = healthyModel();
    model.connections = model.connections.filter(
      (connection) =>
        connection.sourceDevice !== "battery-1" &&
        connection.targetDevice !== "battery-1",
    );

    const graph = buildGraph(model);
    const unpowered = getUnpoweredDeviceIds(graph);
    const codes = verifyRobotModel(model).diagnostics.map(
      (diagnostic) => diagnostic.code,
    );

    expect(unpowered).toContain("vrm-1");
    expect(unpowered).toContain("radio-1");
    expect(unpowered).toContain("pdh-1");
    expect(codes).toContain("POWER_NOT_REACHABLE");
  });

  it("flags an open main breaker and marks downstream devices unpowered", () => {
    const model = healthyModel();
    const breaker = model.devices.find((d) => d.id === "breaker-1")!;
    breaker.metadata = { ...breaker.metadata, breakerClosed: false };

    const graph = buildGraph(model);
    const unpowered = getUnpoweredDeviceIds(graph);
    const codes = verifyRobotModel(model).diagnostics.map((d) => d.code);

    expect(codes).toContain("BREAKER_OPEN");
    expect(unpowered).toContain("pdh-1");
    expect(unpowered).toContain("rio-1");
    expect(graph.powerReachable("pdh-1")).toBe(false);
  });

  it("checks that CANivore devices stay on the CANivore bus", () => {
    const result = verifyRobotModel(
      {
        schemaVersion: 1,
        id: "canivore-robot",
        name: "CANivore",
        devices: [
          { id: "rio-1", type: "RoboRIO" },
          { id: "spark-1", type: "SparkMax", metadata: { canId: 2 } },
          { id: "spark-2", type: "SparkMax", metadata: { canId: 5, canBus: "canivore" } },
          { id: "pdh-1", type: "PDH", metadata: { canId: 1 } },
          { id: "canivore-1", type: "CANivore" },
          { id: "coder-1", type: "CANcoder", metadata: { canId: 3, canBus: "canivore" } },
          { id: "coder-2", type: "CANcoder", metadata: { canId: 4, canBus: "rio" } },
        ],
        connections: [
          {
            id: "c1",
            sourceDevice: "rio-1",
            sourcePort: "can_bus",
            targetDevice: "spark-1",
            targetPort: "can_bus",
          },
          {
            id: "c2",
            sourceDevice: "spark-1",
            sourcePort: "can_bus",
            targetDevice: "spark-2",
            targetPort: "can_bus",
          },
          {
            id: "c3",
            sourceDevice: "spark-2",
            sourcePort: "can_bus",
            targetDevice: "pdh-1",
            targetPort: "can_bus",
          },
          {
            id: "c4",
            sourceDevice: "canivore-1",
            sourcePort: "can_bus",
            targetDevice: "coder-1",
            targetPort: "can_bus",
          },
          {
            id: "c5",
            sourceDevice: "coder-1",
            sourcePort: "can_bus",
            targetDevice: "coder-2",
            targetPort: "can_bus",
          },
        ],
      },
      { passes: [canVerificationPass] },
    );
    const wrong = result.diagnostics.filter((diagnostic) => diagnostic.code === "CAN_WRONG_BUS");
    const wrongIds = wrong.flatMap((diagnostic) => diagnostic.deviceIds ?? []);
    expect(wrongIds).toContain("spark-2");
    expect(wrongIds).toContain("coder-2");
    expect(wrongIds).not.toContain("coder-1");
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "ISOLATED_CAN_SEGMENT")).toBe(
      false,
    );
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "CAN_NOT_REACHABLE" && diagnostic.deviceIds?.includes("coder-1"),
      ),
    ).toBe(false);
  });
});
