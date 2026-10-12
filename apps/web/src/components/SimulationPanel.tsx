import { PortType } from '@691sim/core';
import { minVoltageForType } from '@691sim/simulation';
import type { RobotModelState } from '../hooks/useRobotModel';
import { getFuseRatingAmps, getPdhFuseInfo } from '../utils/fuses';
import { resolveConnectionPortType } from '../utils/wireStyles';

interface SimulationPanelProps {
  state: RobotModelState;
}

function voltageClass(voltage: number, threshold: number): string {
  if (voltage < threshold) return 'sim-voltage-danger';
  if (voltage < threshold + 2) return 'sim-voltage-warn';
  return 'sim-voltage-ok';
}

export function SimulationPanel({ state }: SimulationPanelProps) {
  const { simulation, simulationMode, setSimulationMode, fuseViolationConnectionIds, model, deviceTypes, registry } = state;

  if (!simulation) {
    return (
      <div className="panel-content">
        <div className="empty-state">Unable to simulate the current model.</div>
      </div>
    );
  }

  const { voltage, can, ampacityViolations, diagnostics } = simulation;
  const breakerOpen = diagnostics.filter((d) => d.code === 'BREAKER_OPEN');

  return (
    <div className="panel-content sim-panel">
      <div className="sim-mode-toggle">
        <span>Load model:</span>
        <button
          type="button"
          className={`btn ${simulationMode === 'continuous' ? 'btn-primary' : ''}`}
          onClick={() => setSimulationMode('continuous')}
        >
          Continuous
        </button>
        <button
          type="button"
          className={`btn ${simulationMode === 'peak' ? 'btn-primary' : ''}`}
          onClick={() => setSimulationMode('peak')}
        >
          Peak
        </button>
      </div>

      {voltage.brownoutRisk && (
        <div className="sim-alert sim-alert-danger">⚠ ROBORIO BROWNOUT RISK DETECTED</div>
      )}

      {voltage.firstFailure && (
        <div className="sim-alert sim-alert-danger">
          {voltage.firstFailure.deviceId} fails first at {voltage.firstFailure.voltage.toFixed(2)} V, below its{' '}
          {voltage.firstFailure.minVoltage} V minimum.
        </div>
      )}

      {breakerOpen.length > 0 && (
        <div className="sim-alert sim-alert-danger">
          Breaker is stopping current flow on {breakerOpen.map((d) => d.deviceIds?.[0]).filter(Boolean).join(', ')}.
        </div>
      )}

      <div className="sim-metrics">
        <div className="sim-metric">
          <span className="sim-metric-label">System Voltage</span>
          <span
            className={`sim-metric-value ${voltageClass(voltage.systemVoltage, voltage.brownoutThreshold)}`}
          >
            {voltage.systemVoltage.toFixed(2)} V
          </span>
        </div>
        <div className="sim-metric">
          <span className="sim-metric-label">Total Current ({simulationMode})</span>
          <span className="sim-metric-value">{voltage.totalCurrentAmps.toFixed(1)} A</span>
        </div>
        <div className="sim-metric">
          <span className="sim-metric-label">Battery</span>
          <span className="sim-metric-value">{voltage.batteryVoltage.toFixed(1)} V</span>
        </div>
      </div>

      <div className="field">
        <label>Voltage Breakdown (Ohm&apos;s Law)</label>
        <ul className="info-list">
          <li>V_battery: {voltage.batteryVoltage.toFixed(2)} V</li>
          <li>
            Internal drop (I·R_int): −{voltage.internalVoltageDrop.toFixed(2)} V
            <small>R_internal = {voltage.internalResistanceOhms} Ω</small>
          </li>
          <li>
            Drop to lowest device: −{voltage.wireVoltageDropTotal.toFixed(2)} V
            <small>Shared path plus that device&apos;s own wires. Other branches are not added in.</small>
          </li>
          <li>
            <strong>V_system = {voltage.systemVoltage.toFixed(2)} V</strong>
            <small>Brownout threshold {voltage.brownoutThreshold} V</small>
          </li>
        </ul>
      </div>

      <div className="field">
        <label>Device Voltages</label>
        {voltage.deviceVoltages.length === 0 ? (
          <div className="muted-line">No devices to solve.</div>
        ) : (
          <table className="sim-wire-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Voltage</th>
                <th>Minimum</th>
              </tr>
            </thead>
            <tbody>
              {voltage.deviceVoltages.map((row) => {
                const placed = model.devices.find((device) => device.id === row.deviceId);
                const name = placed?.label || row.deviceId;
                const typeName = deviceTypes.get(row.deviceId) ?? placed?.type;
                const metadataMin = placed?.metadata?.minVoltage;
                const minimum =
                  typeof metadataMin === 'number'
                    ? metadataMin
                    : typeName
                      ? minVoltageForType(typeName)
                      : null;
                const failure = voltage.undervoltage.find((device) => device.deviceId === row.deviceId);
                const failsFirst = voltage.firstFailure?.deviceId === row.deviceId;
                return (
                  <tr key={row.deviceId} className={failure ? 'sim-wire-hazard' : ''}>
                    <td>
                      {name}
                      {placed?.label ? <small style={{ display: 'block' }}>{row.deviceId}</small> : null}
                      {failsFirst ? ' · fails first' : ''}
                    </td>
                    <td>{row.voltage === null ? '—' : `${row.voltage.toFixed(2)} V`}</td>
                    <td>{minimum === null ? '—' : `${minimum.toFixed(1)} V`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {voltage.issues.length > 0 &&
          voltage.issues.map((issue) => (
            <div key={issue.code + issue.deviceIds.join(',')} className="muted-line" style={{ color: 'var(--danger)' }}>
              {issue.message}
            </div>
          ))}
      </div>

      <div className="field">
        <label>CAN Bus Topology</label>
        {!can.hasCanBus ? (
          <div className="muted-line">No CAN devices wired.</div>
        ) : (
          <>
            <div style={{ marginBottom: '0.4rem' }}>
              <span className={`badge ${can.isValidChain ? 'badge-ok' : 'badge-error'}`}>
                {can.isValidChain ? 'Valid daisy chain' : 'Invalid topology'}
              </span>{' '}
              <span className={`badge ${can.terminationOk ? 'badge-ok' : 'badge-warning'}`}>
                {can.terminationOk ? '120Ω termination OK' : 'Termination issue'}
              </span>
            </div>
            {can.buses.length > 0 && (
              <ul className="info-list">
                {can.buses.map((bus) => (
                  <li key={bus.id}>
                    {bus.kind === 'canivore' ? 'CANivore' : 'roboRIO'} bus
                    {bus.valid ? '' : ' (invalid)'}: {bus.deviceIds.join(', ')}
                  </li>
                ))}
              </ul>
            )}
            {can.issues.map((issue, i) => (
              <div key={i} className="muted-line" style={{ color: 'var(--danger)' }}>
                {issue.message}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="field">
        <label>
          Wire Ampacity{' '}
          {ampacityViolations.length > 0 && (
            <span className="badge badge-error">{ampacityViolations.length} hazard(s)</span>
          )}
        </label>
        {voltage.wireCurrents.length === 0 ? (
          <div className="muted-line">No power wires to analyze.</div>
        ) : (
          <table className="sim-wire-table">
            <thead>
              <tr>
                <th>Wire</th>
                <th>AWG</th>
                <th>Current</th>
                <th>Max</th>
                <th>Drop</th>
              </tr>
            </thead>
            <tbody>
              {voltage.wireCurrents.map((wire) => (
                <tr key={wire.connectionId} className={wire.exceedsAmpacity ? 'sim-wire-hazard' : ''}>
                  <td>
                    {wire.from} → {wire.to}
                  </td>
                  <td>{wire.gauge}</td>
                  <td>{wire.currentAmps.toFixed(1)} A</td>
                  <td>{wire.maxAmps} A</td>
                  <td>{wire.voltageDrop.toFixed(3)} V</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ampacityViolations.length > 0 && (
          <div className="sim-alert sim-alert-danger" style={{ marginTop: '0.5rem' }}>
            Exceeds Ampacity: Safety Hazard!
          </div>
        )}
      </div>

      <div className="field">
        <label>
          PDH Fuse Ratings{' '}
          {fuseViolationConnectionIds.size > 0 && (
            <span className="badge badge-error">{fuseViolationConnectionIds.size} blown</span>
          )}
        </label>
        {fuseViolationConnectionIds.size === 0 ? (
          <div className="muted-line">All PDH branch fuses are sized correctly.</div>
        ) : (
          <ul className="info-list">
            {[...fuseViolationConnectionIds].map((connectionId) => {
              const conn = model.connections.find((c) => c.id === connectionId);
              const wire = voltage.wireCurrents.find((w) => w.connectionId === connectionId);
              if (!conn || !wire) return null;
              const srcType = deviceTypes.get(conn.sourceDevice) ?? '';
              const portType =
                resolveConnectionPortType(registry, conn.sourceDevice, srcType, conn.sourcePort) ??
                PortType.POWER;
              const fuseInfo = getPdhFuseInfo(
                portType,
                srcType,
                conn.sourcePort,
                deviceTypes.get(conn.targetDevice) ?? '',
                conn.targetPort,
              );
              const fuseAmps = getFuseRatingAmps(conn, fuseInfo.port);
              return (
                <li key={connectionId} className="sim-wire-hazard">
                  {conn.sourceDevice}.{conn.sourcePort} → {conn.targetDevice}.{conn.targetPort}:{' '}
                  {wire.currentAmps.toFixed(1)} A exceeds {fuseAmps} A fuse
                </li>
              );
            })}
          </ul>
        )}
        {fuseViolationConnectionIds.size > 0 && (
          <div className="sim-alert sim-alert-danger" style={{ marginTop: '0.5rem' }}>
            Fuse too small — increase the fuse rating in the Properties panel or reduce branch load.
          </div>
        )}
      </div>
    </div>
  );
}
