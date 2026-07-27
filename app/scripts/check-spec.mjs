// Fail the build if the frontend's DESCRIPTOR_SPEC_VERSION drifts from the runtime's spec_version.
//
// The frontend's PAPI descriptors are generated against one runtime. If the runtime's spec_version is
// bumped and the descriptors are not regenerated (or are, but this constant is not updated), the app
// ships mis-encoded writes and the boot guard has nothing to catch it with — SCALE metadata does not
// carry spec_version, so the frontend cannot discover it at runtime. Both numbers live in this repo,
// so we can simply assert they agree.
//
// If this fails after an intentional spec bump, the fix is the documented one:
//   rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)
// then update DESCRIPTOR_SPEC_VERSION in app/src/lib/chain/client.ts to match.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runtimeSrc = fileURLToPath(new URL("../../runtime/src/lib.rs", import.meta.url));
const clientSrc = fileURLToPath(new URL("../src/lib/chain/client.ts", import.meta.url));
const papiConfigSrc = fileURLToPath(new URL("../.papi/polkadot-api.json", import.meta.url));

// The committed PAPI entry must resolve descriptors from the committed `.papi/metadata/cogno.scale`
// and NOTHING else. `papi add -w ws://…` writes the node it was pointed at back into this config
// (`wsUrl`, plus that chain's `genesis` and `codeHash`), and once those are committed a later
// `papi generate` / `papi update` on a fresh clone or in CI resolves against a local dev node instead
// of the committed metadata — failing when nothing is listening, and silently regenerating from the
// WRONG chain's metadata when something is. A descriptor regen is supposed to be a deliberate,
// reviewed change to `cogno.scale`; strip the keys back out afterwards.
const DEV_ONLY_PAPI_KEYS = ["wsUrl", "genesis", "codeHash"];
const papiConfig = JSON.parse(readFileSync(papiConfigSrc, "utf8"));
for (const [name, entry] of Object.entries(papiConfig.entries ?? {})) {
  const leaked = DEV_ONLY_PAPI_KEYS.filter((k) => k in entry);
  if (leaked.length > 0) {
    console.error(
      `app/.papi/polkadot-api.json entry "${name}" carries ${leaked.join(", ")}.\n` +
        `That is what \`papi add -w …\` leaves behind after a descriptor regen. Remove those keys so\n` +
        `the entry resolves from "metadata" alone:\n` +
        `  { "${name}": { "metadata": ".papi/metadata/cogno.scale" } }`,
    );
    process.exit(1);
  }
  if (!entry.metadata) {
    console.error(`app/.papi/polkadot-api.json entry "${name}" has no "metadata" path.`);
    process.exit(1);
  }
}

const runtimeMatch = readFileSync(runtimeSrc, "utf8").match(/^\s*spec_version:\s*(\d+)\s*,/m);
const clientMatch = readFileSync(clientSrc, "utf8").match(
  // `export` is optional here on purpose: the constant is exported so client.test.ts can IMPORT it
  // instead of re-declaring its own copy. Anchoring on a bare `const` would make this script report
  // "could not find DESCRIPTOR_SPEC_VERSION" the moment that export was added.
  /^(?:export\s+)?const DESCRIPTOR_SPEC_VERSION:\s*number\s*\|\s*null\s*=\s*(\d+|null)\s*;/m,
);

if (!runtimeMatch) {
  console.error("could not find `spec_version:` in runtime/src/lib.rs — has the runtime moved?");
  process.exit(1);
}
if (!clientMatch) {
  console.error("could not find `DESCRIPTOR_SPEC_VERSION` in app/src/lib/chain/client.ts.");
  process.exit(1);
}

const runtimeSpec = Number(runtimeMatch[1]);
const clientSpec = clientMatch[1] === "null" ? null : Number(clientMatch[1]);

if (clientSpec === null) {
  console.error(
    `DESCRIPTOR_SPEC_VERSION is null, so the boot guard cannot detect a spec mismatch and the app\n` +
      `will happily mis-encode writes against a bumped runtime. Set it to ${runtimeSpec}.`,
  );
  process.exit(1);
}

if (clientSpec !== runtimeSpec) {
  console.error(
    `spec_version drift:\n` +
      `  runtime/src/lib.rs        spec_version = ${runtimeSpec}\n` +
      `  app/src/lib/chain/client.ts  DESCRIPTOR_SPEC_VERSION = ${clientSpec}\n\n` +
      `Regenerate the PAPI descriptors against the new runtime, then update the constant:\n` +
      `  rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`,
  );
  process.exit(1);
}

console.log(`spec ok — descriptors and runtime both at spec_version ${runtimeSpec}.`);
