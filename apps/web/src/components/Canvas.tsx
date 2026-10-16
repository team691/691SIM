import { useCallback, useRef, useState, type PointerEvent } from 'react';
import {
  PortType,
  type DeviceDefinition,
  type DeviceInstance,
  type Port,
} from '@691sim/core';
import type { RobotModelState } from '../hooks/useRobotModel';
import { usePanScroll } from '../hooks/usePanScroll';
import { portTypeColor, PORT_TYPE_NAMES } from '../utils/labels';
import { resolveConnectionPortType, resolveWireColors } from '../utils/wireStyles';
import {
  ampacityMarkerRect,
  buildSmoothWirePathD,
  computeWireRoutes,
  deviceCaptionRect,
  estimateLabelBounds,
  fuseMarkerRect,
  getDisplayConnections,
  offsetManhattanPath,
  resolveLabelPositions,
  wireSegmentObstacles,
  type LabelObstacle,
  type Point,
  type Rect,
} from '../utils/wireRouting';
import { isPortConnected, portDisplayLabel } from '../utils/visiblePorts';
import { deviceLayout, devicePortOffsets } from '../utils/devicePorts';
import { deviceImage } from '../utils/deviceImages';
import {
  isCompatibleTarget,
  isPortAtCapacity,
} from '../utils/connectionRules';
import { getPdhFuseInfo, getFuseRatingAmps, fuseRatingLabel } from '../utils/fuses';
import { buildCanLabelCarriers, resolveWireLabel, wireAnnotation } from '../utils/wireLabels';
interface CanvasProps {
  state: RobotModelState;
}

const DEVICE_W = 168;
const WIRE_DRAG_THRESHOLD_PX = 4;

/**
 * Ports that get a dot on the diagram. Ground is excluded because the app
 * auto-pairs a ground return with every power wire and draws the pair as one
 * two-tone run, so grounds are never wired by hand.
 */
function canvasPorts(def: DeviceDefinition): Port[] {
  return def.ports.filter((port) => port.type !== PortType.GROUND);
}

function WirePath({
  path,
  color,
  width,
  dash,
  offset = 0,
}: {
  path: Point[];
  color: string;
  width: number;
  dash?: string;
  offset?: number;
}) {
  if (path.length < 2) return null;
  const shifted = offsetManhattanPath(path, offset);
  // Sharp corners: real wire runs bend at right angles, not curves.
  const d = buildSmoothWirePathD(shifted, 0);

  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dash}
    />
  );
}

function FuseMarker({
  x,
  y,
  rating,
  fault,
}: {
  x: number;
  y: number;
  rating: string;
  fault?: boolean;
}) {
  return (
    <g className={`fuse-marker ${fault ? 'fuse-fault' : ''}`} transform={`translate(${x - 18}, ${y - 10})`}>
      <rect
        width="36"
        height="20"
        rx="6"
        className="fuse-marker-rect"
        fill={fault ? 'var(--fuse-fault-fill)' : 'var(--fuse-fill)'}
        stroke={fault ? 'var(--fuse-fault-stroke)' : 'var(--fuse-stroke)'}
        strokeWidth="1"
      />
      <text
        x="18"
        y="13"
        textAnchor="middle"
        fontSize="8"
        fontWeight="700"
        fill={fault ? 'var(--fuse-fault-text)' : 'var(--fuse-stroke)'}
      >
        {rating}
      </text>
    </g>
  );
}

function AmpacityHazardMarker({ x, y }: { x: number; y: number }) {
  return (
    <g className="ampacity-marker" transform={`translate(${x}, ${y + 14})`}>
      <title>Exceeds Ampacity: Safety Hazard!</title>
      <path d="M0,-9 L9,7 L-9,7 Z" fill="#cc2936" stroke="#08415c" strokeWidth="1" />
      <text x="0" y="6" textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff">
        !
      </text>
    </g>
  );
}

