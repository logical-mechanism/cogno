// Test fixture for shared.test.mjs (cli.isMain). When run DIRECTLY this prints "MAIN:true"; when
// IMPORTED its check() returns the isMain verdict (false, since it is not the entrypoint). Keeps the
// run-as-main guard testable across the import/execute boundary without mutating process state.
import { isMain } from "./cli.mjs";

export const check = () => isMain(import.meta.url);

if (isMain(import.meta.url)) console.log("MAIN:true");
