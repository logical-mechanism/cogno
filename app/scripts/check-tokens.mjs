// Fail the build if a *.module.css references a --cg-* custom property that no stylesheet declares.
//
// This is the class-level fix for two shipped bugs: `--cg-on-accent` (undeclared → the unread-count
// badge fell back to #fff on a near-white accent and was INVISIBLE in the default dark theme) and
// `--cg-z-popover` (undeclared → fell back to 60, below --cg-z-sticky, so the "N new posts" pill
// painted over the @-mention autocomplete). CSS resolves an undefined var() to its fallback silently,
// so neither the compiler, the linter, nor a test could see them — only this can.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Custom properties injected at runtime from TSX (via an inline style), so no stylesheet declares them. */
const RUNTIME_INJECTED = new Set(["--cg-clamp-lines"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".css")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const declared = new Set(RUNTIME_INJECTED);
for (const f of files) {
  for (const m of readFileSync(f, "utf8").matchAll(/^\s*(--cg-[\w-]+)\s*:/gm)) declared.add(m[1]);
}

const problems = [];
for (const f of files.filter((f) => f.endsWith(".module.css"))) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--cg-[\w-]+)/g)) {
      if (!declared.has(m[1])) problems.push(`${relative(SRC, f)}:${i + 1}  ${m[1]}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`undeclared design token${problems.length > 1 ? "s" : ""} referenced:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nDeclare it in src/styles/tokens.css, or use an existing token.`);
  console.error(`If it is injected at runtime from TSX, add it to RUNTIME_INJECTED in this script.`);
  process.exit(1);
}

console.log(`tokens ok — ${declared.size} declared, every var(--cg-*) in ${files.length} stylesheets resolves.`);
