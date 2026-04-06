# Ranger Earn Presentation Script

## Slide Structure

1. Title
2. Problem
3. Solution Overview
4. Base Layer
5. Alpha Layer
6. AI-Powered Transparency
7. Risk Framework
8. Performance
9. Fit with Ranger Earn
10. Summary

## Prompt

Explain your strategy, your strengths, and how that would work on Ranger Earn.

## 3-Minute Script

### 1. Title

Hi, I'm Yutaro from Dawn Labs. We build a validator-native yield strategy with conditional alpha.

### 2. Problem

Before I explain what that means, let's talk about why this matters.

Just a few days ago, Drift Protocol lost 285 million dollars in the biggest Solana DeFi hack ever. That's a reminder that security risk in DeFi is very real.

But hacks aren't the only problem. Many vaults chase the highest APY without properly checking the risk. Strategies are often a black box — users can't see where their money goes or why. And there are no automatic exit rules — everything depends on manual decisions.

### 3. Solution Overview

Our answer is a two-layer architecture plus AI-powered transparency.

The Base Layer is always on. It generates steady yield with strict health and risk controls using Kamino Multiply and lending protocols.

The Alpha Layer only turns on when market conditions make it worth it — specifically, a SOL delta-neutral trade triggered by funding rate thresholds.

And we add AI-powered transparency so users can verify everything themselves.

### 4. Base Layer

Let me go deeper on each layer. The Base Layer follows a Multiply-first, Lending-second approach.

Available USDC goes to Kamino Multiply first — leveraged stablecoin loops for native yield and borrow rewards. We set health thresholds and cut exposure when health drops.

When Multiply is full or risk limits block more size, capital flows to Kamino Lend and Jupiter Lend as overflow. We always keep a withdrawal buffer ready.

### 5. Alpha Layer

The Alpha Layer is a SOL delta-neutral strategy. We go long dawnSOL for staking yield and short SOL perps for funding rate income. Together, that's market-direction independent.

The key point: this only turns on when the SOL funding rate is high enough. dawnSOL on the long side adds staking yield on top of funding income — a built-in edge. When conditions aren't right, Alpha stays off. No forced risk.

### 6. AI-Powered Transparency

Users can ask our AI about strategy logic, check backtest results, and get allocation guidance based on live market data. Not a black box — users see and question every decision.

### 7. Risk Framework

We score six risk factors continuously: depeg risk, liquidation proximity, exit liquidity, TVL, protocol maturity, and concentration.

When scores cross the line, the system automatically cuts exposure. If needed, it pulls out entirely. Rule-based — no panic decisions.

### 8. Performance

Our backtest covers 821 days from January 2024 to April 2026. The results: 14 percent APY, 0.23 percent max drawdown, and a Sharpe ratio of 27.

Importantly, the delta-neutral leg was only active 29 percent of the time. Alpha adds yield without forcing risk.

### 9. Fit with Ranger Earn

This strategy fits Ranger Earn naturally.

Both the Base and Alpha Layer run through Ranger's smart contract adapters. Layer switching and rebalancing happen automatically on-chain.

For users, it's one-click access. Complex strategy, simple UX — users deposit and the vault handles everything.

And Ranger's framework of clear permissions and whitelisted addresses lets us run advanced strategies without sacrificing transparency.

### 10. Summary

To sum up: Dawn Labs brings a strategy built on strong base yield, conditional alpha, disciplined risk management, and AI-powered transparency.

Thank you.
