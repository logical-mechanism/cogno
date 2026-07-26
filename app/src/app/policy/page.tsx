"use client";

// PolicyPage — /policy. The in-product content and abuse policy, and the ONLY reachable route to the
// operator from inside the app.
//
// Why it exists. Before this, POLICY.md sat in the repo and nothing in the bundle linked to it:
// `support@logicalmechanism` had zero hits under app/src, RightRail's footer offered Settings / Legal /
// Privacy, and the PostCard ··· menu offered Hide / Mute / Block. So an anonymous reader who hit
// something illegal had no in-product path to the operator at all, and the operator had no published
// acceptable-use rule to point at when defending a revoke motion. Both halves of that are fixed here:
// the rule is stated, and the address is on the page.
//
// This is the SIBLING of the root POLICY.md, not a copy of it. POLICY.md is written for someone reading
// the repo; this is written for someone who just scrolled past something and wants it gone. They must
// not DISAGREE — if you change what a report can achieve, change both.
//
// The hard constraint on every sentence here: a report path must not imply a takedown it cannot deliver.
// There is no `delete_post` call and there never will be, so "we removed it" is a promise this operator
// physically cannot keep. What CAN happen is stated in "What a report can do", in the order of how much
// it actually accomplishes, and the limit is stated in the same breath rather than in a footnote.

import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import { ABUSE_EMAIL, MIN_AGE, OPERATOR_LEGAL_NAME } from "@/lib/config/operator";
import styles from "@/components/legal/Prose.module.css";

export default function PolicyPage() {
  return (
    <>
      <StickyHeader showBack title="Content policy" />

      <article className={styles.page}>
        <p className={styles.lead}>
          What is not allowed here, what happens when you report it, and the honest limit on what
          anyone can do about it afterwards.
        </p>

        <section className={styles.section}>
          <h2 className={styles.heading}>Nothing here can be taken back</h2>
          <p className={styles.callout}>
            There is no delete. The protocol has no call for it. A post, a reply, a quote, a vote or a
            profile field is in every copy of the chain the moment it is in a block, and it stays
            there. Not you, not us, not the committee, and no court order can remove one. Read that
            again before you post, and before you decide what a report can achieve.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What you must not post</h2>
          <p className={styles.body}>
            Posting any of the following is a breach of this policy, and is grounds for a revoke
            motion against the account that did it:
          </p>
          <ul className={styles.list}>
            <li>
              Sexual content involving minors, in any form, including drawn or generated depictions.
            </li>
            <li>
              Content that is illegal to publish where you are, or that promotes or instructs a
              serious crime.
            </li>
            <li>
              Threats of violence, incitement to violence, or the celebration of a violent attack.
            </li>
            <li>
              Targeted harassment of a person, and the coordination of it. This includes publishing
              somebody else&apos;s private information without their consent.
            </li>
            <li>
              Content that promotes suicide or self-harm, rather than describing or seeking help with
              it.
            </li>
            <li>
              Impersonating a real person, project or organisation in order to deceive. Parody is
              fine when it is obvious that it is parody.
            </li>
            <li>
              Malware, phishing, wallet drainers, and links to any of them. This is a wallet-connected
              app, so a link that asks for a signature is the highest-risk thing anyone can post here.
            </li>
            <li>Spam, and automated posting whose purpose is to fill the feed.</li>
          </ul>
          <p className={styles.body}>
            Disagreement is not on that list. Being wrong, being rude, and being unpopular are not on
            it either. This is a short list on purpose, because the enforcement behind it is blunt and
            permanent.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What a report can do</h2>
          <p className={styles.body}>
            Three things, in the order of how much they actually achieve:
          </p>
          <ul className={styles.list}>
            <li>
              <strong>Stop the account posting again.</strong> A 3-of-5 committee vote can revoke an
              identity. That account can never post again, and neither that Cardano wallet nor its
              stake key can ever bind a new account. It is permanent. It is also forward-only: it
              stops the next post and does not touch the ones already published.
            </li>
            <li>
              <strong>Take it off this site.</strong> We can stop this frontend from serving a
              specific post or account. That changes what visitors to this address see. It does not
              change the chain, and anyone running their own node still reads the whole record.
            </li>
            <li>
              <strong>Comply with a valid legal order,</strong> to the extent it is technically
              possible. For anything already in a block, that extent is the two items above.
            </li>
          </ul>
          <p className={styles.body}>
            What no report can do is remove, edit or hide a post from the chain, or reverse anything
            already published. That capability does not exist and cannot be added. If that is not an
            acceptable posture for you, do not use this network.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Report something</h2>
          <p className={styles.body}>
            Email{" "}
            <a className={styles.link} href={`mailto:${ABUSE_EMAIL}`}>
              {ABUSE_EMAIL}
            </a>
            . Include the link to the post or the profile, which is the fastest thing for us to act
            on, and say what the problem is. Every post and every profile in this app has a Copy link
            action, and a post&apos;s ··· menu has a Report option that opens an email with the link
            already filled in.
          </p>
          <p className={styles.body}>
            Found a security vulnerability instead? Do not post it. See{" "}
            <a
              className={styles.link}
              href="https://github.com/logical-mechanism/cogno/blob/main/SECURITY.md"
              target="_blank"
              rel="noreferrer noopener"
            >
              SECURITY.md
            </a>
            , which is a different address and a different process.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>Age</h2>
          <p className={styles.body}>
            You must be at least {MIN_AGE} years old to use cogno. If you are under the age of
            majority where you live, you need permission from a parent or guardian first. Locking ADA
            in the vault is a transaction with a real contract, so you must also be old enough to
            enter one where you live.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.heading}>What you can do yourself, right now</h2>
          <p className={styles.body}>
            You do not have to wait for us. Every post has a ··· menu with Hide post, Mute and Block.
            These are stored in your own browser, apply only to you, and take effect immediately. A
            public chain cannot hold a private mute list, which is why they are device-local rather
            than on the chain. They collapse or remove content from your view. They do not remove it
            for anyone else.
          </p>
          <p className={styles.body}>
            Images in posts stay behind a cover until you tap them, so nothing loads from the host
            they sit on until you choose to. That protects you as a reader. It is not moderation, and
            it does not check what is on the other end.
          </p>
        </section>

        <p className={styles.footnote}>
          © 2026 {OPERATOR_LEGAL_NAME} ·{" "}
          <Link className={styles.link} href="/legal/">
            Legal
          </Link>{" "}
          ·{" "}
          <Link className={styles.link} href="/privacy/">
            Privacy
          </Link>
        </p>
      </article>
    </>
  );
}
