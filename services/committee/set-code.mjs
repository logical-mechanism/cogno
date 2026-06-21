// Headless forkless runtime upgrade — `system.set_code` via sudo (docs/UPGRADES.md step 6).
// Reads the compiled runtime wasm FROM A FILE (it's ~500KB — too big for a CLI arg) and submits
// `sudo.sudo(system.setCode(wasm))`. set_code is Operational (whole-block weight), so plain
// `sudo.sudo` is fine — no sudoUncheckedWeight needed. set_code's `can_set_code` REFUSES a wasm whose
// spec_version is not strictly greater than on-chain (a built-in safety net against the wrong/older wasm).
// set_code is Root-only (frame_system) — the 3/5 committee CANNOT do it, so this is sudo, by design.
//
// Success is confirmed by the RUNTIME-VERSION BUMP, never by decoding events: set_code swaps the
// metadata MID-BLOCK, so @polkadot/api (still on the old metadata) cannot decode that block's
// `system.events` — which would otherwise throw a FALSE "no Sudid event" on a real success. We only
// touch `status` (no event decode) and then re-read the on-chain runtime version.
//
//   SUDO_SEED='//YourSudo' node set-code.mjs \
//     --wasm ../../target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm \
//     [--ws ws://127.0.0.1:9944]
//
// (SUDO_SEED defaults to the dev //Alice; set it to the real operator sudo seed on the live node.)
import { readFileSync } from "node:fs";
import { connect, operators, assertGenesis, SUDO_SEED } from "./lib.mjs";

function parseArgv(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--wasm") o.wasm = argv[++i];
		else if (argv[i] === "--ws") o.ws = argv[++i];
	}
	return o;
}

async function main() {
	const opt = parseArgv(process.argv.slice(2));
	if (!opt.wasm) {
		console.error(
			"usage: SUDO_SEED='//Sudo' node set-code.mjs --wasm <path-to-.compact.compressed.wasm> [--ws ws://127.0.0.1:9944]",
		);
		process.exit(2);
	}
	const code = "0x" + readFileSync(opt.wasm).toString("hex");

	const api = await connect(opt.ws);
	try {
		const before = api.runtimeVersion.specVersion.toNumber();
		const sudo = operators().kr.addFromUri(SUDO_SEED);
		console.log(
			`chain ${api.genesisHash.toHex().slice(0, 10)}… on-chain spec ${before} | uploading ${(code.length - 2) / 2} wasm bytes from ${opt.wasm} as sudo ${sudo.address}`,
		);
		assertGenesis(api); // pin the chain if GENESIS is set — refuse the wrong chain

		// Submit and resolve on FINALIZATION, touching only `status` (NOT `events` — see header).
		await new Promise((resolve, reject) => {
			api.tx.sudo
				.sudo(api.tx.system.setCode(code))
				.signAndSend(sudo, ({ status }) => {
					if (status.isInBlock) console.log(`  in block ${status.asInBlock.toHex()}`);
					if (status.isFinalized) resolve();
					else if (status.isInvalid || status.isDropped || status.isUsurped || status.isFinalityTimeout)
						reject(new Error(`tx not included: ${status.type}`));
				})
				.catch(reject);
		});

		// Authoritative success signal: the on-chain runtime version strictly increased. A can_set_code
		// rejection (wasm spec not greater / wrong sudo) leaves it unchanged ⇒ we report failure.
		const after = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
		if (after > before) {
			console.log(`✓ runtime upgraded: spec ${before} → ${after} (live now; the node applies it at the next block)`);
			await api.disconnect();
			process.exit(0);
		}
		throw new Error(`spec did NOT change (still ${after}) — set_code rejected (wasm spec not greater than on-chain? wrong sudo key?)`);
	} catch (e) {
		console.error("SET-CODE FAILED:", e?.message || e);
		await api.disconnect();
		process.exit(1);
	}
}

main();
