/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useMemo, useState } from 'react';
import type { Connection, DeviceInstance, Diagnostic, RobotModel } from '@691sim/core';
import { PortType } from '@691sim/core';
import { createDefaultDeviceRegistry } from '@691sim/registry';
import { verifyRobotModel, buildGraph, getUnpoweredDeviceIds } from '@691sim/verifier';
import { simulateCircuit, type LoadMode } from '@691sim/simulation';
import { exportProject, importProject, validateProject } from '@691sim/serialization';
import { createEmptyModel, nextConnectionId, nextDeviceId } from '../utils/labels';
import { createPairedGroundConnection, groundConnectionIdForPower, isPowerConnection } from '../utils/groundPairing';
import { canConnectPorts } from '../utils/connectionRules';
import { getPdhFuseInfo, getFuseRatingAmps, fuseExceedsRating } from '../utils/fuses';
import { resolveConnectionPortType } from '../utils/wireStyles';

export type SelectedPort = {
  deviceId: string;
  portId: string;
};

const EMPTY_VERIFICATION = { diagnostics: [] as Diagnostic[], hasErrors: false };

export function useRobotModel(initial: RobotModel) {
  const [model, setModel] = useState<RobotModel>(initial);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [highlightDeviceIds, setHighlightDeviceIds] = useState<string[]>([]);
  const [pendingPort, setPendingPort] = useState<SelectedPort | null>(null);
  const [verification, setVerification] = useState(EMPTY_VERIFICATION);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState(0);
  const [simulationMode, setSimulationMode] = useState<LoadMode>('peak');
  const [wireMessage, setWireMessage] = useState<string | null>(null);
  const [showWireLabels, setShowWireLabels] = useState(true);
  /** Timeline brownout-path highlight on the editor canvas. */
  const [powerPathConnectionIds, setPowerPathConnectionIds] = useState<string[]>([]);
  const [powerPathDropByConnection, setPowerPathDropByConnection] = useState<Record<string, number>>(
    {},
  );

  const registry = useMemo(() => createDefaultDeviceRegistry(), []);

  const graph = useMemo(() => {
    try {
      return buildGraph(model, { registry });
    } catch {
      return null;
    }
  }, [model, registry]);

  const deviceTypes = useMemo(
    () => new Map(model.devices.map((d: DeviceInstance) => [d.id, d.type])),
    [model.devices],
  );

  const simulation = useMemo(() => {
    try {
      return simulateCircuit(model, { registry, mode: simulationMode });
    } catch {
      return null;
    }
  }, [model, registry, simulationMode]);

  const ampacityConnectionIds = useMemo(
    () => new Set((simulation?.ampacityViolations ?? []).map((w) => w.connectionId)),
    [simulation],
  );

  const fuseViolationConnectionIds = useMemo(() => {
    const ids = new Set<string>();
    if (!simulation) return ids;

    for (const wire of simulation.voltage.wireCurrents) {
      const conn = model.connections.find((c) => c.id === wire.connectionId);
      if (!conn) continue;
      const srcType = deviceTypes.get(conn.sourceDevice) ?? '';
      const tgtType = deviceTypes.get(conn.targetDevice) ?? '';
      const portType =
        resolveConnectionPortType(registry, conn.sourceDevice, srcType, conn.sourcePort) ??
        PortType.POWER;
      const fuseInfo = getPdhFuseInfo(
        portType,
        srcType,
        conn.sourcePort,
        tgtType,
        conn.targetPort,
      );
      if (!fuseInfo.show) continue;
      const fuseAmps = getFuseRatingAmps(conn, fuseInfo.port);
      if (fuseExceedsRating(wire.currentAmps, fuseAmps)) {
        ids.add(conn.id);
      }
    }
    return ids;
  }, [simulation, model.connections, deviceTypes, registry]);

  const allDiagnostics = useMemo(() => {
    const seen = new Set<string>();
    const merged = [...verification.diagnostics, ...(simulation?.diagnostics ?? [])];
    return merged.filter((d) => {
      const key = `${d.code ?? ''}|${d.message}|${(d.deviceIds ?? []).join(',')}|${(d.connectionIds ?? []).join(',')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [verification.diagnostics, simulation?.diagnostics]);

  const errorDeviceIds = useMemo(() => {
    const ids = new Set<string>();

    if (graph) {
      for (const id of getUnpoweredDeviceIds(graph)) {
        ids.add(id);
      }
    }

    for (const diag of allDiagnostics) {
      if (diag.severity === 2) {
        diag.deviceIds?.forEach((id) => ids.add(id));
      }
    }
    return ids;
  }, [graph, allDiagnostics]);

  const selectedDevice = useMemo(
    () => model.devices.find((d: any) => d.id === selectedDeviceId) ?? null,
    [model.devices, selectedDeviceId],
  );

  const selectedDefinition = useMemo(() => {
    if (!selectedDevice) return null;
    return registry.get(selectedDevice.type) ?? null;
  }, [registry, selectedDevice]);

  const updateModel = useCallback((updater: (prev: RobotModel) => RobotModel) => {
    setModel((prev: any) => updater(prev));
  }, []);

  const runVerification = useCallback(async () => {
    setIsVerifying(true);
    setVerifyProgress(0);

    const steps = [15, 40, 65, 85, 100];
    for (const step of steps) {
      await new Promise((r) => setTimeout(r, 80));
      setVerifyProgress(step);
    }

    const result = verifyRobotModel(model, { registry });
    setVerification(result);
    setIsVerifying(false);
  }, [model, registry]);

  const newProject = useCallback((name?: string) => {
    setModel(createEmptyModel(name));
    setSelectedDeviceId(null);
    setSelectedConnectionId(null);
    setPendingPort(null);
    setHighlightDeviceIds([]);
    setVerification(EMPTY_VERIFICATION);
  }, []);

  const loadSample = useCallback((sample: RobotModel) => {
    setModel(sample);
    setSelectedDeviceId(null);
    setSelectedConnectionId(null);
    setPendingPort(null);
    setHighlightDeviceIds([]);
    setVerification(EMPTY_VERIFICATION);
  }, []);

  const loadFromJson = useCallback((json: string) => {
    const loaded = importProject(json);
    setModel(loaded);
    setSelectedDeviceId(null);
    setSelectedConnectionId(null);
    setPendingPort(null);
    setHighlightDeviceIds([]);
    setVerification(EMPTY_VERIFICATION);
    return loaded;
  }, []);

  const exportJson = useCallback(() => exportProject(model), [model]);

  const addDevice = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const id = nextDeviceId(type, model.devices);
      const def = registry.get(type);
      const instance: DeviceInstance = {
        id,
        type,
        label: def?.displayName ?? type,
        position: position ?? {
          x: 80 + (model.devices.length % 4) * 180,
          y: 80 + Math.floor(model.devices.length / 4) * 140,
        },
      };
      updateModel((prev) => ({
        ...prev,
        devices: [...prev.devices, instance],
      }));
      setSelectedDeviceId(id);
      setSelectedConnectionId(null);
    },
    [model.devices, registry, updateModel],
  );

  const removeDevice = useCallback(
    (deviceId: string) => {
      updateModel((prev) => ({
        ...prev,
        devices: prev.devices.filter((d: any) => d.id !== deviceId),
        connections: prev.connections.filter(
          (c: any) => c.sourceDevice !== deviceId && c.targetDevice !== deviceId,
        ),
      }));
      if (selectedDeviceId === deviceId) setSelectedDeviceId(null);
      setPendingPort(null);
    },
    [selectedDeviceId, updateModel],
  );

  const updateDevice = useCallback(
    (deviceId: string, patch: Partial<DeviceInstance>) => {
      updateModel((prev) => ({
        ...prev,
        devices: prev.devices.map((d: any) =>
          d.id === deviceId ? { ...d, ...patch, metadata: { ...d.metadata, ...patch.metadata } } : d,
        ),
      }));
    },
    [updateModel],
  );

  const moveDevice = useCallback(
    (deviceId: string, position: { x: number; y: number }) => {
      updateModel((prev) => ({
        ...prev,
        devices: prev.devices.map((d: any) => (d.id === deviceId ? { ...d, position } : d)),
      }));
    },
    [updateModel],
  );

  const addConnection = useCallback(
    (source: SelectedPort, target: SelectedPort) => {
      const check = canConnectPorts(registry, deviceTypes, model.connections, source, target);
      if (!check.ok || !check.oriented) {
        setWireMessage(check.reason ?? 'Cannot connect these ports.');
        setPendingPort(null);
        return;
      }

      const connection: Connection = {
        id: nextConnectionId(model.connections),
        sourceDevice: check.oriented.sourceDevice,
        sourcePort: check.oriented.sourcePort,
        targetDevice: check.oriented.targetDevice,
        targetPort: check.oriented.targetPort,
      };

      const sourceType = deviceTypes.get(connection.sourceDevice) ?? '';
      const targetType = deviceTypes.get(connection.targetDevice) ?? '';
      const extra: Connection[] = [];

      if (isPowerConnection(registry, connection, sourceType)) {
        const ground = createPairedGroundConnection(
          registry,
          connection,
          sourceType,
          targetType,
        );
        if (ground) extra.push(ground);
      }

      updateModel((prev) => ({
        ...prev,
        connections: [...prev.connections, connection, ...extra],
      }));
      setPendingPort(null);
      setWireMessage(null);
      setSelectedConnectionId(connection.id);
    },
    [deviceTypes, model.connections, registry, updateModel],
  );

  const tryConnect = useCallback(
    (source: SelectedPort, target: SelectedPort) => {
      addConnection(source, target);
    },
    [addConnection],
  );

  const startWireFrom = useCallback((deviceId: string, portId: string) => {
    setPendingPort({ deviceId, portId });
    setSelectedDeviceId(deviceId);
    setSelectedConnectionId(null);
    setWireMessage('Drag to a matching port, or click another port to finish.');
  }, []);

  const cancelWire = useCallback(() => {
    setPendingPort(null);
    setWireMessage(null);
  }, []);

  const updateConnection = useCallback(
    (connectionId: string, patch: Partial<Connection>) => {
      updateModel((prev) => ({
        ...prev,
        connections: prev.connections.map((c: any) =>
          c.id === connectionId
            ? { ...c, ...patch, metadata: { ...c.metadata, ...patch.metadata } }
            : c,
        ),
      }));
    },
    [updateModel],
  );

  const setConnectionWaypoints = useCallback(
    (connectionId: string, waypoints: { x: number; y: number }[]) => {
      updateConnection(connectionId, { metadata: { waypoints } });
    },
    [updateConnection],
  );

  const removeConnection = useCallback(
    (connectionId: string) => {
      const groundId = groundConnectionIdForPower(connectionId);
      updateModel((prev) => ({
        ...prev,
        connections: prev.connections.filter(
          (c: any) => c.id !== connectionId && c.id !== groundId,
        ),
      }));
      if (selectedConnectionId === connectionId) setSelectedConnectionId(null);
    },
    [selectedConnectionId, updateModel],
  );

  const handlePortClick = useCallback(
    (deviceId: string, portId: string) => {
      if (!pendingPort) {
        startWireFrom(deviceId, portId);
        return;
      }
      if (pendingPort.deviceId === deviceId && pendingPort.portId === portId) {
        cancelWire();
        return;
      }
      tryConnect(pendingPort, { deviceId, portId });
    },
    [cancelWire, pendingPort, startWireFrom, tryConnect],
  );

  const focusDiagnostic = useCallback((deviceIds?: string[], connectionIds?: string[]) => {
    setHighlightDeviceIds(deviceIds ?? []);
    if (deviceIds?.[0]) setSelectedDeviceId(deviceIds[0]);
    if (connectionIds?.[0]) setSelectedConnectionId(connectionIds[0]);
  }, []);

  const setPowerPathHighlight = useCallback(
    (connectionIds: string[], dropsByConnection: Record<string, number> = {}) => {
      setPowerPathConnectionIds(connectionIds);
      setPowerPathDropByConnection(dropsByConnection);
    },
    [],
  );

  const clearPowerPathHighlight = useCallback(() => {
    setPowerPathConnectionIds([]);
    setPowerPathDropByConnection({});
  }, []);

  const validateCurrent = useCallback(() => validateProject(model), [model]);

  return {
    model,
    setModel,
    registry,
    verification,
    isVerifying,
    verifyProgress,
    runVerification,
    errorDeviceIds,
    deviceTypes,
    graph,
    simulation,
    simulationMode,
    setSimulationMode,
    ampacityConnectionIds,
    fuseViolationConnectionIds,
    wireMessage,
    showWireLabels,
    setShowWireLabels,
    allDiagnostics,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedConnectionId,
    setSelectedConnectionId,
    selectedDevice,
    selectedDefinition,
    highlightDeviceIds,
    pendingPort,
    setPendingPort,
    newProject,
    loadSample,
    loadFromJson,
    exportJson,
    addDevice,
    removeDevice,
    updateDevice,
    moveDevice,
    addConnection,
    updateConnection,
    setConnectionWaypoints,
    removeConnection,
    handlePortClick,
    startWireFrom,
    tryConnect,
    cancelWire,
    focusDiagnostic,
    powerPathConnectionIds,
    powerPathDropByConnection,
    setPowerPathHighlight,
    clearPowerPathHighlight,
    validateCurrent,
  };
}

export type RobotModelState = ReturnType<typeof useRobotModel>;
