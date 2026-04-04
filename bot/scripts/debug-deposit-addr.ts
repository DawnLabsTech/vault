#!/usr/bin/env tsx
import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BinanceRestClient } from '../src/connectors/binance/rest.js';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const rpcUrl = process.env.HELIUS_RPC_URL || '';
const conn = new Connection(rpcUrl, 'confirmed');
const wallet = new PublicKey(process.env.SOLANA_WALLET_ADDRESS || '');

async function main() {
  // Check from ATA
  const fromAta = await getAssociatedTokenAddress(USDC_MINT, wallet);
  console.log('From wallet:', wallet.toBase58());
  console.log('From ATA:', fromAta.toBase58());
  try {
    const info = await conn.getAccountInfo(fromAta);
    console.log('From ATA exists:', info !== null, 'owner:', info?.owner?.toBase58());
    const balance = await conn.getTokenAccountBalance(fromAta);
    console.log('From USDC balance:', balance.value.uiAmount);
  } catch (e) { console.log('From ATA error:', (e as Error).message); }

  // Check Binance deposit address
  const binance = new BinanceRestClient(
    process.env.BINANCE_API_KEY || '',
    process.env.BINANCE_API_SECRET || '',
    false
  );
  const depInfo = await binance.getDepositAddress('USDC', 'SOL');
  console.log('\nBinance deposit address:', depInfo.address);
  const depPubkey = new PublicKey(depInfo.address);

  // Check if deposit address is a token account or wallet
  const depAccountInfo = await conn.getAccountInfo(depPubkey);
  console.log('Deposit addr exists on-chain:', depAccountInfo !== null);
  if (depAccountInfo) {
    console.log('Deposit addr owner:', depAccountInfo.owner.toBase58());
    const isTokenAccount = depAccountInfo.owner.equals(TOKEN_PROGRAM_ID);
    console.log('Is token account:', isTokenAccount);
  }

  // Check derived ATA
  const toAta = await getAssociatedTokenAddress(USDC_MINT, depPubkey);
  console.log('\nDerived ATA from deposit addr:', toAta.toBase58());
  const toAccountInfo = await conn.getAccountInfo(toAta);
  console.log('Derived ATA exists:', toAccountInfo !== null);
  if (toAccountInfo) {
    console.log('Derived ATA owner:', toAccountInfo.owner.toBase58());
  }
}

main().catch(console.error);
