//! A thin JSON-RPC ws client (jsonrpsee) — everything the CLI needs to read chain state and submit
//! signed extrinsics, resolving privileged writes on **finalization** (re-org safety).
//!
//! No metadata snapshot, no subxt: the CLI reuses the runtime's own SCALE types for decoding, and this
//! module only moves bytes (and a couple of JSON scalars) over the wire.

use anyhow::Context;
use codec::Decode;
use jsonrpsee::core::client::{ClientT, Subscription, SubscriptionClientT};
use jsonrpsee::rpc_params;
use jsonrpsee::ws_client::{WsClient, WsClientBuilder};
use sp_core::H256;
use std::time::Duration;

/// Upper bound on how long [`Rpc::submit_and_watch`] waits for a terminal transaction status before
/// giving up. A tx that never reaches a terminal state (e.g. stuck in the `Future` queue behind a nonce
/// gap, or a finalization stall) would otherwise block the CLI forever — bound it so a governed op fails
/// with a clear message instead of hanging. Generous, since a `finalize = true` wait spans GRANDPA.
const SUBMIT_WATCH_TIMEOUT: Duration = Duration::from_secs(180);

/// A connected ws client to a node's RPC endpoint.
pub struct Rpc {
    client: WsClient,
}

/// Decode a `0x`-prefixed hex string from an RPC result into bytes.
fn unhex(s: &str) -> anyhow::Result<Vec<u8>> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    Ok(hex::decode(s)?)
}

fn to_h256(s: &str) -> anyhow::Result<H256> {
    let b = unhex(s)?;
    anyhow::ensure!(b.len() == 32, "expected 32-byte hash, got {}", b.len());
    Ok(H256::from_slice(&b))
}

/// `0x`-prefixed lowercase hex for an RPC argument.
pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// The action a single `TransactionStatus` update implies for the [`Rpc::submit_and_watch`] loop.
enum WatchStep {
    /// A non-terminal status ("ready"/"future"/"broadcast"/"retracted", or `inBlock` while awaiting
    /// finalization) — keep watching.
    KeepWatching,
    /// The tx reached the target terminal state — the hash of the block it landed in (`inBlock` when not
    /// finalizing, else `finalized`).
    Landed(H256),
    /// A terminal REJECT (dropped/invalid/usurped/finalityTimeout) — the wait ends in an error.
    Rejected(String),
}

/// Classify one `author_submitAndWatchExtrinsic` status update.
///
/// `TransactionStatus` (sc-transaction-pool-api, `rename_all = "camelCase"`) arrives as EITHER a bare
/// string (the UNIT variants: `"ready"`, `"future"`, and the TERMINAL `"dropped"` / `"invalid"`) OR a
/// single-key object (the DATA variants: `{"broadcast":[..]}`, `{"inBlock":"0x.."}`,
/// `{"retracted":"0x.."}`, `{"usurped":"0x.."}`, `{"finalityTimeout":"0x.."}`, `{"finalized":"0x.."}`).
/// `Dropped`/`Invalid` are unit variants, so they come as bare strings and MUST be matched in the string
/// arm — an `obj.contains_key("dropped"/"invalid")` check would never fire.
fn classify_tx_status(status: &serde_json::Value, finalize: bool) -> anyhow::Result<WatchStep> {
    if let Some(s) = status.as_str() {
        return Ok(match s {
            "dropped" | "invalid" => WatchStep::Rejected(format!("tx {s} (never included/finalized)")),
            _ => WatchStep::KeepWatching, // "ready" / "future"
        });
    }
    if let Some(obj) = status.as_object() {
        if let Some(h) = obj.get("inBlock").and_then(|v| v.as_str()) {
            // Landed in a block; terminal only for the non-finalizing wait.
            return Ok(if finalize {
                WatchStep::KeepWatching
            } else {
                WatchStep::Landed(to_h256(h)?)
            });
        }
        if let Some(h) = obj.get("finalized").and_then(|v| v.as_str()) {
            return Ok(WatchStep::Landed(to_h256(h)?));
        }
        for terminal in ["usurped", "finalityTimeout"] {
            if obj.contains_key(terminal) {
                return Ok(WatchStep::Rejected(format!(
                    "tx {terminal} (never included/finalized): {status}"
                )));
            }
        }
    }
    // "broadcast" / "retracted" and any other non-terminal object status.
    Ok(WatchStep::KeepWatching)
}

