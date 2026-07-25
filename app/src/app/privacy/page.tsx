"use client";

// PrivacyPage — /privacy. Written to be TRUE rather than to be a privacy policy.
//
// There is no backend, no account, no analytics and no cookie to disclose, so the usual template would
// be three pages of things we do not do. The two facts that actually matter to a user are the ones a
// template would bury: posts are PERMANENT (there is no delete_post — nobody, including the operator,
// can remove them), and the network hops (our relay, Blockfrost, and whoever hosts a governance
// proposal's document) can see an IP. Those lead.
//
// KEEP THE HOST LIST HONEST. It has drifted before: it named Blockfrost as vault-only while a profile
// view and a governance poll also call it, and it named no document host at all while a neutral-host
// proposal doc is fetched as the poll scrolls into view. If you add a fetch, add it here.

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
          you.
        </p>

        <section className={styles.section}>
          <h2 className={styles.heading}>What you post is permanent</h2>
          <p className={styles.callout}>
            Posts cannot be deleted. Not by you, not by us, not by anyone. Anything you publish is
            written to a public blockchain, replicated to every node, and stays there. Assume it is
            permanent and world-readable before you press post.
          </p>
          <p className={styles.body}>
            Your address, your posts, your votes, your follows and your profile are all public chain
            data. Anyone can read them, index them, and keep their own copy forever.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What we collect</h2>
          <p className={styles.body}>Nothing. Specifically:</p>
          <ul className={styles.list}>
            <li>
              No account, no email, no password. Your identity is a key you hold, and it never leaves
              your browser.
            </li>
            <li>No analytics, no tracking pixels, no advertising, no third-party scripts.</li>
            <li>No cookies.</li>
            <li>
              No database. This app is a static page, with no server of ours for your data to sit on.
            </li>
          </ul>
          <p className={styles.body}>
            Your bookmarks, the accounts you have muted or blocked, the posts you have hidden, your
            lists, the topics you follow, your recent searches, an unsent draft and which
            notifications you have read are all stored in your own browser, on your own device. So is
            your address, so that refreshing the page keeps you signed in. That address is already
            public on the chain: it is the author of every post you write. Your posting key is not
            stored: it is re-derived from a wallet signature the first time you post in a session.
            None of that is uploaded anywhere. Using it is separate: searching, or opening a topic,
            tells our relay node the words you are looking for, and opening a list asks it for each
            member&apos;s posts, so it can see who you put in the list.
          </p>
          <p className={styles.body}>
            All of it is tied to the address you signed in with, so two people sharing one browser do
            not see each other&apos;s lists, mutes or searches. Signing out forgets your address, so the
            next person to open this browser starts as a stranger. It leaves the rest alone on purpose:
            those are yours, and signing back in should not hand you an empty app. An unsent draft is the
            one exception, since signing out discards it rather than leaving your words sitting in the
            composer. Clearing your browser data erases everything.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What the network can see</h2>
          <p className={styles.body}>
            Reading and posting means your browser talks to servers, and they see your IP address,
            like any website. Three are worth naming:
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Our relay node</strong>, which serves the feed you are reading and forwards the
              posts you write. While you are signed in it is also asked, every couple of minutes,
              which posts mention your address, so your address is part of that read.
            </li>
            <li>
              <strong>Blockfrost</strong>, a third-party Cardano service your browser calls directly
              to read Cardano itself: your vault when you lock or exit ADA, the pool name behind a
              verified SPO badge when you open someone&apos;s full profile, and the current governance
              thresholds on a governance poll. It runs under their terms, not ours.
            </li>
            <li>
              <strong>Whatever host a governance proposal&apos;s document sits on.</strong> For a
              short list of well-known hosts, mostly public IPFS gateways and GitHub, that document is
              read as the poll scrolls into view, so the poll can show its title without you opening it.
              A document hosted anywhere else is read only when you press Preview proposal.
            </li>
          </ul>
          <p className={styles.body}>
            Images from other people stay covered until you tap them, in posts and on profiles alike.
            Until then nothing is requested from the server hosting them, so scrolling past leaves no
            trace there. Your own avatar and banner load without a tap, since you chose them.
          </p>
          <p className={styles.body}>
            We keep logs only to run the node, and we do not build profiles from them.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Deleting your data</h2>
          <p className={styles.body}>
            We cannot delete your posts: we do not hold them, and the chain does not permit it. There
            is no account to close and no profile to erase. Everything else is on your device, where
            you can clear it yourself.
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
