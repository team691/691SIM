import type { RobotModel } from '@691sim/core';
import type { DeviceRegistry } from '@691sim/registry';
import {
  MATCH_DURATION_SECONDS,
  buildCircuitGraph,
  buildSwerveMatchProfile,
  simulateMatch,
  swerveDriveIds,
  swerveSteerIds,
  type MatchSimResult,
} from '@691sim/simulation';

export type MatchTimelineScenario = 'nominal' | 'peak' | 'swerve-example';

/**
 * Scenario supply-limit for the example swerve match profile.
 * This is a modeled load-shape input, not a datasheet rating.
 */
export const SWERVE_EXAMPLE_SUPPLY_LIMIT_AMPS = 40;

export const SCENARIO_LABELS: Record<MatchTimelineScenario, string> = {
  nominal: 'nominal (continuous draw)',
  peak: 'peak (worst-case draw)',
  'swerve-example': 'swerve-example (example load shape)',
};

/** True when the model contains every id from swerveDriveIds()/swerveSteerIds(). */
export function modelSupportsSwerveExample(model: RobotModel): boolean {
  const ids = new Set(model.devices.map((device) => device.id));
  return [...swerveDriveIds(), ...swerveSteerIds()].every((id) => ids.has(id));
}

export type MatchTimelineBuild =
  | {
      ok: true;
      scenario: MatchTimelineScenario;
      match: MatchSimResult;
      caption: string;
    }
  | {
      ok: false;
      scenario: 'swerve-example';
      reason: string;
    };

/** One sample per second so the Timeline scrubber can move across the match. */
export const FLAT_PROFILE_STEP_SECONDS = 1;

/** Flat load profile: same empty overrides at each scrubber step (device draw from mode). */
export function buildFlatMatchProfile(
  stepSeconds: number = FLAT_PROFILE_STEP_SECONDS,
): { t: number; loadsByDeviceId: Record<string, number> }[] {
  const step = stepSeconds > 0 ? stepSeconds : 1;
  const profile: { t: number; loadsByDeviceId: Record<string, number> }[] = [];
  for (let t = 0; t <= MATCH_DURATION_SECONDS; t += step) {
    profile.push({ t, loadsByDeviceId: {} });
  }
  if (profile[profile.length - 1]?.t !== MATCH_DURATION_SECONDS) {
    profile.push({ t: MATCH_DURATION_SECONDS, loadsByDeviceId: {} });
  }
  return profile;
}

/**
 * Run a match-profile simulation for the Timeline tab.
 *
 * nominal / peak: flat profiles sampled every second so the scrubber can move;
 * empty overrides mean each device keeps its component draw for that mode.
 * swerve-example: buildSwerveMatchProfile, only when the model has the expected
 * swerve device ids (UI may hide this scenario until later).
 */
export function buildMatchTimeline(
  model: RobotModel,
  registry: DeviceRegistry,
  scenario: MatchTimelineScenario,
): MatchTimelineBuild {
  if (scenario === 'swerve-example' && !modelSupportsSwerveExample(model)) {
    return {
      ok: false,
      scenario: 'swerve-example',
      reason:
        'Swerve example needs the standard swerve drive/steer device ids (swerve-fl-drive, …). Load a swerve sample or rename devices to match.',
    };
  }

  const { components, powerEdges } = buildCircuitGraph(model, registry);

  if (scenario === 'swerve-example') {
    const profile = buildSwerveMatchProfile({
      supplyLimitAmps: SWERVE_EXAMPLE_SUPPLY_LIMIT_AMPS,
    });
    const match = simulateMatch(profile, components, powerEdges, 'continuous');
    return {
      ok: true,
      scenario,
      match,
      caption:
        'Scenario: swerve-example. This is a modeled load profile (example acceleration / steady / reverse shape), not measured data.',
    };
  }

  const mode = scenario === 'peak' ? 'peak' : 'continuous';
  const match = simulateMatch(buildFlatMatchProfile(), components, powerEdges, mode);
  return {
    ok: true,
    scenario,
    match,
    caption: `Scenario: ${SCENARIO_LABELS[scenario]}. This is a modeled load profile, not measured data.`,
  };
}
