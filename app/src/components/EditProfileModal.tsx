"use client";

// EditProfileModal — the on-chain profile editor form (doc 07 §9 / doc 12 §3). PRESENTATIONAL: it owns
// the six form fields + byte validation + the clear-confirm dialog, and hands the collected values UP
// via onSaveProfile / onClearProfile. The persistent ModalRouteHost owns the actual write.
//
// COST MODEL (spec 117 — D9 OBSOLETE): set_profile / clear_profile are FEELESS + capacity-metered +
// OPTIMISTIC, built exactly like a post. There is NO funded-account gate, NO balance/fee check. Saving
// is CLOSE-INSTANTLY: the host applies the optimistic profile overlay (so the header/preview update at
// once), closes this modal, and shows a "Saving…" → "Profile updated" toast; capacity exhaustion
// (ExhaustsResources) surfaces as the rate-limit toast. Nothing here references a fee or a balance.
//
// Fields (UTF-8 BYTES, ByteCounter): display_name ≤ 64 / bio ≤ 256 / avatar ≤ 128. The avatar field
// shows a live preview (the same sanitized <img> + identicon-onError as Avatar). Clear profile needs a
// confirm dialog. (Pinning a post lives on the post's own overflow menu; unpin lives in Settings → Profile.)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./EditProfileModal.module.css";
import { ComposerModal } from "./ComposerModal";
import { ByteCounter, utf8Bytes } from "./ByteCounter";
import { Avatar } from "./Avatar";
import { Spinner } from "./icons";
import { useSession } from "./Providers";
import { NoPostingPowerNotice } from "./NoPostingPowerNotice";
import { useOptimistic } from "@/hooks/useOptimistic";

const MAX_NAME = 64;
const MAX_BIO = 256;
const MAX_AVATAR = 128;
const MAX_BANNER = 256;
const MAX_LOCATION = 64;
const MAX_WEBSITE = 256;

/** The six profile display fields, already trimmed. `set_profile` overwrites the whole record. */
export interface ProfileFields {
  displayName: string;
  bio: string;
  avatar: string;
  banner: string;
  location: string;
  website: string;
}

export interface EditProfileModalProps {
  onClose: () => void;
  /** Save the (trimmed) fields — the host runs the optimistic write + toast + close. */
  onSaveProfile: (fields: ProfileFields) => void;
  /** Clear the whole profile — the host runs the optimistic write + toast + close. */
  onClearProfile: () => void;
  /**
   * Ready account with ZERO posting power (locked-ADA weight 0, or a lock still crediting). set_profile /
   * clear_profile are capacity-metered exactly like a post, so with no power the write would be refused by
   * CheckCapacity. Mirror the composer: show the explained NoPostingPowerNotice + hard-disable the actions
   * rather than let Save fire into a confusing rate-limit toast. Advisory — CheckCapacity is the authority.
   */
  noPostingPower?: boolean;
}

