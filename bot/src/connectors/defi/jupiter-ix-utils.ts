import {
  address,
  type Address,
  type Instruction,
} from '@solana/kit';

/**
 * Deserialize a Jupiter instruction object (from swap-instructions API)
 * into an @solana/kit Instruction.
 */
export function deserializeInstruction(ix: any): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: (ix.accounts ?? []).map((acc: any) => ({
      address: address(acc.pubkey),
      role: acc.isWritable
        ? acc.isSigner ? 3 /* AccountRole.WRITABLE_SIGNER */ : 1 /* AccountRole.WRITABLE */
        : acc.isSigner ? 2 /* AccountRole.READONLY_SIGNER */ : 0 /* AccountRole.READONLY */,
    })),
    data: Buffer.from(ix.data, 'base64') as unknown as Uint8Array,
  };
}

/**
 * Fetch address lookup table accounts from RPC.
 */
export async function getAddressLookupTableAccounts(
  rpc: any,
  addresses: string[],
): Promise<any[]> {
  const tables: any[] = [];

  for (const addr of addresses) {
    try {
      const { value } = await rpc
        .getAddressLookupTable(address(addr))
        .send();
      if (value) {
        tables.push(value);
      }
    } catch {
      // Skip failed lookups
    }
  }

  return tables;
}