function WireLabel({
  x,
  y,
  text,
  detail,
  crowded = false,
  anchor,
}: {
  x: number;
  y: number;
  text: string;
  detail?: string;
  crowded?: boolean;
  anchor?: Point;
}) {
  const lines = detail ? [text, detail] : [text];
  const { width, height } = estimateLabelBounds(text, detail);

  return (
    <g
      className={`wire-label ${crowded ? 'wire-label-crowded' : ''}`}
      transform={`translate(${x - width / 2}, ${y - height / 2})`}
      pointerEvents="none"
    >
      {crowded && anchor && (
        <line
          className="wire-label-leader"
          x1={anchor.x - (x - width / 2)}
          y1={anchor.y - (y - height / 2)}
          x2={width / 2}
          y2={height / 2}
          stroke="var(--text-muted)"
          strokeWidth="1"
          strokeDasharray="3 2"
        />
      )}
      <rect
        width={width}
        height={height}
        rx="4"
        className="wire-label-bg"
        fill="var(--bg-panel)"
        stroke={crowded ? 'var(--accent)' : 'var(--border-soft)'}
        strokeWidth="1"
        opacity={crowded ? 1 : 0.97}
      />
      {lines.map((line, i) => (
        <text
          key={i}
          x={width / 2}
          y={12 + i * 11}
          textAnchor="middle"
          fontSize={i === 0 ? '9' : '7.5'}
          fontWeight={i === 0 ? '600' : '400'}
          fill={i === 0 ? 'var(--text)' : 'var(--text-muted)'}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

interface ConnectionLinesProps {
  state: RobotModelState;
  getPortPosition: (deviceId: string, portId: string) => Point | undefined;
  getDeviceBounds: (deviceId: string) => Rect | undefined;
}

function ConnectionLines({
  state,
  getPortPosition,
  getDeviceBounds,
}: ConnectionLinesProps) {
  const {
    model,
    registry,
    deviceTypes,
    selectedConnectionId,
    setSelectedConnectionId,
    setSelectedDeviceId,
    highlightDeviceIds,
    ampacityConnectionIds,
    fuseViolationConnectionIds,
    simulation,
    showWireLabels,
  } = state;

  const getCenter = (deviceId: string) => {
    const device = model.devices.find((d) => d.id === deviceId);
    const layout = deviceLayout(deviceTypes.get(deviceId) ?? '');
    return {
      x: (device?.position?.x ?? 0) + (layout?.width ?? DEVICE_W) / 2,
      y: (device?.position?.y ?? 0) + (layout?.height ?? 72) / 2,
    };
  };

  const getPortPositionInner = (deviceId: string, portId: string) =>
    getPortPosition(deviceId, portId);

  const displayConnections = getDisplayConnections(model.connections, registry, deviceTypes);
  const routes = computeWireRoutes(
    displayConnections,
    getCenter,
    getPortPositionInner,
    registry,
    deviceTypes,
    getDeviceBounds,
  );

  const canLabelCarriers = buildCanLabelCarriers(model.connections, deviceTypes, registry);

  const labelRequests: Array<{
    id: string;
    anchor: Point;
    text: string;
    detail?: string;
    connectionId: string;
  }> = [];
  const routeMeta = new Map<
    string,
    {
      conn: (typeof displayConnections)[0];
      route: (typeof routes)[0];
      labelInfo: ReturnType<typeof resolveWireLabel>;
      fuseInfo: ReturnType<typeof getPdhFuseInfo>;
      fuseFault: boolean;
      fuseRating: string;
      annotation: string;
      visual: ReturnType<typeof resolveWireColors>;
      portType: PortType;
      labelAnchor: Point;
    }
  >();

  const labelObstacles: LabelObstacle[] = [];

  for (const device of model.devices) {
    const bounds = getDeviceBounds(device.id);
    if (!bounds) continue;
    labelObstacles.push({ rect: bounds, kind: 'device' });
    labelObstacles.push({ rect: deviceCaptionRect(bounds), kind: 'caption' });
  }

  for (const route of routes) {
    const conn = displayConnections.find((c) => c.id === route.connectionId);
    if (!conn) continue;

    const srcDevice = model.devices.find((d) => d.id === conn.sourceDevice);
    const tgtDevice = model.devices.find((d) => d.id === conn.targetDevice);
    const srcType = srcDevice?.type ?? '';
    const tgtType = tgtDevice?.type ?? '';
    const portType =
      resolveConnectionPortType(registry, conn.sourceDevice, srcType, conn.sourcePort) ??
      PortType.POWER;
    const visual = resolveWireColors(conn, portType);
    const fuseInfo = getPdhFuseInfo(
      portType,
      srcType,
      conn.sourcePort,
      tgtType,
      conn.targetPort,
    );
    const fuseFault = fuseViolationConnectionIds.has(conn.id);
    const fuseRating = fuseInfo.show
      ? fuseRatingLabel(getFuseRatingAmps(conn, fuseInfo.port))
      : '';
    const wireSim = simulation?.voltage.wireCurrents.find((w) => w.connectionId === conn.id);
    const annotation = wireAnnotation(conn, srcType, tgtType, portType, wireSim?.gauge);
    const labelInfo = resolveWireLabel(
      conn,
      model,
      registry,
      deviceTypes,
      canLabelCarriers,
      wireSim?.gauge,
    );

    const labelAnchor = {
      x: route.labelPoint.x,
      y: route.labelPoint.y - (fuseInfo.show ? 18 : 0),
    };

    routeMeta.set(conn.id, {
      conn,
      route,
      labelInfo,
      fuseInfo,
      fuseFault,
      fuseRating,
      annotation,
      visual,
      portType,
      labelAnchor,
    });

    labelObstacles.push(...wireSegmentObstacles(route.path, conn.id));
    if (fuseInfo.show) {
      labelObstacles.push({ rect: fuseMarkerRect(route.fusePoint), kind: 'fuse' });
    }
    if (ampacityConnectionIds.has(conn.id)) {
      labelObstacles.push({ rect: ampacityMarkerRect(route.fusePoint), kind: 'ampacity' });
    }

    if (showWireLabels && labelInfo.show && labelInfo.text) {
      const detail =
        labelInfo.detail && labelInfo.detail !== labelInfo.text ? labelInfo.detail : annotation;
      labelRequests.push({
        id: conn.id,
        connectionId: conn.id,
        anchor: labelAnchor,
        text: labelInfo.text,
        detail: detail !== labelInfo.text ? detail : undefined,
      });
    }
  }

  const { positions: labelPositions, crowded: crowdedLabels } = showWireLabels
    ? resolveLabelPositions(labelRequests, labelObstacles)
    : { positions: new Map<string, Point>(), crowded: new Set<string>() };

  return (
    <>
      {/* Layer 1: wires (clickable). */}
      {routes.map((route) => {
        const meta = routeMeta.get(route.connectionId);
        if (!meta) return null;
        const { conn, visual, annotation, fuseFault } = meta;
        const isSelected = conn.id === selectedConnectionId;
        const isHighlighted =
          highlightDeviceIds.includes(conn.sourceDevice) ||
          highlightDeviceIds.includes(conn.targetDevice);
        const opacity = isSelected || isHighlighted ? 1 : 0.92;
        const pairOffset = visual.kind === 'pair' ? 5 : 0;

        return (
          <g
            key={`wire-${conn.id}`}
            className={`connection-group ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''}`}
            opacity={opacity}
            onClick={(e: { stopPropagation(): void }) => {
              e.stopPropagation();
              setSelectedConnectionId(conn.id);
              setSelectedDeviceId(null);
            }}
          >
            {visual.kind === 'pair' ? (
              <>
                <WirePath path={route.path} color={visual.colors[0]!} width={visual.width} offset={-pairOffset} />
                <WirePath path={route.path} color={visual.colors[1]!} width={visual.width} offset={pairOffset} />
              </>
            ) : (
              <WirePath path={route.path} color={visual.colors[0]!} width={visual.width} />
            )}
            <title>
              {visual.label}: {conn.sourceDevice}.{conn.sourcePort} → {conn.targetDevice}.
              {conn.targetPort}
              {annotation ? ` · ${annotation}` : ''}
              {fuseFault ? ' — FUSE UNDERSIZED' : ''}
            </title>
          </g>
        );
      })}

      {/* Layer 2: markers. */}
      <g className="canvas-markers" pointerEvents="none">
        {routes.map((route) => {
          const meta = routeMeta.get(route.connectionId);
          if (!meta) return null;
          const { conn, fuseInfo, fuseRating, fuseFault } = meta;
          return (
            <g key={`marker-${conn.id}`}>
              {fuseInfo.show && (
                <FuseMarker
                  x={route.fusePoint.x}
                  y={route.fusePoint.y}
                  rating={fuseRating}
                  fault={fuseFault}
                />
              )}
              {ampacityConnectionIds.has(conn.id) && (
                <AmpacityHazardMarker x={route.fusePoint.x} y={route.fusePoint.y} />
              )}
            </g>
          );
        })}
      </g>

      {/* Layer 3: label backgrounds + text (above wires and markers). */}
      {showWireLabels && (
        <g className="canvas-labels" pointerEvents="none">
          {routes.map((route) => {
            const meta = routeMeta.get(route.connectionId);
            if (!meta) return null;
            const { conn, labelInfo, annotation, labelAnchor } = meta;
            if (!labelInfo.show || !labelInfo.text) return null;
            const labelPos = labelPositions.get(conn.id);
            if (!labelPos) return null;
            const displayDetail =
              labelInfo.detail && labelInfo.detail !== labelInfo.text
                ? labelInfo.detail
                : annotation && annotation !== labelInfo.text
                  ? annotation
                  : undefined;
            return (
              <g key={`label-${conn.id}`}>
                <WireLabel
                  x={labelPos.x}
                  y={labelPos.y}
                  text={labelInfo.text}
                  detail={displayDetail}
                  crowded={crowdedLabels.has(conn.id)}
                  anchor={labelAnchor}
                />
              </g>
            );
          })}
        </g>
      )}
    </>
  );
}

export function Canvas({ state }: CanvasProps) {
  const {
    model,
    registry,
    deviceTypes,
    errorDeviceIds,
    selectedDeviceId,
    setSelectedDeviceId,
    selectedConnectionId,
    setSelectedConnectionId,
    highlightDeviceIds,
    pendingPort,
    wireMessage,
    startWireFrom,
    tryConnect,
    cancelWire,
    handlePortClick,
    moveDevice,
  } = state;

  const canvasRef = useRef<HTMLElement>(null);
  const {
    onPointerDown: onPanPointerDown,
    onPointerMove: onPanPointerMove,
    onPointerUp: onPanPointerUp,
    consumeSuppressClick,
    hasActiveSession,
    spaceHeld,
    cursorClass: panCursorClass,
  } = usePanScroll({ canvasRef });
  const [dragLine, setDragLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null,
  );

  const estimatePortPosition = useCallback(
    (deviceId: string, portId: string): Point | undefined => {
      const device = model.devices.find((d) => d.id === deviceId);
      const type = deviceTypes.get(deviceId);
      const def = type ? registry.get(type) : undefined;
      if (!device || !def || !type) return undefined;
      const offsets = devicePortOffsets(type, canvasPorts(def).map((p) => p.id));
      const offset = offsets?.get(portId);
      if (!offset) return undefined;
      return {
        x: (device.position?.x ?? 0) + offset.x,
        y: (device.position?.y ?? 0) + offset.y,
      };
    },
    [deviceTypes, model.devices, registry],
  );

  const estimateDeviceBounds = useCallback(
    (deviceId: string): Rect | undefined => {
      const device = model.devices.find((d) => d.id === deviceId);
      const type = deviceTypes.get(deviceId);
      if (!device || !type) return undefined;
      const layout = deviceLayout(type);
      if (!layout) return undefined;
      return {
        x: device.position?.x ?? 0,
        y: device.position?.y ?? 0,
        width: layout.width,
        height: layout.height,
      };
    },
    [deviceTypes, model.devices],
  );

  const dragRef = useRef<{
    deviceId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const wireFromRef = useRef<{ deviceId: string; portId: string } | null>(null);
  const wireDragActiveRef = useRef(false);
  const wireDragStartRef = useRef<{ x: number; y: number } | null>(null);

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0),
      y: clientY - rect.top + (canvasRef.current?.scrollTop ?? 0),
    };
  }, []);

  const findPortAt = useCallback((clientX: number, clientY: number) => {
    const el = document.elementFromPoint(clientX, clientY);
    const portBtn = el?.closest<HTMLElement>('[data-device-id][data-port-id]');
    if (!portBtn?.dataset.deviceId || !portBtn.dataset.portId) return null;
    return { deviceId: portBtn.dataset.deviceId, portId: portBtn.dataset.portId };
  }, []);

  const finishWireDrag = useCallback(
    (clientX: number, clientY: number) => {
      const from = wireFromRef.current;
      if (!from || !wireDragActiveRef.current) return;

      const target = findPortAt(clientX, clientY);
      if (target && (target.deviceId !== from.deviceId || target.portId !== from.portId)) {
        tryConnect(from, target);
      } else if (!target) {
        cancelWire();
      }
    },
    [cancelWire, findPortAt, tryConnect],
  );

  const onDevicePointerDown = useCallback(
    (deviceId: string, e: PointerEvent) => {
      // Space or middle-mouse pan takes priority over device drag.
      if (spaceHeld || e.button === 1) return;
      const device = model.devices.find((d: DeviceInstance) => d.id === deviceId);
      if (!device) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        deviceId,
        startX: e.clientX,
        startY: e.clientY,
        origX: device.position?.x ?? 0,
        origY: device.position?.y ?? 0,
      };
      setSelectedDeviceId(deviceId);
      setSelectedConnectionId(null);
    },
    [model.devices, setSelectedConnectionId, setSelectedDeviceId, spaceHeld],
  );

  const onPortPointerDown = useCallback(
    (deviceId: string, portId: string, e: PointerEvent) => {
      e.stopPropagation();
      if (isPortAtCapacity(model.connections, registry, deviceTypes, deviceId, portId)) return;
      const pt = canvasPoint(e.clientX, e.clientY);
      wireFromRef.current = { deviceId, portId };
      wireDragActiveRef.current = false;
      wireDragStartRef.current = { x: e.clientX, y: e.clientY };
      setDragLine({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    },
    [canvasPoint, deviceTypes, model.connections, registry],
  );

  const onPortClick = useCallback(
    (deviceId: string, portId: string, e: { stopPropagation(): void }) => {
      e.stopPropagation();
      if (wireDragActiveRef.current) return;
      if (isPortAtCapacity(model.connections, registry, deviceTypes, deviceId, portId)) return;
      handlePortClick(deviceId, portId);
    },
    [deviceTypes, handlePortClick, model.connections, registry],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (onPanPointerMove(e)) return;

      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        moveDevice(dragRef.current.deviceId, {
          x: Math.max(0, dragRef.current.origX + dx),
          y: Math.max(0, dragRef.current.origY + dy),
        });
        return;
      }

      if (wireFromRef.current && dragLine && wireDragStartRef.current) {
        const dx = e.clientX - wireDragStartRef.current.x;
        const dy = e.clientY - wireDragStartRef.current.y;
        if (
          !wireDragActiveRef.current &&
          dx * dx + dy * dy > WIRE_DRAG_THRESHOLD_PX * WIRE_DRAG_THRESHOLD_PX
        ) {
          wireDragActiveRef.current = true;
          startWireFrom(wireFromRef.current.deviceId, wireFromRef.current.portId);
        }
        const pt = canvasPoint(e.clientX, e.clientY);
        setDragLine((line) => (line ? { ...line, x2: pt.x, y2: pt.y } : null));
      }
    },
    [canvasPoint, dragLine, moveDevice, onPanPointerMove, startWireFrom],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (onPanPointerUp(e)) return;

      dragRef.current = null;

      if (wireFromRef.current) {
        if (wireDragActiveRef.current) {
          finishWireDrag(e.clientX, e.clientY);
        }
        wireFromRef.current = null;
        wireDragActiveRef.current = false;
        wireDragStartRef.current = null;
        setDragLine(null);
        return;
      }

      if (pendingPort) {
        setDragLine(null);
      }
    },
    [finishWireDrag, onPanPointerUp, pendingPort],
  );

  const onCanvasPointerLeave = useCallback(
    (e: PointerEvent) => {
      // With pointer capture, pan continues outside the canvas; do not abort it.
      if (hasActiveSession()) return;
      onPointerUp(e);
    },
    [hasActiveSession, onPointerUp],
  );

  const onCanvasClick = useCallback(() => {
    if (consumeSuppressClick()) return;
    setSelectedDeviceId(null);
    setSelectedConnectionId(null);
    cancelWire();
    setDragLine(null);
    wireFromRef.current = null;
    wireDragActiveRef.current = false;
  }, [cancelWire, consumeSuppressClick, setSelectedConnectionId, setSelectedDeviceId]);

  const pendingPortType = pendingPort
    ? registry.get(deviceTypes.get(pendingPort.deviceId) ?? '')?.ports.find(
        (p) => p.id === pendingPort.portId,
      )?.type
    : wireFromRef.current
      ? registry
          .get(deviceTypes.get(wireFromRef.current.deviceId) ?? '')
          ?.ports.find((p) => p.id === wireFromRef.current!.portId)?.type
      : undefined;

  const isWiring = pendingPort !== null || dragLine !== null;

  return (
    <main
      ref={canvasRef}
      id="circuit-canvas"
      className={`canvas ${isWiring ? 'canvas-wiring' : ''} ${panCursorClass} ${spaceHeld ? 'canvas-space-pan' : ''}`}
      onPointerDown={onPanPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onCanvasPointerLeave}
      onClick={onCanvasClick}
      onAuxClick={(e: { preventDefault(): void; button: number }) => {
        // Suppress middle-click default behaviors after a pan.
        if (e.button === 1) e.preventDefault();
      }}
    >
      {model.devices.map((device: DeviceInstance) => {
        const def = registry.get(device.type);
        const x = device.position?.x ?? 0;
        const y = device.position?.y ?? 0;
        const isSelected = device.id === selectedDeviceId;
        const isHighlighted = highlightDeviceIds.includes(device.id);
        const hasError = errorDeviceIds.has(device.id);
        const layout = deviceLayout(device.type);
        const image = deviceImage(device.type);
        const ports = def ? canvasPorts(def) : [];
        const portOffsets = devicePortOffsets(
          device.type,
          ports.map((p) => p.id),
        );

        return (
          <div
            key={device.id}
            className={`device-node ${isSelected ? 'selected' : ''} ${isHighlighted ? 'highlighted' : ''} ${hasError ? 'device-error' : ''}`}
            style={{ left: x, top: y, width: layout?.width ?? DEVICE_W }}
            onClick={(e: { stopPropagation(): void }) => e.stopPropagation()}
          >
            <div
              className="device-body"
              style={{ height: layout?.height }}
              onPointerDown={(e: PointerEvent) => onDevicePointerDown(device.id, e)}
            >
              {image && <img className="device-art" src={image} alt="" draggable={false} />}
              {ports.map((port) => {
                const offset = portOffsets?.get(port.id);
                if (!offset) return null;
                const connected = isPortConnected(device.id, port.id, model.connections);
                const portFull = isPortAtCapacity(
                  model.connections,
                  registry,
                  deviceTypes,
                  device.id,
                  port.id,
                );
                const isPending =
                  pendingPort?.deviceId === device.id && pendingPort?.portId === port.id;
                const compatible =
                  pendingPort &&
                  !isPending &&
                  !portFull &&
                  isCompatibleTarget(registry, deviceTypes, model.connections, pendingPort, {
                    deviceId: device.id,
                    portId: port.id,
                  });
                return (
                  <button
                    key={port.id}
                    type="button"
                    data-device-id={device.id}
                    data-port-id={port.id}
                    className={`port-dot ${isPending ? 'pending' : ''} ${connected ? 'connected' : 'disconnected'} ${compatible ? 'compatible' : ''} ${portFull ? 'port-full' : ''}`}
                    style={{
                      left: offset.x,
                      top: offset.y,
                      background: portTypeColor(port.type),
                    }}
                    title={`${portDisplayLabel(port.id, device.type)} (${PORT_TYPE_NAMES[port.type]})${portFull ? ' — full' : ''}`}
                    disabled={portFull && !connected}
                    onPointerDown={(e: PointerEvent) => onPortPointerDown(device.id, port.id, e)}
                    onClick={(e: { stopPropagation(): void }) => onPortClick(device.id, port.id, e)}
                  />
                );
              })}
            </div>
            <div className="device-caption">{device.label ?? def?.displayName ?? device.type}</div>
          </div>
        );
      })}

      <svg className="canvas-svg canvas-wires" aria-hidden="true">
        <ConnectionLines
          state={state}
          getPortPosition={estimatePortPosition}
          getDeviceBounds={estimateDeviceBounds}
        />
      </svg>

      <svg className="canvas-svg canvas-draglayer" aria-hidden="true">
        {dragLine && (
          <line
            x1={dragLine.x1}
            y1={dragLine.y1}
            x2={dragLine.x2}
            y2={dragLine.y2}
            stroke={pendingPortType !== undefined ? portTypeColor(pendingPortType) : '#6b818c'}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="6 4"
          />
        )}
      </svg>

      {wireMessage && (
        <div
          className={`canvas-hint ${wireMessage.includes('Cannot') || wireMessage.includes('Incompatible') || wireMessage.includes('full') ? 'canvas-hint-error' : ''}`}
        >
          {wireMessage}
          {pendingPort && (
            <button type="button" className="btn btn-inline" onClick={() => cancelWire()}>
              Cancel
            </button>
          )}
        </div>
      )}
      {!wireMessage && pendingPort && (
        <div className="canvas-hint">
          Drag to a{' '}
          <strong>{pendingPortType !== undefined ? PORT_TYPE_NAMES[pendingPortType] : 'matching'}</strong>{' '}
          port (highlighted), or click another port to finish.
        </div>
      )}
      {selectedConnectionId && !pendingPort && (
        <div className="canvas-hint">
          Connection selected — edit label, color, and wire properties in the panel
        </div>
      )}
      {model.devices.length === 0 && (
        <div className="canvas-empty">
          Add devices from the palette or load the sample robot to get started.
        </div>
      )}
    </main>
  );
}
