// Cardanoscan explorer links. The host follows the network the CHAIN names (see network.ts), so a
// mainnet deployment links to mainnet without a frontend edit. This used to be pinned to preprod with
// a comment claiming there was "no mainnet variant to select".

import { cardanoscanBase } from "./network";

/** Link to a submitted transaction on the explorer for this deployment's network. */
export function cardanoscanTxUrl(txHash: string): string {
  return `${cardanoscanBase()}/transaction/${txHash}`;
}
