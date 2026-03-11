# How to Deposit

This guide walks you through depositing USDC into the Dawn Vault.

## Prerequisites

- A Solana wallet (Phantom, Solflare, or Backpack recommended)
- USDC on Solana (SPL token)
- A small amount of SOL for transaction fees (~0.01 SOL)

## Step-by-Step Guide

### 1. Connect Your Wallet

1. Visit the Dawn Vault web app
2. Click **"Connect Wallet"** in the top right corner
3. Select your wallet provider (Phantom, Solflare, Backpack, etc.)
4. Approve the connection request in your wallet

### 2. Select a Vault

1. Browse the available vaults on the main page
2. Click on the **USDC Vault** card
3. Review the vault details:
   - Current APY
   - TVL and remaining capacity
   - Strategy allocation (Base vs. Alpha)

### 3. Deposit USDC

1. Enter the amount of USDC you wish to deposit
2. Review the transaction summary:
   - Amount to deposit
   - LP tokens to receive (based on current share price)
   - Estimated APY
3. Click **"Deposit"**
4. Approve the transaction in your wallet
5. Wait for transaction confirmation

### 4. Verify Your Position

After the transaction confirms:

- Your LP token balance appears in your wallet
- Your position is visible on the vault dashboard
- Yield begins accruing immediately (reflected in share price)

## What Happens After You Deposit

1. Your USDC is transferred to the vault's PDA (non-custodial)
2. You receive LP tokens representing your share of the vault
3. The Manager Bot allocates your capital according to the current strategy
4. Yield accrues and is reflected in the increasing LP token share price
5. No claiming or harvesting needed — yield auto-compounds

## Important Notes

- **No lock-up period**: You can withdraw at any time
- **Minimum deposit**: Check the vault page for current minimums
- **Capacity limits**: Deposits may be rejected if the vault has reached its TVL cap
- **Issuance fee**: 0% (no fee on deposit)
- **Redemption fee**: 0.1% applies on withdrawal

## Need Help?

If you encounter any issues, please reach out through our support channels.
