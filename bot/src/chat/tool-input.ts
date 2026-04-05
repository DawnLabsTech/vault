const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_BACKTEST_RANGE_DAYS = 365 * 3;

type NumericRule = {
  min: number;
  max: number;
  integer?: boolean;
};

const BACKTEST_NUMERIC_RULES: Record<string, NumericRule> = {
  multiplyApy: { min: -100, max: 200 },
  lendingApy: { min: -100, max: 200 },
  dawnsolApy: { min: -100, max: 200 },
  frEntryAnnualized: { min: -500, max: 500 },
  frExitAnnualized: { min: -500, max: 500 },
  frEmergencyAnnualized: { min: -500, max: 500 },
  dnAllocation: { min: 0, max: 1 },
  confirmDays: { min: 1, max: 30, integer: true },
  initialCapital: { min: 100, max: 100_000_000 },
};

const ALLOWED_HISTORY_CATEGORIES = new Set([
  'rebalance',
  'dn_entry',
  'dn_exit',
  'risk_alert',
  'param_adjust',
]);

function parseIsoDate(value: unknown, fieldName: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a YYYY-MM-DD string`);
  }
  const trimmed = value.trim();
  if (!DATE_PATTERN.test(trimmed)) {
    throw new Error(`${fieldName} must be a YYYY-MM-DD string`);
  }
  const timestamp = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${fieldName} must be a valid calendar date`);
  }
  return trimmed;
}

function sanitizeNumber(
  rawValue: unknown,
  fieldName: string,
  rule: NumericRule,
): number | undefined {
  if (rawValue == null) {
    return undefined;
  }
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (rule.integer && !Number.isInteger(rawValue)) {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (rawValue < rule.min || rawValue > rule.max) {
    throw new Error(`${fieldName} must be between ${rule.min} and ${rule.max}`);
  }
  return rawValue;
}

export function sanitizeBacktestInput(
  input: Record<string, unknown>,
): Record<string, string | number> {
  const sanitized: Record<string, string | number> = {};

  const startDate = parseIsoDate(input['startDate'], 'startDate');
  const endDate = parseIsoDate(input['endDate'], 'endDate');
  if (startDate) sanitized['startDate'] = startDate;
  if (endDate) sanitized['endDate'] = endDate;

  if (startDate && endDate) {
    const startMs = Date.parse(`${startDate}T00:00:00Z`);
    const endMs = Date.parse(`${endDate}T00:00:00Z`);
    if (endMs < startMs) {
      throw new Error('endDate must be on or after startDate');
    }
    const rangeDays = Math.floor((endMs - startMs) / DAY_MS);
    if (rangeDays > MAX_BACKTEST_RANGE_DAYS) {
      throw new Error(`Backtest range must be ${MAX_BACKTEST_RANGE_DAYS} days or less`);
    }
  }

  for (const [fieldName, rule] of Object.entries(BACKTEST_NUMERIC_RULES)) {
    const value = sanitizeNumber(input[fieldName], fieldName, rule);
    if (value != null) {
      sanitized[fieldName] = value;
    }
  }

  return sanitized;
}

export function sanitizeAdvisorHistoryInput(
  input: Record<string, unknown>,
): { limit: number; category?: string } {
  const rawLimit = input['limit'];
  let limit = 10;
  if (rawLimit != null) {
    if (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit)) {
      throw new Error('limit must be a finite number');
    }
    limit = Math.max(1, Math.min(50, Math.trunc(rawLimit)));
  }

  const rawCategory = input['category'];
  if (rawCategory == null) {
    return { limit };
  }
  if (typeof rawCategory !== 'string' || !ALLOWED_HISTORY_CATEGORIES.has(rawCategory)) {
    throw new Error('category is not allowed');
  }

  return { limit, category: rawCategory };
}
