import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  BROWNOUT_VOLTAGE_THRESHOLD,
  MATCH_DURATION_SECONDS,
  buildCircuitGraph,
  minVoltageForType,
  type MatchVoltageSample,
} from '@691sim/simulation';
import type { RobotModelState } from '../hooks/useRobotModel';
import { useMatchTimeline } from '../hooks/useMatchTimeline';
import {
  SCENARIO_LABELS,
  type MatchTimelineBuild,
  type MatchTimelineScenario,
} from '../utils/matchTimeline';
import {
  pathVoltageCloses,
  tracePowerPath,
  type PowerPathResult,
} from '../utils/tracePowerPath';

interface TimelinePanelProps {
  state: RobotModelState;
}

type PathAnalysis =
  | { kind: 'no-battery' }
  | { kind: 'no-target' }
  | {
      kind: 'ok';
      batteryId: string;
      targetId: string;
      targetVoltage: number | null;
      targetMin: number | null;
      path: PowerPathResult;
      sample: MatchVoltageSample;
      closes: boolean | null;
    };

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

function defaultSampleIndex(samples: MatchVoltageSample[], firstBrownoutT: number | null): number {
  if (samples.length === 0) return 0;
  if (firstBrownoutT !== null) {
    const idx = samples.findIndex((s) => s.t === firstBrownoutT);
    if (idx >= 0) return idx;
  }
  let best = 0;
  let bestV = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    if (sample.roborioVoltage === null) return;
    if (sample.roborioVoltage < bestV) {
      bestV = sample.roborioVoltage;
      best = index;
    }
  });
  return best;
}

export function TimelinePanel({ state }: TimelinePanelProps) {
  const { model, registry, setPowerPathHighlight, clearPowerPathHighlight } = state;
  const { scenario, setScenario, swerveAvailable, timeline } = useMatchTimeline(model, registry);
  const [sampleIndex, setSampleIndex] = useState(0);

  const scenarios: MatchTimelineScenario[] = ['nominal', 'peak', 'swerve-example'];

  useEffect(() => {
    if (!timeline.ok) {
      clearPowerPathHighlight();
      return;
    }
    setSampleIndex(defaultSampleIndex(timeline.match.samples, timeline.match.firstBrownout?.t ?? null));
  }, [timeline, clearPowerPathHighlight]);

  const selectedSample =
    timeline.ok && timeline.match.samples.length > 0
      ? timeline.match.samples[
          Math.min(sampleIndex, timeline.match.samples.length - 1)
        ]!
      : null;

  const pathAnalysis = useMemo((): PathAnalysis | null => {
    if (!timeline.ok || !selectedSample) return null;
    const battery = model.devices.find((d) => d.type === 'Battery');
    if (!battery) {
      return { kind: 'no-battery' };
    }
    const fail = selectedSample.undervoltage[0];
    const rio = model.devices.find((d) => d.type === 'RoboRIO');
    const targetId = fail?.deviceId ?? rio?.id;
    if (!targetId) {
      return { kind: 'no-target' };
    }
    const { powerEdges } = buildCircuitGraph(model, registry);
    const path = tracePowerPath(
      powerEdges,
      selectedSample.wireCurrents,
      battery.id,
      targetId,
    );
    const targetVoltage =
      selectedSample.deviceVoltages.find((row) => row.deviceId === targetId)?.voltage ?? null;
    const targetType = model.devices.find((d) => d.id === targetId)?.type ?? '';
    const targetMin = minVoltageForType(targetType);
    return {
      kind: 'ok',
      batteryId: battery.id,
      targetId,
      targetVoltage,
      targetMin,
      path,
      sample: selectedSample,
      closes:
        path.found && targetVoltage !== null
          ? pathVoltageCloses(
              selectedSample.batteryVoltage,
              selectedSample.internalVoltageDrop,
              path.hops,
              targetVoltage,
              0.05,
            )
          : null,
    };
  }, [timeline, selectedSample, model, registry]);

  useEffect(() => {
    if (!pathAnalysis || pathAnalysis.kind !== 'ok' || !pathAnalysis.path.found) {
      clearPowerPathHighlight();
      return;
    }
    const drops: Record<string, number> = {};
    for (const hop of pathAnalysis.path.hops) {
      drops[hop.connectionId] = hop.voltageDrop;
    }
    setPowerPathHighlight(
      pathAnalysis.path.hops.map((hop) => hop.connectionId),
      drops,
    );
  }, [pathAnalysis, setPowerPathHighlight, clearPowerPathHighlight]);

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
        <>
          <TimelineChart
            build={timeline}
            selectedIndex={Math.min(sampleIndex, timeline.match.samples.length - 1)}
            onSelectIndex={setSampleIndex}
          />
          <PathBreakdown analysis={pathAnalysis} />
        </>
      )}
    </div>
  );
}

