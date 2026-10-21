import { deviceImage } from '../utils/deviceImages';

interface DeviceIconProps {
  type: string;
  size?: number;
}

const palette: Record<string, { fill: string; accent: string; label: string }> = {
  Battery: { fill: '#1f2937', accent: '#ef4444', label: '12V' },
  MainBreaker: { fill: '#08415c', accent: '#f1bf98', label: 'BR' },
  PDP: { fill: '#374151', accent: '#f59e0b', label: 'PDP' },
  PDH: { fill: '#14532d', accent: '#4ade80', label: 'PDH' },
  VRM: { fill: '#334155', accent: '#fbbf24', label: 'VRM' },
  RoboRIO: { fill: '#475569', accent: '#38bdf8', label: 'RIO' },
  SystemCore: { fill: '#312e81', accent: '#818cf8', label: 'SC' },
  SparkMax: { fill: '#7f1d1d', accent: '#f87171', label: 'MAX' },
  SparkFlex: { fill: '#831843', accent: '#f472b6', label: 'FLX' },
  TalonFX: { fill: '#1e3a8a', accent: '#60a5fa', label: 'FX' },
  CANcoder: { fill: '#164e63', accent: '#22d3ee', label: 'ENC' },
  Pigeon2: { fill: '#365314', accent: '#a3e635', label: 'P2' },
  Limelight: { fill: '#111827', accent: '#06b6d4', label: 'LL' },
  USBCamera: { fill: '#1e293b', accent: '#94a3b8', label: 'CAM' },
  OrangePi: { fill: '#7c2d12', accent: '#fb923c', label: 'OPI' },
  RaspberryPi: { fill: '#14532d', accent: '#86efac', label: 'RPI' },
  Radio: { fill: '#0f172a', accent: '#3b82f6', label: 'RAD' },
  EthernetSwitch: { fill: '#1e293b', accent: '#64748b', label: 'SW' },
  CANivore: { fill: '#134e4a', accent: '#2dd4bf', label: 'CAN' },
};

export function DeviceIcon({ type, size = 56 }: DeviceIconProps) {
  const colors = palette[type] ?? { fill: '#1e293b', accent: '#94a3b8', label: '?' };
  const image = deviceImage(type);

  if (image) {
    return (
      <img
        className="device-photo"
        src={image}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }

  return (
    <svg
      className="device-icon"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="56" height="44" rx="8" fill={colors.fill} stroke={colors.accent} strokeWidth="2" />
      <rect x="10" y="16" width="44" height="18" rx="4" fill="#0b1120" opacity="0.55" />
      {type === 'MainBreaker' && (
        <>
          <rect x="22" y="28" width="20" height="8" rx="2" fill={colors.accent} />
          <line x1="32" y1="20" x2="32" y2="44" stroke={colors.accent} strokeWidth="2" />
        </>
      )}
      {type === 'Battery' && (
        <>
          <rect x="48" y="24" width="6" height="12" rx="2" fill={colors.accent} />
          <rect x="14" y="22" width="10" height="8" rx="2" fill="#ef4444" />
          <rect x="28" y="22" width="10" height="8" rx="2" fill="#111827" />
        </>
      )}
      {type === 'Radio' && (
        <>
          <line x1="32" y1="4" x2="32" y2="10" stroke={colors.accent} strokeWidth="2" />
          <circle cx="32" cy="4" r="2" fill={colors.accent} />
          <circle cx="22" cy="40" r="3" fill={colors.accent} />
          <circle cx="42" cy="40" r="3" fill={colors.accent} />
        </>
      )}
      {(type === 'SparkMax' || type === 'SparkFlex' || type === 'TalonFX') && (
        <>
          <circle cx="22" cy="42" r="5" fill="none" stroke={colors.accent} strokeWidth="2" />
          <circle cx="42" cy="42" r="5" fill="none" stroke={colors.accent} strokeWidth="2" />
        </>
      )}
      {type === 'Limelight' && (
        <circle cx="32" cy="25" r="8" fill="none" stroke={colors.accent} strokeWidth="2" />
      )}
      <text x="32" y="30" textAnchor="middle" fill={colors.accent} fontSize="11" fontWeight="700">
        {colors.label}
      </text>
    </svg>
  );
}