impl Rpc {
    /// Connect to `url` (e.g. `ws://127.0.0.1:9944`).
    pub async fn connect(url: &str) -> anyhow::Result<Self> {
        let client = WsClientBuilder::default()
            .build(url)
            .await
            .with_context(|| format!("ws connect to {url} failed"))?;
        Ok(Self { client })
    }

    /// The genesis block hash (`chain_getBlockHash(0)`) — used for `CheckGenesis` + `assertGenesis`.
    pub async fn genesis_hash(&self) -> anyhow::Result<H256> {
        let s: String = self
            .client
            .request("chain_getBlockHash", rpc_params![0u32])
            .await
            .context("chain_getBlockHash(0) failed")?;
        to_h256(&s)
    }

    /// `(spec_version, transaction_version)` read live (`state_getRuntimeVersion`) — never hardcoded.
    pub async fn runtime_version(&self) -> anyhow::Result<(u32, u32)> {
        let v: serde_json::Value = self
            .client
            .request("state_getRuntimeVersion", rpc_params![])
            .await
            .context("state_getRuntimeVersion failed")?;
        let spec = v
            .get("specVersion")
            .and_then(|x| x.as_u64())
            .context("runtime version: missing specVersion")? as u32;
        let tx = v
            .get("transactionVersion")
            .and_then(|x| x.as_u64())
            .context("runtime version: missing transactionVersion")? as u32;
        Ok((spec, tx))
    }

    /// The next nonce for an account (`system_accountNextIndex`, ss58 input).
    pub async fn account_nonce(&self, ss58: &str) -> anyhow::Result<u32> {
        let n: u64 = self
            .client
            .request("system_accountNextIndex", rpc_params![ss58])
            .await
            .with_context(|| format!("system_accountNextIndex({ss58}) failed"))?;
        Ok(n as u32)
    }

    /// Read a storage value by its full key (`state_getStorage`), optionally at a block. `None` when the
    /// key is absent.
    pub async fn storage(&self, key: &[u8], at: Option<H256>) -> anyhow::Result<Option<Vec<u8>>> {
        let params = match at {
            Some(h) => rpc_params![hex0x(key), hex0x(h.as_bytes())],
            None => rpc_params![hex0x(key)],
        };
        let r: Option<String> = self
            .client
            .request("state_getStorage", params)
            .await
            .context("state_getStorage failed")?;
        match r {
            Some(s) => Ok(Some(unhex(&s)?)),
            None => Ok(None),
        }
    }

