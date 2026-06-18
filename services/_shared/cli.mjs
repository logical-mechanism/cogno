// Shared, dependency-free CLI helper for the cogno-chain off-chain services. `isMain(import.meta.url)`
// returns true when the calling module is the process entrypoint (run directly), false when it is
// imported (e.g. by a *.test.mjs). Extracted so the three entrypoints (op.mjs, sync-weight.mjs,
// relayer.mjs) share ONE definition of the run-as-main guard instead of copy-pasting the idiom.
import { pathToFileURL } from "node:url";

export const isMain = (moduleUrl) =>
	!!process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href;
