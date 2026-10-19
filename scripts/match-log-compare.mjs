/**
 * Runnable CLI (no tsx required). Typed source: match-log-compare.ts
 *
 *   node scripts/match-log-compare.mjs <input.csv> <output.csv> [robot.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const simDist = resolve(here, '../packages/simulation/dist/index.js');
const sim = await import(pathToFileURL(simDist).href);

const DEFAULT_SWERVE_BREAKERS = {
  driveAmps: 40,
  steerAmps: 20,
  cancoderAmps: 10,
  pigeonAmps: 10,
};

function loadRobot(path) {
  if (!path) {
    return sim.createSwerveRobotModel({
      breakers: DEFAULT_SWERVE_BREAKERS,
      rioBreakerAmps: 10,
    });
  }
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (raw && typeof raw === 'object' && 'model' in raw) return raw.model;
  return raw;
}

function main(argv) {
  const inputPath = argv[0];
  const outputPath = argv[1];
  const robotPath = argv[2];
  if (!inputPath || !outputPath) {
    console.error(
      'Usage: node scripts/match-log-compare.mjs <input.csv> <output.csv> [robot.json]',
    );
    return 1;
  }

  const csvText = readFileSync(resolve(inputPath), 'utf8');
  const parsed = sim.parseMatchLogCsv(csvText);
  if (parsed.rows.length === 0) {
    console.error('No data rows found in match log.');
    return 1;
  }

  const model = loadRobot(robotPath);
  const { components, powerEdges } = sim.buildCircuitGraph(model);
  const profile = sim.matchProfileFromLog(parsed.rows);
  const match = sim.simulateMatch(profile, components, powerEdges);

  const predictedByTime = new Map();
  for (const sample of match.samples) {
    predictedByTime.set(sample.t, sample.systemVoltage);
  }

  const stats = sim.compareMatchVoltages(parsed.rows, predictedByTime);
  writeFileSync(resolve(outputPath), sim.formatComparisonCsv(stats), 'utf8');

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
