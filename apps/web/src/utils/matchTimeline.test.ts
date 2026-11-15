import { describe, expect, it } from 'vitest';
import { createHealthyRobotModel } from '@691sim/core';
import { createDefaultDeviceRegistry } from '@691sim/registry';
import { createSwerveRobotModel } from '@691sim/simulation';
import {
  buildMatchTimeline,
  modelSupportsSwerveExample,
} from './matchTimeline';

const registry = createDefaultDeviceRegistry();
const BREAKERS = { driveAmps: 40, steerAmps: 20, cancoderAmps: 10, pigeonAmps: 10 };

describe('buildMatchTimeline', () => {
  it('builds monotonic nominal and peak timelines on the healthy sample', () => {
    const model = createHealthyRobotModel();
    const nominal = buildMatchTimeline(model, registry, 'nominal');
    const peak = buildMatchTimeline(model, registry, 'peak');
    expect(nominal.ok).toBe(true);
    expect(peak.ok).toBe(true);
    if (!nominal.ok || !peak.ok) return;

    expect(nominal.match.samples.map((s) => s.t)).toEqual([0, 135]);
    expect(peak.match.samples.map((s) => s.t)).toEqual([0, 135]);
    const nominalMin = Math.min(...nominal.match.samples.map((s) => s.systemVoltage));
    const peakMin = Math.min(...peak.match.samples.map((s) => s.systemVoltage));
    expect(peakMin).toBeLessThanOrEqual(nominalMin);
    expect(nominal.match.samples[0]?.roborioVoltage).not.toBeNull();
    expect(peak.match.samples[0]?.wireCurrents.length).toBeGreaterThan(0);
  });

  it('runs swerve-example on createSwerveRobotModel', () => {
    const model = createSwerveRobotModel({ breakers: BREAKERS, rioBreakerAmps: 10 });
    expect(modelSupportsSwerveExample(model)).toBe(true);
    const built = buildMatchTimeline(model, registry, 'swerve-example');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.match.samples.length).toBeGreaterThanOrEqual(2);
    expect(built.match.samples[0]?.t).toBe(0);
    expect(built.match.samples.at(-1)?.t).toBe(135);
    expect(built.caption).toContain('example');
  });

  it('marks swerve-example unavailable without swerve device ids', () => {
    const model = createHealthyRobotModel();
    expect(modelSupportsSwerveExample(model)).toBe(false);
    const built = buildMatchTimeline(model, registry, 'swerve-example');
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toMatch(/swerve/i);
  });

  it('reports roborioVoltage null when the model has no RoboRIO', () => {
    const model = createHealthyRobotModel();
    model.devices = model.devices.filter((d) => d.type !== 'RoboRIO');
    model.connections = model.connections.filter(
      (c) => c.sourceDevice !== 'rio-1' && c.targetDevice !== 'rio-1',
    );
    const built = buildMatchTimeline(model, registry, 'peak');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.match.samples.every((s) => s.roborioVoltage === null)).toBe(true);
  });
});
