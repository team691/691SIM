import { BROWNOUT_VOLTAGE_THRESHOLD, MATCH_DURATION_SECONDS } from '@691sim/simulation';
import type { RobotModelState } from '../hooks/useRobotModel';
import { useMatchTimeline } from '../hooks/useMatchTimeline';
import {
  SCENARIO_LABELS,
  type MatchTimelineBuild,
  type MatchTimelineScenario,
} from '../utils/matchTimeline';

interface TimelinePanelProps {
  state: RobotModelState;
}

const CHART_WIDTH = 720;
const CHART_HEIGHT = 280;
const PAD = { top: 28, right: 56, bottom: 40, left: 52 };

function chartX(t: number): number {
  const inner = CHART_WIDTH - PAD.left - PAD.right;
  return PAD.left + (t / MATCH_DURATION_SECONDS) * inner;
}

function chartYVoltage(v: number, vMin: number, vMax: number): number {
  const inner = CHART_HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(0.5, vMax - vMin);
  return PAD.top + ((vMax - v) / span) * inner;
}

function chartYCurrent(amps: number, iMax: number): number {
  const inner = CHART_HEIGHT - PAD.top - PAD.bottom;
  const span = Math.max(1, iMax);
  return PAD.top + ((span - amps) / span) * inner;
}

export function TimelinePanel({ state }: TimelinePanelProps) {
  const { model, registry } = state;
  const { scenario, setScenario, swerveAvailable, timeline } = useMatchTimeline(model, registry);

  const scenarios: MatchTimelineScenario[] = ['nominal', 'peak', 'swerve-example'];

  return (
    <div className="panel-content sim-panel timeline-panel">
      <div className="sim-mode-toggle">
        <span>Scenario:</span>
        {scenarios.map((id) => {
          const disabled = id === 'swerve-example' && !swerveAvailable;
          return (
            <button
              key={id}
              type="button"
              className={`btn ${scenario === id ? 'btn-primary' : ''}`}
              disabled={disabled}
              title={
                disabled
                  ? 'Needs standard swerve drive/steer device ids (swerve-fl-drive, …). Load a swerve sample or rename devices to match.'
                  : SCENARIO_LABELS[id]
              }
              onClick={() => setScenario(id)}
            >
              {id}
            </button>
          );
        })}
      </div>

      {!timeline.ok ? (
        <div className="empty-state">{timeline.reason}</div>
      ) : (
        <TimelineChart build={timeline} />
      )}
    </div>
  );
}

