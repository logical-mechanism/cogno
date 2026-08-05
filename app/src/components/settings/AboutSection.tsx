"use client";

// AboutSection — Settings. A minimal, plain "About cogno-chain" card: name + one-liner +
// an optional source link + the copyright line. NO honesty / trusted-follower / operator-run / anchor copy.
//
// It also carries the LEGAL/POLICY/CONTACT row, and that placement is deliberate rather than tidy.
// RightRail was the only other surface linking /legal and /privacy, and it is `display: none` below
// 1227px and returns null on /welcome and /settings — so before this, a phone had no path to any legal
// surface at all, and no path to the abuse contact. Settings is in the BottomTabBar at every width, so
// this card is the one place the links are always reachable. Keep them here.
//
// Contact is a `mailto:` and cannot be a form: the deployed CSP sets `form-action 'none'`
// (deploy/nginx/security-headers.conf), so a report form would work under `next dev` and silently fail
// in production.

import Link from "next/link";
import styles from "./AboutSection.module.css";
import { ABUSE_EMAIL, OPERATOR_LEGAL_NAME, REPO_URL } from "@/lib/config/operator";

export function AboutSection() {
  return (
    <div className={styles.card}>
      <h3 className={styles.name}>cogno</h3>
      <p className={styles.tagline}>A feeless place to post.</p>
      <a className={styles.link} href={REPO_URL} target="_blank" rel="noreferrer noopener">
        Source ↗
      </a>

      <nav className={styles.docs} aria-label="Policies">
        <Link className={styles.docLink} href="/policy/">
          Content policy
        </Link>
        <Link className={styles.docLink} href="/legal/">
          Terms and legal
        </Link>
        <Link className={styles.docLink} href="/privacy/">
          Privacy
        </Link>
      </nav>

      <p className={styles.contact}>
        Report abuse or illegal content:{" "}
        <a className={styles.contactLink} href={`mailto:${ABUSE_EMAIL}`}>
          {ABUSE_EMAIL}
        </a>
      </p>

      <p className={styles.copyright}>© 2026 {OPERATOR_LEGAL_NAME}</p>
    </div>
  );
}
