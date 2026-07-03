// Cardanoscan explorer links. The whole app is a preprod testnet showcase (vault.ts pins the wallet
// to networkId 0), so the explorer host is fixed to preprod — no mainnet variant to select.

const CARDANOSCAN_PREPROD = "https://preprod.cardanoscan.io";

/** Link to a submitted transaction on preprod Cardanoscan. */
export function cardanoscanTxUrl(txHash: string): string {
  return `${CARDANOSCAN_PREPROD}/transaction/${txHash}`;
}
