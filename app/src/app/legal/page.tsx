"use client";

// LegalPage — /legal. The licensing surface of the thing you are actually running: this app's own
// terms (Apache-2.0), the third-party code the BUNDLE redistributes, and the trademarks it names.
//
// The third-party notice is not decoration. The static export ships minified copies of its
// dependencies — @meshsdk/core-cst carries the @cardano-sdk packages, which are Apache-2.0 WITH a
// NOTICE, and the rest of the tree is MIT/BSD. All three licenses require the copyright notice to
// travel with a binary distribution, and a browser bundle is one. `/third-party-licenses.txt` is that
// notice; it is generated at build time by scripts/gen-licenses.mjs from the real production tree, so
// it cannot silently drift when a dependency is bumped.

import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import styles from "@/components/legal/Prose.module.css";

const REPO = "https://github.com/logical-mechanism/cogno";

export default function LegalPage() {
  return (
    <>
      <StickyHeader showBack title="Legal" />

      <article className={styles.page}>
        <p className={styles.lead}>
          cogno is open source. There is no company account, no terms you clicked through, and no
          service being sold to you. So this page is short.
        </p>

        <section className={styles.section}>
          <h2 className={styles.heading}>This software</h2>
          <p className={styles.body}>
            The chain, the node, the contracts and this app are licensed under the{" "}
            <a
              className={styles.link}
              href={`${REPO}/blob/main/LICENSE`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Apache License, Version 2.0
            </a>
            . You can read, run, fork and redistribute all of it. The full source is at{" "}
            <a className={styles.link} href={REPO} target="_blank" rel="noreferrer noopener">
              github.com/logical-mechanism/cogno
            </a>
            , and every upstream it borrows from is credited in{" "}
            <a
              className={styles.link}
              href={`${REPO}/blob/main/NOTICE`}
              target="_blank"
              rel="noreferrer noopener"
            >
              NOTICE
            </a>
            .
          </p>
          <p className={styles.body}>
            It is provided <strong>as is, without warranties or conditions of any kind</strong>. That
            is not boilerplate: this is a testnet chain run by one operator, and you should treat it
            as one.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Third-party software in this page</h2>
          <p className={styles.body}>
            This app is a static bundle that includes open-source code from other authors, among them
            React, Next.js, polkadot-api, MeshJS and the Cardano SDK. Their licenses and copyright
            notices are reproduced in full here:
          </p>
          <p className={styles.body}>
            <a
              className={styles.link}
              href="/third-party-licenses.txt"
              target="_blank"
              rel="noreferrer noopener"
            >
              Third-party licenses ↗
            </a>
          </p>
          <p className={styles.body}>
            The typefaces (Inter Tight, IBM Plex Mono) and the emoji artwork are licensed under the{" "}
            <a
              className={styles.link}
              href="/OFL-1.1.txt"
              target="_blank"
              rel="noreferrer noopener"
            >
              SIL Open Font License 1.1
            </a>
            . The icon set uses Material Design Icons (Google, Apache-2.0).
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Names that are not ours</h2>
          <p className={styles.body}>
            Cardano, Polkadot, Substrate and the wallet brands this app can connect to are trademarks
            of their respective owners. cogno names them to say truthfully what it is built on and
            what it reads. It is not affiliated with, sponsored by, or endorsed by any of them.
          </p>
        </section>

        <p className={styles.footnote}>
          © 2026 Logical Mechanism LLC ·{" "}
          <Link className={styles.link} href="/privacy/">
            Privacy
          </Link>
        </p>
      </article>
    </>
  );
}
