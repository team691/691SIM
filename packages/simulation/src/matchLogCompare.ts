import type { MatchLoadSample } from './match.js';

export interface MatchLogRow {
  t: number;
  batteryVoltage: number;
  /** Device supply currents from `current_<deviceId>` columns. */
  currentsByDeviceId: Record<string, number>;
}

export interface MatchLogParseResult {
  rows: MatchLogRow[];
  currentDeviceIds: string[];
}

export interface MatchVoltageComparisonPoint {
  t: number;
  measuredBatteryVoltage: number;
  predictedSystemVoltage: number;
  error: number;
}

export interface MatchVoltageCompareStats {
  points: MatchVoltageComparisonPoint[];
  rmsError: number;
  maxAbsError: number;
  count: number;
}

const CURRENT_PREFIX = 'current_';

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Parse a match log CSV with columns `t`, `batteryVoltage`, and optional
 * `current_<deviceId>` columns. Rows with non-finite numbers are skipped.
 */
export function parseMatchLogCsv(csvText: string): MatchLogParseResult {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) {
    return { rows: [], currentDeviceIds: [] };
  }

  const header = parseCsvLine(lines[0]!);
  const tIndex = header.indexOf('t');
  const vIndex = header.indexOf('batteryVoltage');
  if (tIndex < 0 || vIndex < 0) {
    throw new Error('Match log CSV must include t and batteryVoltage columns');
  }

  const currentColumns: Array<{ index: number; deviceId: string }> = [];
  for (let i = 0; i < header.length; i += 1) {
    const name = header[i]!;
    if (name.startsWith(CURRENT_PREFIX) && name.length > CURRENT_PREFIX.length) {
      currentColumns.push({ index: i, deviceId: name.slice(CURRENT_PREFIX.length) });
    }
  }

  const rows: MatchLogRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const t = Number(cells[tIndex]);
    const batteryVoltage = Number(cells[vIndex]);
    if (!Number.isFinite(t) || !Number.isFinite(batteryVoltage)) continue;
    const currentsByDeviceId: Record<string, number> = {};
    for (const column of currentColumns) {
      const value = Number(cells[column.index]);
      if (Number.isFinite(value)) currentsByDeviceId[column.deviceId] = value;
    }
    rows.push({ t, batteryVoltage, currentsByDeviceId });
  }

  return {
    rows,
    currentDeviceIds: currentColumns.map((column) => column.deviceId),
  };
}

/** Build a MatchLoadSample profile from parsed current columns. */
export function matchProfileFromLog(rows: readonly MatchLogRow[]): MatchLoadSample[] {
  return rows.map((row) => ({
    t: row.t,
    loadsByDeviceId: { ...row.currentsByDeviceId },
  }));
}

export function rmsError(errors: readonly number[]): number {
  if (errors.length === 0) return 0;
  let sumSq = 0;
  for (const error of errors) sumSq += error * error;
  return Math.sqrt(sumSq / errors.length);
}

export function maxAbsError(errors: readonly number[]): number {
  let max = 0;
  for (const error of errors) max = Math.max(max, Math.abs(error));
  return max;
}

/**
 * Align predicted system voltages (from simulateMatch samples) with measured
 * batteryVoltage from the log by matching on t.
 */
export function compareMatchVoltages(
  logRows: readonly MatchLogRow[],
  predictedByTime: ReadonlyMap<number, number>,
): MatchVoltageCompareStats {
  const points: MatchVoltageComparisonPoint[] = [];
  for (const row of logRows) {
    const predicted = predictedByTime.get(row.t);
    if (predicted === undefined) continue;
    const error = predicted - row.batteryVoltage;
    points.push({
      t: row.t,
      measuredBatteryVoltage: row.batteryVoltage,
      predictedSystemVoltage: predicted,
      error,
    });
  }
  const errors = points.map((point) => point.error);
  return {
    points,
    rmsError: rmsError(errors),
    maxAbsError: maxAbsError(errors),
    count: points.length,
  };
}

/** CSV with t, measured, predicted, error for plotting. */
export function formatComparisonCsv(stats: MatchVoltageCompareStats): string {
  const header = 't,measuredBatteryVoltage,predictedSystemVoltage,error';
  const body = stats.points.map(
    (point) =>
      `${point.t},${point.measuredBatteryVoltage},${point.predictedSystemVoltage},${point.error}`,
  );
  return [header, ...body].join('\n') + '\n';
}
