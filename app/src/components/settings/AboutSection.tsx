"use client";

// AboutSection — Settings §8 (doc 12). A minimal, plain "About cogno-chain" card: name + one-liner +
// an optional source link. NO honesty / trusted-follower / operator-run / anchor copy.

import styles from "./AboutSection.module.css";

const SOURCE_URL = "https://github.com/logicalmechanism/cogno-chain";

export function AboutSection() {
  return (
    <div className={styles.card}>
      <h3 className={styles.name}>cogno-chain</h3>
      <p className={styles.tagline}>A feeless place to post.</p>
      <a className={styles.link} href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
        Source ↗
      </a>
    </div>
  );
}