    /// Read every `(key, value)` pair under a storage prefix (`state_getPairs`), optionally at a block.
    /// Used by `query state`/`query weight` to iterate the talk-stake / cogno-gate maps.
    pub async fn storage_pairs(
        &self,
        prefix: &[u8],
        at: Option<H256>,
    ) -> anyhow::Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let params = match at {
            Some(h) => rpc_params![hex0x(prefix), hex0x(h.as_bytes())],
            None => rpc_params![hex0x(prefix)],
        };
        let pairs: Vec<(String, String)> = self
            .client
            .request("state_getPairs", params)
            .await
            .context("state_getPairs failed")?;
        pairs
            .into_iter()
            .map(|(k, v)| Ok((unhex(&k)?, unhex(&v)?)))
            .collect()
    }

    /// The SCALE-encoded extrinsics of a block (`chain_getBlock`), each as raw bytes — used to locate our
    /// own submitted extrinsic's index in the block so an `ExtrinsicFailed` can be matched to IT (and not
    /// to an unrelated extrinsic in the same block).
    pub async fn block_extrinsics(&self, at: H256) -> anyhow::Result<Vec<Vec<u8>>> {
        let v: serde_json::Value = self
            .client
            .request("chain_getBlock", rpc_params![hex0x(at.as_bytes())])
            .await
            .context("chain_getBlock failed")?;
        let xts = v
            .get("block")
            .and_then(|b| b.get("extrinsics"))
            .and_then(|e| e.as_array())
            .context("chain_getBlock: missing block.extrinsics")?;
        xts.iter()
            .map(|x| {
                let s = x.as_str().context("extrinsic is not a hex string")?;
                unhex(s)
            })
            .collect()
    }

    /// Decode a typed value from a storage key, or `None` if the key is absent.
    pub async fn storage_decode<T: Decode>(
        &self,
        key: &[u8],
        at: Option<H256>,
    ) -> anyhow::Result<Option<T>> {
        match self.storage(key, at).await? {
            Some(bytes) => {
                let v = T::decode(&mut &bytes[..])
                    .map_err(|e| anyhow::anyhow!("storage decode failed: {e}"))?;
                Ok(Some(v))
            }
            None => Ok(None),
        }
    }

    /// Submit a signed extrinsic and watch it to a terminal status. For a privileged write this resolves on
    /// **finalization** (`finalize = true`): it returns the finalized block hash the tx landed in, so the
    /// caller can read the (finalized) events from that block. Dropped / Invalid / Usurped / FinalityTimeout
    /// are terminal rejects (so the wait can never hang). With `finalize = false` it returns on first
    /// in-block inclusion.
    pub async fn submit_and_watch(
        &self,
        xt: &[u8],
        finalize: bool,
        label: &str,
    ) -> anyhow::Result<H256> {
        let mut sub: Subscription<serde_json::Value> = self
            .client
            .subscribe(
                "author_submitAndWatchExtrinsic",
                rpc_params![hex0x(xt)],
                "author_unwatchExtrinsic",
            )
            .await
            .with_context(|| format!("{label}: author_submitAndWatchExtrinsic failed"))?;

        let watch = async {
            while let Some(item) = sub.next().await {
                let status = item.with_context(|| format!("{label}: subscription error"))?;
                match classify_tx_status(&status, finalize)? {
                    WatchStep::KeepWatching => continue,
                    WatchStep::Landed(hash) => return Ok(hash),
                    WatchStep::Rejected(why) => anyhow::bail!("{label}: {why}"),
                }
            }
            anyhow::bail!("{label}: subscription ended before a terminal status")
        };

        // Bound the whole watch so a tx that never reaches a terminal state can't hang the CLI forever.
        match tokio::time::timeout(SUBMIT_WATCH_TIMEOUT, watch).await {
            Ok(res) => res,
            Err(_) => anyhow::bail!(
                "{label}: no terminal status within {}s — the tx may still be pending; check the chain \
                 state before retrying (a resubmit reuses the same nonce)",
                SUBMIT_WATCH_TIMEOUT.as_secs()
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hash0x(byte: u8) -> String {
        hex0x(&[byte; 32])
    }

    /// The bug this guards: `Dropped`/`Invalid` are UNIT variants, so they arrive as bare JSON strings,
    /// NOT `{"dropped":..}` objects — they must classify as terminal rejects, not be skipped as "some
    /// string ⇒ non-terminal".
    #[test]
    fn dropped_and_invalid_are_bare_strings_and_terminal() {
        assert!(matches!(
            classify_tx_status(&json!("dropped"), true).unwrap(),
            WatchStep::Rejected(_)
        ));
        assert!(matches!(
            classify_tx_status(&json!("invalid"), false).unwrap(),
            WatchStep::Rejected(_)
        ));
    }

    #[test]
    fn ready_and_future_strings_are_non_terminal() {
        assert!(matches!(
            classify_tx_status(&json!("ready"), true).unwrap(),
            WatchStep::KeepWatching
        ));
        assert!(matches!(
            classify_tx_status(&json!("future"), true).unwrap(),
            WatchStep::KeepWatching
        ));
    }

    #[test]
    fn inblock_lands_only_when_not_finalizing() {
        let s = json!({ "inBlock": hash0x(0xab) });
        // finalize = false ⇒ inBlock is the terminal we want.
        assert!(matches!(
            classify_tx_status(&s, false).unwrap(),
            WatchStep::Landed(_)
        ));
        // finalize = true ⇒ keep watching for the finalized status.
        assert!(matches!(
            classify_tx_status(&s, true).unwrap(),
            WatchStep::KeepWatching
        ));
    }

    #[test]
    fn finalized_object_lands() {
        assert!(matches!(
            classify_tx_status(&json!({ "finalized": hash0x(0xcd) }), true).unwrap(),
            WatchStep::Landed(_)
        ));
    }

    #[test]
    fn usurped_and_finality_timeout_objects_are_terminal_rejects() {
        assert!(matches!(
            classify_tx_status(&json!({ "usurped": hash0x(0xef) }), true).unwrap(),
            WatchStep::Rejected(_)
        ));
        assert!(matches!(
            classify_tx_status(&json!({ "finalityTimeout": hash0x(0x01) }), true).unwrap(),
            WatchStep::Rejected(_)
        ));
    }

    #[test]
    fn broadcast_and_retracted_objects_keep_watching() {
        assert!(matches!(
            classify_tx_status(&json!({ "broadcast": ["peer1", "peer2"] }), true).unwrap(),
            WatchStep::KeepWatching
        ));
        assert!(matches!(
            classify_tx_status(&json!({ "retracted": hash0x(0x02) }), true).unwrap(),
            WatchStep::KeepWatching
        ));
    }
}
