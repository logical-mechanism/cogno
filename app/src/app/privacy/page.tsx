"use client";

// PrivacyPage — /privacy. Written to be TRUE rather than to be a privacy policy.
//
// There is no backend, no account, no analytics and no cookie to disclose, so the usual template would
// be three pages of things we do not do. The two facts that actually matter to a user are the ones a
// template would bury: posts are PERMANENT (there is no delete_post — nobody, including the operator,
// can remove them), and the network hops (our relay, Blockfrost) can see an IP. Those lead.

import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import styles from "@/components/legal/Prose.module.css";

export default function PrivacyPage() {
  return (
    <>
      <StickyHeader showBack title="Privacy" />

      <article className={styles.page}>
        <p className={styles.lead}>
          cogno has no accounts, no analytics, no cookies and no server that stores anything about
          you. That means there is very little to say here — but the little there is, matters.
        </p>

        <section className={styles.section}>
          <h2 className={styles.heading}>What you post is permanent</h2>
          <p className={styles.callout}>
            Posts cannot be deleted. Not by you, not by us, not by anyone. There is no delete
            function in the chain — that is a deliberate design choice, not an oversight. Anything you
            publish is written to a public blockchain, replicated to every node, and stays there.
            Assume it is permanent and world-readable before you press post.
          </p>
          <p className={styles.body}>
            Your address, your posts, your votes, your follows and your profile are all public chain
            data. Anyone can read them, index them, and keep their own copy, forever, without asking
            us.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What we collect</h2>
          <p className={styles.body}>Nothing. Specifically:</p>
          <ul className={styles.list}>
            <li>No account, no email, no password. Your identity is a key you hold.</li>
            <li>No analytics, no tracking pixels, no advertising, no third-party scripts.</li>
            <li>No cookies.</li>
            <li>
              No database. This app is a static page — there is no server of ours for your data to sit
              on.
            </li>
          </ul>
          <p className={styles.body}>
            Bookmarks, muted accounts and which notifications you have read are stored in your own
            browser, on your own device. Clearing your browser data erases them. They are never sent
            anywhere.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What the network can see</h2>
          <p className={styles.body}>
            Reading and posting means your browser talks to computers, and those computers see an IP
            address — the same as with any website. Two of them are worth naming:
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Our relay node</strong>, which serves the feed you are reading and forwards the
              posts you write.
            </li>
            <li>
              <strong>Blockfrost</strong>, a third-party Cardano service your browser calls directly
              when you lock or unlock ADA in the vault. That is their service, under their terms, not
              ours.
            </li>
          </ul>
          <p className={styles.body}>
            We keep no logs of this for any purpose beyond running the node, and we do not build
            profiles from it. If you want stronger network privacy than that, use a VPN or Tor — we
            cannot give it to you and would rather say so than pretend otherwise.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Deleting your data</h2>
          <p className={styles.body}>
            We cannot delete your posts, because we do not hold them and the chain does not permit it.
            We have no account to close and no profile to erase. Everything we could delete on your
            behalf is already stored only on your own device, where you can clear it yourself.
          </p>
        </section>

        <p className={styles.footnote}>
          © 2026 Logical Mechanism LLC ·{" "}
          <Link className={styles.link} href="/legal/">
            Legal
          </Link>
        </p>
      </article>
    </>
  );
}
