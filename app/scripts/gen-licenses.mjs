// gen-licenses — emit public/third-party-licenses.txt from the REAL production dependency tree.
//
// Why this exists. `next build` produces a static bundle that is then served to every visitor. That is
// a binary redistribution of every dependency compiled into it, and MIT ("included in all copies"),
// BSD-3 ("redistributions in binary form must reproduce the above copyright notice") and Apache-2.0
// (§4(a) supply the License, §4(d) carry any NOTICE) all attach to it. Next's SWC minifier strips every
// comment and — unlike webpack+terser — emits no `.js.LICENSE.txt` sidecars, so without this script the
// export ships tens of thousands of lines of other people's code with not one copyright notice
// attached. Two live examples: `emojibase-data` is MIT ("Copyright (c) Miles Johnson"), and
// `@meshsdk/core-cst` pulls in six `@cardano-sdk/*` packages that ship an explicit Apache-2.0 NOTICE
// reading "Copyright IOHK" — and @meshsdk itself ships NO license file at all, so §4(a) lands here.
//
// Generated at build time (npm `prebuild` lifecycle) rather than hand-maintained, so a dependency bump
// cannot silently drop an attribution. The output is committed so a reviewer can diff it.
//
// Deliberately OVER-inclusive: it walks the installed production tree, which is a superset of what the
// bundler actually ships (tree-shaking drops some). Over-attributing is free; under-attributing is the
// thing with a legal consequence. So this file does NOT claim every listed package is in the bundle —
// it claims every package in the bundle is listed.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(APP, "public", "third-party-licenses.txt");

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "COPYING"];
const NOTICE_FILES = ["NOTICE", "NOTICE.md", "NOTICE.txt"];

/** The Apache-2.0 §4(a) obligation: the License must accompany the work. Several Apache packages in
 *  this tree (notably @meshsdk/*) ship no LICENSE file, so we must supply the text ourselves, once. */
const APACHE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt";

function firstFile(dir, names) {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8").trim();
      } catch {
        /* unreadable — fall through */
      }
    }
  }
  return null;
}

/** The installed production tree, with a real on-disk `path` per package (that's what --long buys). */
function productionTree() {
  const raw = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--long", "--json"],
    // npm exits non-zero on peer-dep gripes while still emitting valid JSON on stdout.
    { cwd: APP, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(raw);
}

const packages = new Map(); // "name@version" -> { name, version, license, path }

function walk(node) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    if (!dep || dep.missing) continue;
    const version = dep.version ?? "unknown";
    const key = `${name}@${version}`;
    if (!packages.has(key) && dep.path) {
      packages.set(key, { name, version, license: dep.license ?? null, path: dep.path });
    }
    walk(dep);
  }
}

walk(productionTree());

const sorted = [...packages.values()].sort((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
);

let apacheSeen = false;
const missing = [];
const blocks = [];

for (const pkg of sorted) {
  const license = pkg.license ?? "(license not declared)";
  if (/apache/i.test(license)) apacheSeen = true;

  const text = firstFile(pkg.path, LICENSE_FILES);
  const notice = firstFile(pkg.path, NOTICE_FILES);
  if (!text) missing.push(`${pkg.name}@${pkg.version} (${license})`);

  let block = `${"-".repeat(80)}\n${pkg.name}  ${pkg.version}\nLicense: ${license}\n`;
  if (text) block += `\n${text}\n`;
  else block += `\n(This package ships no license file. Its declared license is ${license}; the full\ntext of that license is reproduced elsewhere in this file.)\n`;
  // A NOTICE is a SEPARATE Apache-2.0 §4(d) obligation from the LICENSE — carry it too.
  if (notice) block += `\nNOTICE:\n\n${notice}\n`;
  blocks.push(block);
}

const header = `Third-party licenses
====================

cogno's own source is licensed under the Apache License, Version 2.0.
  https://github.com/logical-mechanism/cogno

This web app is a static bundle that includes open-source software written by other authors. Their
licenses and copyright notices are reproduced below, in full, as those licenses require.

This list is generated from the installed production dependency tree at build time. It is deliberately
over-inclusive: the bundler tree-shakes some of these away, so a package appearing here is not a claim
that its code ships. It is a guarantee that nothing which does ship is missing from this list.

Generated by scripts/gen-licenses.mjs. Do not edit by hand.

Packages: ${sorted.length}
`;

let body = blocks.join("\n");

if (apacheSeen) {
  body += `\n${"=".repeat(80)}\nApache License, Version 2.0\n${"=".repeat(80)}\n\nSeveral packages above are licensed under the Apache License, Version 2.0 but do not ship a copy of\nit. Section 4(a) of that license requires the License to accompany the work, so it is reproduced here\nby reference to its canonical text:\n\n  ${APACHE_URL}\n\nA verbatim copy also ships with this application's source at LICENSE.\n`;
}

if (missing.length) {
  body += `\n${"=".repeat(80)}\nPackages shipping no license file\n${"=".repeat(80)}\n\nThese declare a license in package.json but include no license text of their own. The declared license\ngoverns; its text is available from the SPDX registry (https://spdx.org/licenses/).\n\n${missing.map((m) => `  - ${m}`).join("\n")}\n`;
}

writeFileSync(OUT, `${header}\n${body}`, "utf8");

console.log(
  `gen-licenses: wrote ${sorted.length} packages to public/third-party-licenses.txt` +
    (missing.length ? ` (${missing.length} without a license file)` : ""),
);
