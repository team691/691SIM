import portsData from '../../../../component-images/ports.json';

/**
 * Places each registry port at the physical terminal it corresponds to on the
 * component diagram, so wires attach to real solder points instead of to an
 * abstract grid of buttons.
 *
 * Terminal pixel coordinates come from component-images/ports.json, which is
 * generated alongside the PNGs -- regenerate both with
 * `python3 component-images/buildall.py`.
 */

interface ImagePort {
  side: string;
  x: number;
  y: number;
}

interface ImagePart {
  width: number;
  height: number;
  ports: Record<string, ImagePort>;
}

const PARTS = (portsData as unknown as { parts: Record<string, ImagePart> }).parts;

/**
 * Image folder + on-canvas width (px). Roughly proportional to real hardware
 * size, except the smallest parts are drawn up so their terminals stay
 * individually clickable.
 */
const DISPLAY: Record<string, { folder: string; width: number }> = {
  Battery: { folder: 'battery', width: 150 },
  MainBreaker: { folder: 'breaker120', width: 80 },
  PDP: { folder: 'pdp', width: 170 },
  PDH: { folder: 'pdh', width: 150 },
  VRM: { folder: 'vrm', width: 95 },
  RoboRIO: { folder: 'roborio', width: 185 },
  SystemCore: { folder: 'systemcore', width: 160 },
  SparkMax: { folder: 'sparkmax', width: 84 },
  SparkFlex: { folder: 'sparkflex', width: 88 },
  TalonFX: { folder: 'talonfx', width: 100 },
  CANcoder: { folder: 'cancoder', width: 80 },
  Pigeon2: { folder: 'pigeon2', width: 74 },
  Limelight: { folder: 'limelight', width: 84 },
  PhotonVision: { folder: 'photonvision', width: 80 },
  OrangePi: { folder: 'orangepi', width: 105 },
  Radio: { folder: 'radio', width: 115 },
  EthernetSwitch: { folder: 'ethswitch', width: 110 },
  CANivore: { folder: 'canivore', width: 120 },
};

/**
 * An app port maps either to a named terminal on the diagram, or -- when the
 * app models something the hardware has no dedicated terminal for -- to an
 * explicit normalized position (0..1 of the image box).
 */
type Alias = string | { nx: number; ny: number };

function channelAliases(count: number): Record<string, Alias> {
  const out: Record<string, Alias> = {};
  for (let i = 0; i < count; i++) out[`channel_${i}`] = `CH${i}+`;
  return out;
}

function vrmRailAliases(): Record<string, Alias> {
  const out: Record<string, Alias> = {};
  for (const rail of ['12V_2A', '12V_500mA', '5V_2A', '5V_500mA']) {
    for (let i = 0; i < 2; i++) {
      const appRail = rail.toLowerCase();
      out[`${appRail}_${i}`] = `${rail}_${i + 1}+`;
      out[`ground_${appRail}_${i}`] = `${rail}_${i + 1}-`;
    }
  }
  return out;
}

const ALIASES: Record<string, Record<string, Alias>> = {
  Battery: { main_power: 'BATT+', ground: 'BATT-' },
  MainBreaker: {
    power_in: 'STUD_BATT',
    power_out: 'STUD_LOAD',
    // The breaker only switches the positive leg; it has no ground studs, so
    // these sit on the body next to their matching power terminal.
    ground_in: { nx: 0.28, ny: 0.24 },
    ground_out: { nx: 0.72, ny: 0.78 },
  },
  PDP: {
    main_power_in: 'BATT+',
    ground_in: 'BATT-',
    ...channelAliases(16),
    ground_bus: 'CH0-',
    can_bus: 'CAN_H_IN',
  },
  PDH: {
    main_power_in: 'BATT+',
    ground_in: 'BATT-',
    ...channelAliases(24),
    ground_bus: 'CH0-',
    // The PDH has no dedicated VRM terminal (a VRM normally hangs off a
    // low-current channel), so this sits beside the low-current block rather
    // than stacking on top of one of those channels' levers.
    vrm_out: { nx: 0.4, ny: 0.8 },
    can_bus: 'CAN_H_IN',
    usb_c: 'USB-C',
  },
  VRM: { power_in: 'VIN+', ground: 'VIN-', ...vrmRailAliases() },
  RoboRIO: {
    power_in: 'V+',
    ground: 'V-',
    can_bus: 'CAN_H',
    eth_0: 'ETH',
    usb_b: 'USB_DEVICE',
    pwm_0: 'PWM0',
    dio_0: 'DIO0',
    i2c: 'I2C_SDA',
    spi: { nx: 0.85, ny: 0.11 },
  },
  SystemCore: { power_in: 'PWR+', ground: 'PWR-', can_bus: 'CAN_H', eth_0: 'ETH1' },
  SparkMax: {
    power_in: 'V+',
    ground: 'V-',
    motor_a: 'PHASE_A',
    motor_b: 'PHASE_B',
    motor_c: 'PHASE_C',
    can_bus: 'DATA',
    usb_c: { nx: 0.26, ny: 0.087 },
  },
  SparkFlex: {
    power_in: 'V+',
    ground: 'V-',
    motor_a: 'PHASE_A',
    motor_b: 'PHASE_B',
    motor_c: 'PHASE_C',
    can_bus: 'DATA',
    usb_c: { nx: 0.27, ny: 0.08 },
  },
  TalonFX: {
    power_in: 'PWR+',
    ground: 'PWR-',
    can_bus: 'CAN_H',
    // Phases are internal to the integrated motor -- no exposed terminals.
    motor_a: { nx: 0.34, ny: 0.13 },
    motor_b: { nx: 0.5, ny: 0.13 },
    motor_c: { nx: 0.66, ny: 0.13 },
  },
  CANcoder: { power_in: 'PWR+', ground: 'PWR-', can_bus: 'CAN_H' },
  Pigeon2: { power_in: 'PWR+', ground: 'PWR-', can_bus: 'CAN_H' },
  Limelight: { power_in: 'PWR+', ground: 'PWR-', eth_0: 'ETH' },
  PhotonVision: {
    // A USB camera is bus-powered -- power and data share the one connector.
    eth_0: 'USB',
    power_in: { nx: 0.3, ny: 0.83 },
    ground: { nx: 0.7, ny: 0.83 },
  },
  OrangePi: {
    power_in: 'USB_C_PWR',
    ground: { nx: 0.11, ny: 0.33 },
    eth_0: 'ETH',
    usb_a: 'USB3_1',
  },
  Radio: { power_in: 'PWR+', ground: 'PWR-', eth_poe: 'ETH1', eth_aux: 'ETH2' },
  EthernetSwitch: {
    power_in: 'PWR+',
    ground: 'PWR-',
    eth_0: 'ETH1',
    eth_1: 'ETH2',
    eth_2: 'ETH3',
    eth_3: 'ETH4',
    eth_4: 'ETH5',
  },
  CANivore: { power_in: 'V+', ground: 'V-', can_bus: 'CANH', usb: 'USB-C' },
};

