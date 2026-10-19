/**
 * Compare a measured match voltage log to simulateMatch predictions.
 *
 * Usage (preferred; no extra tooling):
 *   node scripts/match-log-compare.mjs <input.csv> <output.csv> [robot.json]
 *
 * This .ts file is the typed source. The repo does not ship `tsx`; run the
 * sibling `.mjs` after `pnpm -r --filter='./packages/*' run build`.
 *
 * CSV columns: t, batteryVoltage, and optional current_<deviceId> per device.
 * Without a robot.json argument, the built-in swerve sample robot is used.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RobotModel } from '@691sim/core';
import {
  buildCircuitGraph,
  compareMatchVoltages,
  createSwerveRobotModel,
  formatComparisonCsv,
  matchProfileFromLog,
  parseMatchLogCsv,
  simulateMatch,
} from '@691sim/simulation';

const DEFAULT_SWERVE_BREAKERS = {
  driveAmps: 40,
  steerAmps: 20,
  cancoderAmps: 10,
  pigeonAmps: 10,
};

function loadRobot(path: string | undefined): RobotModel {
  if (!path) {
    return createSwerveRobotModel({
      breakers: DEFAULT_SWERVE_BREAKERS,
      rioBreakerAmps: 10,
    });
  }
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  if (raw && typeof raw === 'object' && 'model' in (raw as object)) {
    return (raw as { model: RobotModel }).model;
  }
  return raw as RobotModel;
}

function main(argv: string[]): number {
  const inputPath = argv[0];
  const outputPath = argv[1];
  const robotPath = argv[2];
  if (!inputPath || !outputPath) {
    console.error(
      'Usage: pnpm exec tsx scripts/match-log-compare.ts <input.csv> <output.csv> [robot.json]',
    );
    return 1;
  }

  const csvText = readFileSync(resolve(inputPath), 'utf8');
  const parsed = parseMatchLogCsv(csvText);
  if (parsed.rows.length === 0) {
    console.error('No data rows found in match log.');
    return 1;
  }

  const model = loadRobot(robotPath);
  const { components, powerEdges } = buildCircuitGraph(model);
  const profile = matchProfileFromLog(parsed.rows);
  const match = simulateMatch(profile, components, powerEdges);

  const predictedByTime = new Map<number, number>();
  for (const sample of match.samples) {
    predictedByTime.set(sample.t, sample.systemVoltage);
  }

  const stats = compareMatchVoltages(parsed.rows, predictedByTime);
  writeFileSync(resolve(outputPath), formatComparisonCsv(stats), 'utf8');

  console.log(`rows: ${stats.count}`);
  console.log(`RMS error (V): ${stats.rmsError.toFixed(6)}`);
  console.log(`max |error| (V): ${stats.maxAbsError.toFixed(6)}`);
  if (match.issues.length > 0) {
    console.log('simulation issues:');
    for (const issue of match.issues) {
      console.log(`  - ${issue.code}: ${issue.message}`);
    }
  }
  console.log(`wrote ${resolve(outputPath)}`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
