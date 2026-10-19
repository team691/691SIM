import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compareMatchVoltages,
  formatComparisonCsv,
  matchProfileFromLog,
  maxAbsError,
  parseMatchLogCsv,
  rmsError,
} from './matchLogCompare.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_LOG = join(HERE, 'fixtures', 'match-log-SYNTHETIC.csv');

describe('match log compare', () => {
  it('parses the SYNTHETIC fixture and builds a load profile', () => {
    const csv = readFileSync(SYNTHETIC_LOG, 'utf8');
    const parsed = parseMatchLogCsv(csv);
    expect(parsed.currentDeviceIds).toEqual(['spark-1']);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual({
      t: 0,
      batteryVoltage: 12.5,
      currentsByDeviceId: { 'spark-1': 10 },
    });
    const profile = matchProfileFromLog(parsed.rows);
    expect(profile[1]?.loadsByDeviceId['spark-1']).toBe(20);
  });

  it('computes RMS and max absolute error by hand', () => {
    // errors = [0.1, -0.2, 0.2]
    // RMS = sqrt((0.01 + 0.04 + 0.04)/3) = sqrt(0.03) ≈ 0.173205
    // max |e| = 0.2
    const errors = [0.1, -0.2, 0.2];
    expect(rmsError(errors)).toBeCloseTo(Math.sqrt(0.03), 9);
    expect(maxAbsError(errors)).toBeCloseTo(0.2, 12);

    const stats = compareMatchVoltages(
      [
        { t: 0, batteryVoltage: 12.0, currentsByDeviceId: {} },
        { t: 1, batteryVoltage: 11.8, currentsByDeviceId: {} },
        { t: 2, batteryVoltage: 11.5, currentsByDeviceId: {} },
      ],
      new Map([
        [0, 12.1],
        [1, 11.6],
        [2, 11.7],
      ]),
    );
    // errors: 0.1, -0.2, 0.2
    expect(stats.rmsError).toBeCloseTo(Math.sqrt(0.03), 9);
    expect(stats.maxAbsError).toBeCloseTo(0.2, 12);
    expect(formatComparisonCsv(stats).split('\n')[0]).toBe(
      't,measuredBatteryVoltage,predictedSystemVoltage,error',
    );
  });
});
