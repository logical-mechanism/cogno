"use client";

// LegalPage — /legal. Two things at once, in this order: the TERMS of using this deployment, and the
// LICENSING of the code it is built from.
//
// It used to be licensing only — four blocks of Apache-2.0 detail whose single risk sentence was the
// software warranty disclaimer, opening with "cogno is open source. There is no company account, no
// terms you clicked through, and no service being sold to you." Every clause of that is true about the
// SOFTWARE and none of it was the right frame for the DEPLOYMENT, which takes 100 ADA into a Plutus
// script and permanently binds a wallet to an undeletable history. "No terms you clicked through" in
// front of that reads as "and therefore nothing was agreed", which is not a position a named LLC wants
// to be in either direction.
//
// EVERY FACTUAL CLAIM IN THE TERMS SECTIONS IS CHECKED AGAINST CODE, not drafted from a template. If
// you change any of them, change the code reference too:
//   • owner-only custody, no operator/admin/pause role .... contracts/validators/talk_vault.ak
//   • no timelock, no cooldown, exit is unilateral ........ same, plus docs/ECONOMICS.md
//   • locked ADA KEEPS EARNING STAKING REWARDS ............ the vault address is
//     `serializePlutusScript(script, owner.stakeKeyHash, …)` (script payment cred + the OWNER's stake
//     cred) and validate.ak ENFORCES `out_stake == owner.stake_credential`. This page said the exact
//     opposite for a while ("earns no interest, rewards or yield of any kind"), which was the single
//     worst kind of error a terms page can carry: a checkable falsehood, in writing, about money.
//   • the lock amount is a FLOOR the script enforces ...... LOCK_ADA_WHOLE, imported below (not a literal)
//   • a bind cannot be undone by the user ................. pallets/cogno-gate has three calls and no
//     unbind; revoke is committee-only and writes two permanent tombstones
//   • posts cannot be removed by anyone .................... pallets/microblog, delete_post is a
//     permanently vacant call index
//
// DELIBERATELY NETWORK-NEUTRAL. This deployment runs against Cardano preprod today and is heading for
// mainnet; "real ADA" would be wrong now and "test ADA" would be wrong later. The copy says "the ADA
// you lock", which is true on both. Do not hardcode a network here, and do not wire a chain read into
// this page to resolve one — it is a static document, and lib/cardano/network.ts is the authority
// everywhere it actually matters.
//
// DELIBERATELY SILENT ON JURISDICTION. No governing-law clause, no registered address, no company
// number: none of those is published anywhere in this repo, so writing one would be inventing it.
// That is the gap counsel fills, and it is a bigger gap than the prose.
//
// The third-party notice below is not decoration. The static export ships minified copies of its
// dependencies — @meshsdk/core-cst carries the @cardano-sdk packages, which are Apache-2.0 WITH a
// NOTICE, and the rest of the tree is MIT/BSD. All three licenses require the copyright notice to
// travel with a binary distribution, and a browser bundle is one. `/third-party-licenses.txt` is that
// notice; it is generated at build time by scripts/gen-licenses.mjs from the real production tree, so
// it cannot silently drift when a dependency is bumped.

import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/lockAmount";
import { ABUSE_EMAIL, MIN_AGE, OPERATOR_LEGAL_NAME, REPO_URL as REPO } from "@/lib/config/operator";
import styles from "@/components/legal/Prose.module.css";

