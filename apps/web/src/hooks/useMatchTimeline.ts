import { useMemo, useState } from 'react';
import type { RobotModel } from '@691sim/core';
import type { DeviceRegistry } from '@691sim/registry';
import {
  buildMatchTimeline,
  modelSupportsSwerveExample,
  type MatchTimelineBuild,
  type MatchTimelineScenario,
} from '../utils/matchTimeline';

export function useMatchTimeline(model: RobotModel, registry: DeviceRegistry) {
  const [scenario, setScenario] = useState<MatchTimelineScenario>('peak');

  const swerveAvailable = useMemo(() => modelSupportsSwerveExample(model), [model]);

  const timeline = useMemo((): MatchTimelineBuild | { ok: false; scenario: MatchTimelineScenario; reason: string } => {
    try {
      return buildMatchTimeline(model, registry, scenario);
    } catch (err) {
      return {
        ok: false,
        scenario,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }, [model, registry, scenario]);

  return {
    scenario,
    setScenario,
    swerveAvailable,
    timeline,
  };
}
