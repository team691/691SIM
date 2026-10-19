/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from 'react';
import type { RobotModelState } from '../hooks/useRobotModel';
import { estimateRobotModel } from '@691sim/estimator';

interface GraphPanelProps {
  state: RobotModelState;
}

export function GraphPanel({ state }: GraphPanelProps) {
  const { graph, model, registry } = state;

  const estimation = useMemo(() => {
    if (!graph) return null;
    try {
      return estimateRobotModel(model, { registry, graph });
    } catch {
      return null;
    }
  }, [graph, model, registry]);

  if (!graph) {
    return (
      <div className="panel-content">
        <div className="empty-state">Unable to build graph from current model.</div>
      </div>
    );
  }

  const powerSources = graph.powerSources().map((d: any) => d.id);
  const canReachable = model.devices
    .filter((d: any) => graph.canReachable(d.id))
    .map((d: any) => d.id);
  const networkReachable = model.devices
    .filter((d: any) => graph.networkReachable(d.id))
    .map((d: any) => d.id);
  const components = graph.connectedComponents().map((c: any) => c.map((d: any) => d.id));

  return (
    <div className="panel-content" style={{ fontSize: '0.82rem' }}>
      <div className="field">
        <label>Graph Summary</label>
        <ul className="info-list">
          <li>{graph.devices.length} device nodes</li>
          <li>{graph.ports.length} port nodes</li>
          <li>{graph.edges.length} connection edges</li>
        </ul>
      </div>

      {estimation && (
        <>
          <div className="field">
            <label>Power Estimation</label>
            <ul className="info-list">
              <li>Nominal current: {estimation.nominalCurrentAmps.toFixed(1)} A</li>
              <li>Peak current: {estimation.peakCurrentAmps.toFixed(1)} A</li>
              <li className="muted-line">
                For bus voltage and brownout risk, use the Simulation tab (nodal solver).
              </li>
            </ul>
          </div>

          <div className="field">
            <label>CAN Estimation</label>
            <ul className="info-list">
              <li>{estimation.canDeviceCount} CAN devices</li>
              <li>Utilization: {estimation.canUtilizationPercent.toFixed(1)}%</li>
            </ul>
          </div>

          <div className="field">
            <label>Weight Estimation</label>
            <div>{estimation.totalWeightLbs.toFixed(1)} lbs (estimated)</div>
          </div>

          {estimation.diagnostics.length > 0 && (
            <div className="field">
              <label>Estimation Warnings</label>
              {estimation.diagnostics.map((d) => (
                <div key={d.id} style={{ marginBottom: '0.35rem', color: '#cbd5e1' }}>
                  {d.message}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="field">
        <label>Power Sources</label>
        <div>{powerSources.length ? powerSources.join(', ') : 'None'}</div>
      </div>

      <div className="field">
        <label>CAN Reachable Devices</label>
        <div>{canReachable.length ? canReachable.join(', ') : 'None'}</div>
      </div>

      <div className="field">
        <label>Network Reachable Devices</label>
        <div>{networkReachable.length ? networkReachable.join(', ') : 'None'}</div>
      </div>

      <div className="field">
        <label>Connected Components</label>
        {components.map((comp: any, i: any) => (
          <div key={i} className="muted-line">
            Component {i + 1}: {comp.join(', ')}
          </div>
        ))}
      </div>
    </div>
  );
}
