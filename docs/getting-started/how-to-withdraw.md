# How to Withdraw

This guide explains how to withdraw your USDC from the Dawn Vault.

## How Withdrawal Works

When you withdraw:

1. You burn your LP tokens
2. You receive USDC proportional to the current share price
3. Share price includes all accumulated yield (auto-compounded)

**Your withdrawal amount = LP tokens × current share price**

If the vault has performed well, you will receive more USDC than you originally deposited.

## Step-by-Step Guide

### 1. Navigate to the Vault

1. Connect your wallet to the Dawn Vault web app
2. Go to the USDC Vault page
3. Your current position is displayed (LP tokens held, current value)

### 2. Initiate Withdrawal

1. Click **"Withdraw"**
2. Enter the amount of LP tokens to redeem (or click "Max" for full withdrawal)
3. Review the withdrawal summary:
   - LP tokens to burn
   - USDC to receive (after fees)
   - Redemption fee (0.1%)

### 3. Confirm Transaction

1. Click **"Confirm Withdrawal"**
2. Approve the transaction in your wallet
3. Wait for transaction confirmation
4. USDC appears in your wallet

## Fees

| Fee | Amount | Purpose |
|-----|--------|---------|
| **Redemption Fee** | 0.1% | Discourages short-term arbitrage and sandwich attacks |

## Processing Time

- **Standard withdrawals**: Processed immediately on-chain
- **Large withdrawals**: May require position unwinding, which could take additional time if significant capital is in active strategies

## Partial vs. Full Withdrawal

- **Partial**: Withdraw any portion of your LP tokens
- **Full**: Withdraw all LP tokens to completely exit the vault

## Important Notes

- There is **no lock-up period** — withdraw anytime
- Yield is reflected in the share price, so there is no separate "claim" step
- The 0.1% redemption fee is deducted from the withdrawal amount
- If the vault share price has increased since your deposit, you will receive more USDC than you deposited (yield is auto-compounded)
- Performance fees are already deducted from the share price — what you see is what you get
