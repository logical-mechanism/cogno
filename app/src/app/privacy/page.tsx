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
//
// AND KEEP THE "WHAT WE HOLD" HALF HONEST TOO. This page used to claim "No database. This app is a
// static page, with no server of ours for your data to sit on", and, under Deleting your data, "we do
// not hold them ... there is no account to close and no profile to erase". Both were false. The app
// bundle is indeed static, but deploy/systemd/cogno-node.service and cogno-relay.service BOTH run
// `--state-pruning archive --blocks-pruning archive`: the operator holds a complete, permanent copy of
// every post, vote, follow and profile field, keyed to the ss58 that wrote it. And Settings ships a
// "Clear profile" button (components/settings/ProfileSection.tsx → pallet-profile::clear_profile), so
// there IS a profile to erase — from the current state, not from the history.
//
// The honest version costs nothing: "this is permanent, and we do hold a copy" is the design, stated.
// A false privacy claim by a named LLC is independently actionable in a way the truth is not. The
// operator's node is not privileged here — the same copy is what ANY reader of a public chain gets —
// so saying so plainly is a description of the protocol, not a confession about who runs it.

import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import { OPERATOR_LEGAL_NAME } from "@/lib/config/operator";
import styles from "@/components/legal/Prose.module.css";

export default function PrivacyPage() {
  return (
    <>
      <StickyHeader showBack title="Privacy" />

      <article className={styles.page}>
        <p className={styles.lead}>
          cogno has no accounts, no analytics and no cookies. What it has instead is a public
          blockchain that keeps what you post forever, and we run a copy of it.
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
          <h2 className={styles.heading}>What we ask you for</h2>
          <p className={styles.body}>Nothing. Specifically:</p>
          <ul className={styles.list}>
            <li>
              No account, no email, no password. Your identity is a key you hold, and it never leaves
              your browser.
            </li>
            <li>No analytics, no tracking pixels, no advertising, no third-party scripts.</li>
            <li>No cookies.</li>
            <li>
              No sign-up form and no profile we build about you. This app is a static page with no
              backend of its own. It talks to our relay node to read and to post, and what that
              involves is set out below.
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
          <h2 className={styles.heading}>What we do hold</h2>
          <p className={styles.body}>
            A copy of the chain, in full. We run the nodes that serve this site, and they keep every
            block ever produced rather than only recent ones. That copy contains every post, reply,
            quote, vote, poll, follow and profile field ever written, each one filed under the address
            that wrote it, along with the Cardano address and stake credential that address is bound
            to. It never expires and it is never trimmed.
          </p>
          <p className={styles.body}>
            That is not something we chose to collect about you. It is what the chain is, and anyone
            who runs a node has the same copy. We are one of them, and the copy we hold is the same
            public record you can download yourself.
          </p>
          <p className={styles.body}>
            Our web server also keeps ordinary access logs, the kind every web server keeps. They
            record your IP address, the time, and the address of the page you asked for. Since a
            profile lives at a URL containing that account&apos;s address, and a post at a URL
            containing its number, those logs can show which profiles and which posts an IP address
            opened. We keep them to run the site and to deal with abuse. We do not build profiles from
            them, we do not sell them, and we do not connect them to your chain address.
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
        </section>
        {/* The "We keep logs only to run the node" line that used to close this section moved up into
            "What we do hold", and got specific about the nginx access log while it was there. That
            sentence was true about the node journal and silently wrong about the web server, which is
            the log that actually ties an IP to a profile URL. */}

        <section className={styles.section}>
          <h2 className={styles.heading}>Deleting your data</h2>
          <p className={styles.body}>
            We cannot delete your posts. The protocol has no delete, so there is no button we could
            press and no order we could be given that would remove one. Deleting our own copy would
            change nothing either, because every other node still has it.
          </p>
          <p className={styles.body}>
            Two things you can do yourself. Settings has a Clear profile button, which writes an empty
            profile: the app stops showing your display name, bio, avatar, banner, location and
            website from that block on. The block that set them stays in the history, so someone
            reading the chain directly can still find the old values. And everything held on your
            device is yours to clear, either from Settings or by clearing your browser data.
          </p>
          <p className={styles.body}>
            There is no account to close. Your identity is a Cardano address bound to a chain address,
            and that binding is permanent. The committee can revoke it, which stops that account
            posting again and blocks it from ever binding again. It does not remove anything already
            posted. See our{" "}
            <Link className={styles.link} href="/policy/">
              content policy
            </Link>{" "}
            for what a report can and cannot achieve.
          </p>
        </section>

        <p className={styles.footnote}>
          © 2026 {OPERATOR_LEGAL_NAME} ·{" "}
          <Link className={styles.link} href="/legal/">
            Legal
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