export function EditProfileModal({
  onClose,
  onSaveProfile,
  onClearProfile,
  noPostingPower,
}: EditProfileModalProps) {
  const { api, source, signerCtl } = useSession();
  const { overlay } = useOptimistic();

  const ss58 = signerCtl.signer.ss58;
  // No posting power is a hard write block, same as in the composer: without capacity the feeless
  // set_profile / clear_profile can't land, so gate both actions off it (the NoPostingPowerNotice below
  // explains why — and shows the timed "crediting" state when a lock is still settling).
  const canWrite = !!api && signerCtl.postingEnabled && noPostingPower !== true;

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");
  const [banner, setBanner] = useState("");
  const [location, setLocation] = useState("");
  const [website, setWebsite] = useState("");

  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmKeepRef = useRef<HTMLButtonElement | null>(null);

  // Pre-fill from the viewer's current profile. An unretired optimistic patch (a save from moments ago,
  // still confirming) is the freshest truth, so it wins over the chain read; otherwise read
  // source.profile (or open blank when the reader can't serve profiles — submit reads nothing). One-shot.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const patch = ss58 ? overlay.profiles[ss58] : undefined;
    if (patch) {
      setName(patch.displayName);
      setBio(patch.bio);
      setAvatar(patch.avatar);
      setBanner(patch.banner);
      setLocation(patch.location);
      setWebsite(patch.website);
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        if (source && ss58) {
          const p = await source.profile({ author: ss58 });
          if (cancelled) return;
          setName(p.displayName ?? "");
          setBio(p.bio ?? "");
          setAvatar(p.avatar ?? "");
          setBanner(p.banner ?? "");
          setLocation(p.location ?? "");
          setWebsite(p.website ?? "");
        }
      } catch {
        /* leave blank — a missing/failed profile read just means an empty form */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, ss58]);

  // Move focus to the heading when the form is ready (a11y).
  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [loading]);

  // Move focus into the clear-confirm when it opens so keyboard/AT users are taken to it.
  useEffect(() => {
    if (confirmClear) confirmKeepRef.current?.focus();
  }, [confirmClear]);

  const nameBytes = useMemo(() => utf8Bytes(name), [name]);
  const bioBytes = useMemo(() => utf8Bytes(bio), [bio]);
  const avatarBytes = useMemo(() => utf8Bytes(avatar), [avatar]);
  const bannerBytes = useMemo(() => utf8Bytes(banner), [banner]);
  const locationBytes = useMemo(() => utf8Bytes(location), [location]);
  const websiteBytes = useMemo(() => utf8Bytes(website), [website]);
  const overLimit =
    nameBytes > MAX_NAME ||
    bioBytes > MAX_BIO ||
    avatarBytes > MAX_AVATAR ||
    bannerBytes > MAX_BANNER ||
    locationBytes > MAX_LOCATION ||
    websiteBytes > MAX_WEBSITE;

  const avatarSrc = avatar.trim().length > 0 ? avatar.trim() : null;

  // Hand the collected fields UP. The host applies the optimistic overlay, closes this modal at once,
  // and runs the feeless write to confirmation in the background (with the "Saving…" → done toast).
  const onSave = useCallback(() => {
    if (!canWrite || overLimit) return;
    onSaveProfile({
      displayName: name.trim(),
      bio: bio.trim(),
      avatar: avatar.trim(),
      banner: banner.trim(),
      location: location.trim(),
      website: website.trim(),
    });
  }, [canWrite, overLimit, name, bio, avatar, banner, location, website, onSaveProfile]);

  const onClear = useCallback(() => {
    if (!canWrite) return;
    onClearProfile();
  }, [canWrite, onClearProfile]);

  return (
    <ComposerModal title="Edit profile" onClose={onClose}>
      <div className={styles.root}>
        <h2 className={styles.heading} tabIndex={-1} ref={headingRef}>
          Edit profile
        </h2>

        {/* Same explained/timed pending-power banner the composer shows — self-contained (returns null
            once posting power is credited), so it only appears during the lock→credit wait or a real 0. */}
        <NoPostingPowerNotice />

        {loading ? (
          <div className={styles.loading} aria-busy>
            <Spinner label="Loading your profile" />
          </div>
        ) : (
          <>
            {/* Display name */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-name">
                Display name
              </label>
              <div className={styles.inputRow}>
                <input
                  id="ep-name"
                  className={styles.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  maxLength={512}                  autoComplete="off"
                />
                <ByteCounter value={name} maxBytes={MAX_NAME} size="sm" />
              </div>
            </div>

            {/* Bio */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-bio">
                Bio
              </label>
              <div className={styles.inputRow}>
                <textarea
                  id="ep-bio"
                  className={styles.textarea}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="Say something about yourself"
                  rows={3}                />
                <ByteCounter value={bio} maxBytes={MAX_BIO} size="sm" />
              </div>
            </div>

            {/* Avatar URL/CID + live preview */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-avatar">
                Avatar
              </label>
              <div className={styles.avatarRow}>
                <Avatar address={ss58} src={avatarSrc} size="lg" name={name} eager noRing />
                <div className={styles.avatarInput}>
                  <div className={styles.inputRow}>
                    <input
                      id="ep-avatar"
                      className={styles.input}
                      value={avatar}
                      onChange={(e) => setAvatar(e.target.value)}
                      placeholder="https://… or ipfs://…"
                      maxLength={512}
                      autoComplete="off"
                      inputMode="url"
                    />
                    <ByteCounter value={avatar} maxBytes={MAX_AVATAR} size="sm" />
                  </div>
                  <p className={styles.hint}>A link or IPFS CID, not an upload.</p>
                </div>
              </div>
            </div>

            {/* Banner URL/CID */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-banner">
                Banner
              </label>
              <div className={styles.inputRow}>
                <input
                  id="ep-banner"
                  className={styles.input}
                  value={banner}
                  onChange={(e) => setBanner(e.target.value)}
                  placeholder="https://… or ipfs://…"
                  maxLength={1024}                  autoComplete="off"
                  inputMode="url"
                />
                <ByteCounter value={banner} maxBytes={MAX_BANNER} size="sm" />
              </div>
              <p className={styles.hint}>A link or IPFS CID for your header image.</p>
            </div>

            {/* Location */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-location">
                Location
              </label>
              <div className={styles.inputRow}>
                <input
                  id="ep-location"
                  className={styles.input}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Where you are"
                  maxLength={256}                  autoComplete="off"
                />
                <ByteCounter value={location} maxBytes={MAX_LOCATION} size="sm" />
              </div>
            </div>

            {/* Website */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-website">
                Website
              </label>
              <div className={styles.inputRow}>
                <input
                  id="ep-website"
                  className={styles.input}
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://…"
                  maxLength={1024}                  autoComplete="off"
                  inputMode="url"
                />
                <ByteCounter value={website} maxBytes={MAX_WEBSITE} size="sm" />
              </div>
            </div>

            {overLimit && (
              <p className={styles.error} aria-live="polite">
                One of your fields is over its byte limit.
              </p>
            )}

            {/* Actions */}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => setConfirmClear(true)}
                disabled={!canWrite}
              >
                Clear profile
              </button>
              <div className={styles.actionsRight}>
                <button type="button" className={styles.cancelBtn} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={onSave}
                  disabled={!canWrite || overLimit}
                >
                  Save
                </button>
              </div>
            </div>

            {/* Clear confirm dialog */}
            {confirmClear && (
              <div
                className={styles.confirm}
                role="alertdialog"
                aria-label="Clear your profile?"
                // Escape dismisses only THIS confirm — stop it bubbling to ComposerModal's Escape
                // handler, which would otherwise close the whole edit-profile modal.
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmClear(false);
                  }
                }}
              >
                <p className={styles.confirmText}>Clear your profile? Your posts stay.</p>
                <div className={styles.confirmActions}>
                  <button
                    type="button"
                    ref={confirmKeepRef}
                    className={styles.cancelBtn}
                    onClick={() => setConfirmClear(false)}
                  >
                    Keep it
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    onClick={() => {
                      setConfirmClear(false);
                      onClear();
                    }}
                  >
                    Clear profile
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ComposerModal>
  );
}

export default EditProfileModal;