export default function LegalPage() {
  return (
    <>
      <StickyHeader showBack title="Legal" />

      <article className={styles.page}>
        <p className={styles.lead}>
          Nothing here is sold to you and there is no account to open. There are still terms, because
          this app locks your ADA in a contract and writes your identity to a public record that
          cannot be edited. They are short, and they are below.
        </p>

        <section className={styles.section}>
          <h2 className={styles.heading}>Using cogno</h2>
          <p className={styles.callout}>
            Everything you publish here is permanent. There is no delete, for you or for us or for
            anyone, and binding your wallet to an account cannot be undone. Do not use this app until
            you are comfortable with both.
          </p>
          <p className={styles.body}>
            By using cogno you agree that you are at least {MIN_AGE} years old, that you will follow
            the{" "}
            <Link className={styles.link} href="/policy/">
              content policy
            </Link>
            , and that you accept the two facts above. If you are under the age of majority where you
            live, get permission from a parent or guardian first.
          </p>
          <p className={styles.body}>
            You are responsible for what you post. Everything written to the chain carries the address
            that wrote it, and that address is bound to a Cardano wallet you control, so it is not
            anonymous to anyone willing to look. We do not review posts before they appear and we
            cannot remove one afterwards. What we can do about a report is set out in the content
            policy, plainly and with its limits.
          </p>
        </section>

        {/* id="cost" is a link target: the welcome flow's "More about the lock" points here rather
            than restating the custody explanation a fourth time. Renaming it breaks that link. */}
        <section className={styles.section} id="cost">
          <h2 className={styles.heading}>Your ADA, and who holds it</h2>
          <p className={styles.body}>
            Posting power comes from locking {LOCK_ADA_WHOLE} ADA in a Cardano smart contract. We never
            take custody of it. The contract only ever releases funds to a transaction signed by the
            payment key of the wallet that locked them, so the only person who can move your ADA is
            you. There is no operator key, no admin role, no pause switch and no upgrade path that
            could change that after the fact.
          </p>
          <p className={styles.body}>
            There is no lock-up period and no cooldown. You can exit whenever you like, straight back
            to your own wallet, and you do not need our permission or our servers to do it. The exit
            is a Cardano transaction, so it costs a network fee and your wallet needs a collateral
            input of at least 5 ADA.
          </p>
          <p className={styles.body}>
            Locked ADA stays delegated to whatever stake pool you had already chosen, and keeps
            earning your normal Cardano staking rewards while it sits in the contract. That is a
            property of how the vault address is built, not a service we provide: the address carries
            your own stake key, and the contract refuses any other. We pay you nothing, we take
            nothing, and we have no say in it.
          </p>
          <p className={styles.body}>
            The contract is open source and has been audited, and the report is in the repository. It
            is still software. Read it, or have someone read it, before you decide how much to trust
            it.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Who we are</h2>
          <p className={styles.body}>
            This site is operated by {OPERATOR_LEGAL_NAME}. You can reach us at{" "}
            <a className={styles.link} href={`mailto:${ABUSE_EMAIL}`}>
              {ABUSE_EMAIL}
            </a>
            , which is the address for reports, legal notices and questions alike. For a security
            vulnerability, follow{" "}
            <a
              className={styles.link}
              href={`${REPO}/blob/main/SECURITY.md`}
              target="_blank"
              rel="noreferrer noopener"
            >
              SECURITY.md
            </a>{" "}
            instead of posting it.
          </p>
          <p className={styles.body}>
            We can stop serving a post or an account from this site, and we can bring a motion to
            revoke an account so that it cannot post again. Neither of those removes anything from the
            chain, and neither is something we do on a whim. We can also stop hosting this site
            entirely, at any time, without that unpublishing a single byte. The record does not depend
            on us, which is the point of it.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What we do not promise</h2>
          <p className={styles.body}>
            This site is provided as is. We do not promise it will be available, that the network will
            keep running, that your posts will be readable in ten years, or that a Cardano transaction
            you build here will succeed. Nothing on this site is financial, legal or tax advice.
          </p>
          <p className={styles.body}>
            To the fullest extent the law allows, we are not liable for loss arising from your use of
            this site or of the contracts it builds transactions for. That does not cover things the
            law does not let us disclaim, and nothing here takes away a right you have that cannot be
            given up.
          </p>
        </section>

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
            , and the code it builds on is credited in{" "}
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
            It is provided <strong>as is, without warranties or conditions of any kind</strong>. Use
            it at your own risk.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Third-party software</h2>
          <p className={styles.body}>
            This app bundles open-source code from other authors, among them React, Next.js,
            polkadot-api, MeshJS and the Cardano SDK. Their licenses and copyright notices are
            reproduced in full here:
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
          <h2 className={styles.heading}>Trademarks</h2>
          <p className={styles.body}>
            Cardano, Polkadot, Substrate and the wallet brands this app can connect to are trademarks
            of their respective owners. cogno is not affiliated with, sponsored by, or endorsed by any
            of them.
          </p>
        </section>

        <p className={styles.footnote}>
          © 2026 {OPERATOR_LEGAL_NAME} ·{" "}
          <Link className={styles.link} href="/privacy/">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link className={styles.link} href="/policy/">
            Content policy
          </Link>
        </p>
      </article>
    </>
  );
}
