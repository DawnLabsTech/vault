import type Anthropic from '@anthropic-ai/sdk';

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_backtest',
    description:
      'Run a backtest simulation with custom parameters to evaluate strategy performance under different conditions. ' +
      'Use this when the user asks "what if" questions about FR thresholds, allocation ratios, or historical scenarios.',
    input_schema: {
      type: 'object' as const,
      properties: {
        startDate: {
          type: 'string',
          description: 'Simulation start date (YYYY-MM-DD). Default: 2024-01-01',
        },
        endDate: {
          type: 'string',
          description: 'Simulation end date (YYYY-MM-DD). Default: 2026-04-01',
        },
        multiplyApy: {
          type: 'number',
          description: 'Fixed Multiply APY % (default: 13)',
        },
        lendingApy: {
          type: 'number',
          description: 'Fixed lending APY % (default: 5)',
        },
        dawnsolApy: {
          type: 'number',
          description: 'Fixed dawnSOL staking APY % (default: 6.8)',
        },
        frEntryAnnualized: {
          type: 'number',
          description: 'FR entry threshold % annualized (default: 10)',
        },
        frExitAnnualized: {
          type: 'number',
          description: 'FR exit threshold % annualized (default: 0)',
        },
        frEmergencyAnnualized: {
          type: 'number',
          description: 'FR emergency exit threshold % annualized (default: -10)',
        },
        dnAllocation: {
          type: 'number',
          description: 'DN allocation ratio 0-1 (default: 0.7)',
        },
        confirmDays: {
          type: 'number',
          description: 'Confirmation days for FR threshold (default: 3)',
        },
        initialCapital: {
          type: 'number',
          description: 'Initial capital in USDC (default: 10000)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_advisor_history',
    description:
      'Get recent AI advisor recommendations. Use when the user asks about past advisor advice, recommendation history, or accuracy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of recent recommendations (default: 10)',
        },
        category: {
          type: 'string',
          enum: ['rebalance', 'dn_entry', 'dn_exit', 'risk_alert', 'param_adjust'],
          description: 'Filter by category',
        },
      },
      required: [],
    },
  },
];