function TimelineChart({
  build,
  selectedIndex,
  onSelectIndex,
}: {
  build: Extract<MatchTimelineBuild, { ok: true }>;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}) {
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
  const selected = samples[selectedIndex];

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

        {selected && (
          <line
            x1={chartX(selected.t)}
            y1={PAD.top}
            x2={chartX(selected.t)}
            y2={CHART_HEIGHT - PAD.bottom}
            className="timeline-scrubber"
          />
        )}

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

      {samples.length > 0 && (
        <label className="timeline-scrubber-control">
          <span>
            Sample t = {selected?.t ?? 0} s
            {selected?.roborioVoltage != null
              ? ` · roboRIO ${selected.roborioVoltage.toFixed(2)} V`
              : ''}
            {` · ${selected?.totalCurrentAmps.toFixed(1) ?? 0} A`}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0, samples.length - 1)}
            step={1}
            value={Math.min(selectedIndex, samples.length - 1)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              onSelectIndex(Number(e.target.value))
            }
          />
        </label>
      )}

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

function PathBreakdown({ analysis }: { analysis: PathAnalysis | null }) {
  if (!analysis) return null;
  if (analysis.kind === 'no-battery') {
    return <div className="muted-line">No battery in the model — cannot trace a power path.</div>;
  }
  if (analysis.kind === 'no-target') {
    return (
      <div className="muted-line">
        No failing device and no RoboRIO — nothing to trace a path to.
      </div>
    );
  }

  const { path, sample, targetId, targetVoltage, targetMin, closes } = analysis;
  if (!path.found) {
    return (
      <div className="field">
        <label>Brownout path</label>
        <div className="empty-state">No power path from the battery to {targetId}.</div>
      </div>
    );
  }

  const wireDropSum = path.hops.reduce((sum, hop) => sum + hop.voltageDrop, 0);
  const predicted = sample.batteryVoltage - sample.internalVoltageDrop - wireDropSum;

  return (
    <div className="field">
      <label>Brownout path → {targetId}</label>
      {path.usedShortestOfMultiple && (
        <p className="muted-line">
          Multiple power paths exist (loop or parallel feed). Showing the shortest hop count.
        </p>
      )}
      <ol className="info-list timeline-path-list">
        <li>
          Battery open-circuit voltage: <strong>{sample.batteryVoltage.toFixed(3)} V</strong>
        </li>
        <li>Internal resistance drop: −{sample.internalVoltageDrop.toFixed(3)} V</li>
        {path.hops.map((hop) => (
          <li key={hop.connectionId}>
            {hop.connectionId}: {hop.from} → {hop.to} · {hop.gauge} AWG · {hop.lengthInches}&quot; ·{' '}
            {hop.currentAmps.toFixed(2)} A · −{hop.voltageDrop.toFixed(3)} V
          </li>
        ))}
        <li>
          Voltage at {targetId}:{' '}
          <strong>{targetVoltage === null ? '—' : `${targetVoltage.toFixed(3)} V`}</strong>
          {targetMin !== null ? ` (minimum ${targetMin.toFixed(2)} V)` : ' (no known minimum)'}
        </li>
      </ol>
      <p className="muted-line">
        Solved check: {sample.batteryVoltage.toFixed(3)} − {sample.internalVoltageDrop.toFixed(3)} −{' '}
        {wireDropSum.toFixed(3)} = {predicted.toFixed(3)} V
        {closes === false
          ? ' (differs from target — non-wire series elements such as breaker contact resistance are outside wireCurrents)'
          : closes === true
            ? ' (matches target within rounding)'
            : ''}
        . Values are from the solve, not measured.
      </p>
      <p className="muted-line">
        Path connections are highlighted on the Editor canvas when you switch tabs.
      </p>
    </div>
  );
}