function TimelineChart({ build }: { build: Extract<MatchTimelineBuild, { ok: true }> }) {
  const { match, caption } = build;
  const samples = match.samples;
  const voltages = samples.map((s) => s.roborioVoltage).filter((v): v is number => v !== null);
  const currents = samples.map((s) => s.totalCurrentAmps);
  const hasRio = voltages.length > 0;

  const vMin = hasRio
    ? Math.min(BROWNOUT_VOLTAGE_THRESHOLD - 1, ...voltages) - 0.5
    : 0;
  const vMax = hasRio ? Math.max(BROWNOUT_VOLTAGE_THRESHOLD + 1, ...voltages) + 0.5 : 14;
  const iMax = Math.max(10, ...currents) * 1.1;

  const rioPoints = samples
    .filter((s) => s.roborioVoltage !== null)
    .map((s) => `${chartX(s.t)},${chartYVoltage(s.roborioVoltage!, vMin, vMax)}`)
    .join(' ');
  const currentPoints = samples
    .map((s) => `${chartX(s.t)},${chartYCurrent(s.totalCurrentAmps, iMax)}`)
    .join(' ');

  const firstFail = match.firstBrownout;
  const minRio = hasRio ? Math.min(...voltages) : null;
  const minRioSample = hasRio
    ? samples.find((s) => s.roborioVoltage === minRio) ?? samples[0]
    : null;
  const peakCurrent = Math.max(0, ...currents);

  const description = [
    hasRio
      ? `Minimum roboRIO voltage ${minRio!.toFixed(2)} V at t=${minRioSample?.t ?? 0} s.`
      : 'No powered RoboRIO in this model.',
    `Peak total current ${peakCurrent.toFixed(1)} A.`,
    firstFail
      ? `First device below its known minimum: ${firstFail.deviceId} at ${firstFail.voltage.toFixed(2)} V (t=${firstFail.t} s).`
      : 'No device with a known minimum fell below that minimum in this profile.',
  ].join(' ');

  const xTicks = [0, 15, 30, 60, 90, 120, 135];

  return (
    <>
      <p className="timeline-caption">{caption}</p>
      <p className="muted-line">Only devices with a known minimum voltage are checked.</p>
      <p className="muted-line">
        State of charge is not modeled: battery capacity and the Voc/R_int curve are not set.
      </p>

      <svg
        className="timeline-chart"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={description}
      >
        <title>{description}</title>
        <rect
          x={PAD.left}
          y={PAD.top}
          width={CHART_WIDTH - PAD.left - PAD.right}
          height={CHART_HEIGHT - PAD.top - PAD.bottom}
          className="timeline-plot-bg"
        />

        {xTicks.map((t) => (
          <g key={t}>
            <line
              x1={chartX(t)}
              y1={PAD.top}
              x2={chartX(t)}
              y2={CHART_HEIGHT - PAD.bottom}
              className="timeline-grid"
            />
            <text x={chartX(t)} y={CHART_HEIGHT - 12} textAnchor="middle" className="timeline-axis-label">
              {t}s
            </text>
          </g>
        ))}

        {hasRio && (
          <>
            <line
              x1={PAD.left}
              y1={chartYVoltage(BROWNOUT_VOLTAGE_THRESHOLD, vMin, vMax)}
              x2={CHART_WIDTH - PAD.right}
              y2={chartYVoltage(BROWNOUT_VOLTAGE_THRESHOLD, vMin, vMax)}
              className="timeline-threshold"
            />
            <text
              x={CHART_WIDTH - PAD.right + 4}
              y={chartYVoltage(BROWNOUT_VOLTAGE_THRESHOLD, vMin, vMax) + 4}
              className="timeline-threshold-label"
            >
              {BROWNOUT_VOLTAGE_THRESHOLD} V
            </text>
            <polyline points={rioPoints} className="timeline-rio-line" fill="none" />
          </>
        )}

        <polyline points={currentPoints} className="timeline-current-line" fill="none" />

        {firstFail && (
          <g>
            <circle
              cx={chartX(firstFail.t)}
              cy={
                samples.find((s) => s.t === firstFail.t)?.roborioVoltage != null
                  ? chartYVoltage(
                      samples.find((s) => s.t === firstFail.t)!.roborioVoltage!,
                      vMin,
                      vMax,
                    )
                  : chartYCurrent(
                      samples.find((s) => s.t === firstFail.t)?.totalCurrentAmps ?? 0,
                      iMax,
                    )
              }
              r={5}
              className="timeline-fail-marker"
            />
            <text
              x={chartX(firstFail.t)}
              y={PAD.top - 8}
              textAnchor="middle"
              className="timeline-fail-label"
            >
              {firstFail.deviceId} {firstFail.voltage.toFixed(2)} V
            </text>
          </g>
        )}

        <text x={12} y={PAD.top + 8} className="timeline-axis-label">
          V / A
        </text>
        <text x={CHART_WIDTH / 2} y={CHART_HEIGHT - 2} textAnchor="middle" className="timeline-axis-label">
          Match time (s)
        </text>
      </svg>

      <ul className="info-list timeline-legend">
        <li>
          <span className="timeline-swatch timeline-swatch-rio" /> RoboRIO voltage
        </li>
        <li>
          <span className="timeline-swatch timeline-swatch-current" /> Total current
        </li>
        <li>
          <span className="timeline-swatch timeline-swatch-threshold" /> Brownout threshold (
          {BROWNOUT_VOLTAGE_THRESHOLD} V)
        </li>
      </ul>

      {match.issues.length > 0 && (
        <div className="field">
          <label>Simulation issues</label>
          <ul className="info-list">
            {match.issues.map((issue) => (
              <li key={issue.code + issue.message} style={{ color: 'var(--danger)' }}>
                {issue.code}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