export interface DeviceLayout {
  width: number;
  height: number;
  /** Port offsets in display px, relative to the device's top-left corner. */
  ports: Map<string, { x: number; y: number }>;
}

const cache = new Map<string, DeviceLayout | null>();

/** Resolved image box + terminal positions for a device type, or undefined if it has no diagram. */
export function deviceLayout(type: string): DeviceLayout | undefined {
  const cached = cache.get(type);
  if (cached !== undefined) return cached ?? undefined;

  const display = DISPLAY[type];
  const part = display ? PARTS[display.folder] : undefined;
  if (!display || !part) {
    cache.set(type, null);
    return undefined;
  }

  const scale = display.width / part.width;
  const layout: DeviceLayout = {
    width: display.width,
    height: Math.round(part.height * scale),
    ports: new Map(),
  };

  const aliases = ALIASES[type] ?? {};
  for (const [portId, alias] of Object.entries(aliases)) {
    if (typeof alias === 'string') {
      const terminal = part.ports[alias];
      if (terminal) {
        layout.ports.set(portId, { x: terminal.x * scale, y: terminal.y * scale });
      }
    } else {
      layout.ports.set(portId, { x: alias.nx * layout.width, y: alias.ny * layout.height });
    }
  }

  cache.set(type, layout);
  return layout;
}

/** Minimum center-to-center distance between terminal dots (dot is 9px wide). */
const MIN_DOT_SPACING = 11;

/**
 * Nudges dots apart until none are closer than MIN_DOT_SPACING. Small parts
 * have connector pins spaced tighter than a clickable dot, so without this two
 * terminals would stack and one would be unreachable. Moves are the minimum
 * needed, so dots stay on (or right beside) their real terminal.
 */
function separateDots(points: { x: number; y: number }[], width: number, height: number): void {
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= MIN_DOT_SPACING) continue;
        if (dist < 0.01) {
          dx = 1;
          dy = 0;
          dist = 1;
        }
        const push = (MIN_DOT_SPACING - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
        moved = true;
      }
    }
    for (const p of points) {
      p.x = Math.min(width, Math.max(0, p.x));
      p.y = Math.min(height, Math.max(0, p.y));
    }
    if (!moved) break;
  }
}

const offsetCache = new Map<string, Map<string, { x: number; y: number }>>();

/**
 * Where each of the given ports sits on a device, in display px from its
 * top-left corner, with dots guaranteed not to overlap. Ports with no mapping
 * fall back to a spread along the bottom edge so they stay visible and
 * connectable. Returns undefined for types with no diagram.
 */
export function devicePortOffsets(
  type: string,
  portIds: readonly string[],
): Map<string, { x: number; y: number }> | undefined {
  const layout = deviceLayout(type);
  if (!layout) return undefined;

  const key = `${type}|${portIds.join(',')}`;
  const cached = offsetCache.get(key);
  if (cached) return cached;

  const unmapped = portIds.filter((id) => !layout.ports.has(id));
  const span = layout.width / (unmapped.length + 1);
  const points = portIds.map((id) => {
    const mapped = layout.ports.get(id);
    if (mapped) return { ...mapped };
    return { x: span * (unmapped.indexOf(id) + 1), y: layout.height - 4 };
  });

  separateDots(points, layout.width, layout.height);

  const offsets = new Map(portIds.map((id, i) => [id, points[i]!]));
  offsetCache.set(key, offsets);
  return offsets;
}
