// Headless forkless runtime upgrade — `system.set_code` via sudo (docs/UPGRADES.md step 6).
// Reads the compiled runtime wasm FROM A FILE (it's ~500KB — too big for a CLI arg) and submits
// `sudo.sudo(system.setCode(wasm))`. set_code is Operational (whole-block weight), so plain
// `sudo.sudo` is fine — no sudoUncheckedWeight needed. set_code's `can_set_code` REFUSES a wasm whose
// spec_version is not strictly greater than on-chain (a built-in safety net against the wrong/older wasm).
// set_code is Root-only (frame_system) — the 3/5 committee CANNOT do it, so this is sudo, by design.
//
//   SUDO_SEED='//YourSudo' node set-code.mjs \
//     --wasm ../../target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm \
//     [--ws ws://127.0.0.1:9944]
//
// (SUDO_SEED defaults to the dev //Alice; set it to the real operator sudo seed on the live node.)
import { readFileSync } from "node:fs";
import { connect, operators, viaSudo, find, assertGenesis } from "./lib.mjs";

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
		const spec = api.runtimeVersion.specVersion.toNumber();
		console.log(
			`chain ${api.genesisHash.toHex().slice(0, 10)}… on-chain spec ${spec} | uploading ${(code.length - 2) / 2} wasm bytes from ${opt.wasm}`,
		);
		assertGenesis(api); // pin the chain if GENESIS is set — refuse the wrong chain
		const { evs } = await viaSudo(api, api.tx.system.setCode(code), {
			operators: operators(),
			log: (m) => console.log("  " + m),
		});
		const updated = find(evs, "system", "CodeUpdated");
		console.log(
			updated
				? "✓ system.CodeUpdated — the new runtime is live at the next block"
				: "submitted but NO CodeUpdated seen — check the wasm spec_version > on-chain, and the sudo key",
		);
		await api.disconnect();
		process.exit(updated ? 0 : 1);
	} catch (e) {
		console.error("SET-CODE FAILED:", e?.message || e);
		await api.disconnect();
		process.exit(1);
	}
}

main();
