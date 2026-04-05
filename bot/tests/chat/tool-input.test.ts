import { describe, expect, it } from 'vitest';
import {
  sanitizeAdvisorHistoryInput,
  sanitizeBacktestInput,
} from '../../src/chat/tool-input.js';

describe('chat/tool-input', () => {
  it('keeps only allowed backtest fields', () => {
    expect(sanitizeBacktestInput({
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      initialCapital: 50_000,
      dnAllocation: 0.65,
      ignored: 'value',
    })).toEqual({
      startDate: '2024-01-01',
      endDate: '2024-06-01',
      initialCapital: 50_000,
      dnAllocation: 0.65,
    });
  });

  it('rejects oversized backtest ranges', () => {
    expect(() => sanitizeBacktestInput({
      startDate: '2020-01-01',
      endDate: '2024-06-01',
    })).toThrow('Backtest range must be 1095 days or less');
  });

  it('rejects out-of-range numeric values', () => {
    expect(() => sanitizeBacktestInput({
      confirmDays: 0,
    })).toThrow('confirmDays must be between 1 and 30');

    expect(() => sanitizeBacktestInput({
      dnAllocation: 1.5,
    })).toThrow('dnAllocation must be between 0 and 1');
  });

  it('clamps advisor history limit and validates category', () => {
    expect(sanitizeAdvisorHistoryInput({ limit: 999, category: 'dn_exit' })).toEqual({
      limit: 50,
      category: 'dn_exit',
    });

    expect(() => sanitizeAdvisorHistoryInput({ category: 'unknown' })).toThrow(
      'category is not allowed',
    );
  });
});
