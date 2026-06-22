"use client";

// EditProfileModal — the REAL on-chain profile editor (doc 07 §9 / doc 12 §3). Opens as an overlay
// (ModalRouteHost) or via the /settings/ standalone fallback; ModalRouteHost passes `onClose`.
//
// COST MODEL (spec 117 — D9 OBSOLETE): set_profile / clear_profile / pin_post / unpin_post are FEELESS
// + capacity-metered + OPTIMISTIC, built exactly like a post. There is NO funded-account gate, NO
// balance/fee check, NO RateLimitNotice-only path here: on confirm we close + raise a brief "Profile
// updated" success Toast; capacity exhaustion (ExhaustsResources) raises the rate-limit Toast. Nothing
// in this file references a fee, a balance, or "fund your account" — those are gone.
//
// Fields (UTF-8 BYTES, ByteCounter): display_name ≤ 64 / bio ≤ 256 / avatar ≤ 128. The avatar field
// shows a live preview (the same sanitized <img> + identicon-onError as Avatar). A pinned-post control
// lets the owner pin a post id or unpin the current one. Clear profile needs a confirm dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./EditProfileModal.module.css";
import { ComposerModal } from "./ComposerModal";
import { ByteCounter, utf8Bytes } from "./ByteCounter";
import { Avatar } from "./Avatar";
import { Spinner } from "./icons";
import { useSession } from "./Providers";
import { useMutation } from "@/hooks/useMutation";
import { useToaster, RATE_LIMIT_COPY } from "./toast/ToasterProvider";
import {
  submitSetProfile,
  submitClearProfile,
  submitPinPost,
  submitUnpinPost,
} from "@/lib/chain/mutations";

const MAX_NAME = 64;
const MAX_BIO = 256;
const MAX_AVATAR = 128;

/** A CheckCapacity pool rejection → the dedicated rate-limit copy (never a generic error). */
function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

export interface EditProfileModalProps {
  onClose: () => void;
}

export function EditProfileModal({ onClose }: EditProfileModalProps) {
  const { api, signer, source, signerCtl } = useSession();
  const { run } = useMutation();
  const { toast } = useToaster();

  const ss58 = signerCtl.signer.ss58;
  const canWrite = !!api && signerCtl.postingEnabled;

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");
  const [pinnedId, setPinnedId] = useState<bigint | null>(null);
  const [pinInput, setPinInput] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<null | "save" | "clear" | "pin" | "unpin">(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Pre-fill from the viewer's current profile. With an indexer we read source.profile; otherwise the
  // fields open blank (editing still works — submit reads nothing from chain). One-shot.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (source && source.caps.profiles && ss58) {
          const p = await source.profile({ author: ss58 });
          if (cancelled) return;
          setName(p.displayName ?? "");
          setBio(p.bio ?? "");
          setAvatar(p.avatar ?? "");
          setPinnedId(p.pinnedPostId ?? null);
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
  }, [source, ss58]);

  // Move focus to the heading when the form is ready (a11y).
  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [loading]);

  const nameBytes = useMemo(() => utf8Bytes(name), [name]);
  const bioBytes = useMemo(() => utf8Bytes(bio), [bio]);
  const avatarBytes = useMemo(() => utf8Bytes(avatar), [avatar]);
  const overLimit = nameBytes > MAX_NAME || bioBytes > MAX_BIO || avatarBytes > MAX_AVATAR;

  const busy = saving !== null;
  const avatarSrc = avatar.trim().length > 0 ? avatar.trim() : null;

  // The shared optimistic submit: run(stream) → close + success toast on confirm; rate-limit/error toast
  // otherwise. Feeless + capacity-metered, exactly like a post (no funding/balance path).
  const submit = useCallback(
    (
      kind: "save" | "clear" | "pin" | "unpin",
      stream: ReturnType<typeof submitSetProfile>,
      successCopy: string,
      onLocalApply?: () => void,
    ) => {
      if (!canWrite || busy) return;
      setSaving(kind);
      void run(stream, {
        onConfirm: () => {
          onLocalApply?.();
          setSaving(null);
          toast({ kind: "success", message: successCopy });
          onClose();
        },
        onError: (message: string) => {
          setSaving(null);
          if (isRateLimit(message)) toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {
        /* settled via onError */
      });
    },
    [canWrite, busy, run, toast, onClose],
  );

  const onSave = useCallback(() => {
    if (!api || overLimit) return;
    submit("save", submitSetProfile(api, signer, name.trim(), bio.trim(), avatar.trim()), "Profile updated");
  }, [api, signer, name, bio, avatar, overLimit, submit]);

  const onClear = useCallback(() => {
    if (!api) return;
    submit("clear", submitClearProfile(api, signer), "Profile cleared");
  }, [api, signer, submit]);

  const onPin = useCallback(() => {
    if (!api) return;
    const raw = pinInput.trim();
    if (!/^[0-9]+$/.test(raw)) return;
    const id = BigInt(raw);
    submit("pin", submitPinPost(api, signer, id), "Post pinned", () => setPinnedId(id));
  }, [api, signer, pinInput, submit]);

  const onUnpin = useCallback(() => {
    if (!api) return;
    submit("unpin", submitUnpinPost(api, signer), "Post unpinned", () => setPinnedId(null));
  }, [api, signer, submit]);

  const pinInputValid = /^[0-9]+$/.test(pinInput.trim());
  const ownPosts = pinInput.trim().length > 0 && !pinInputValid;

  return (
    <ComposerModal title="Edit profile" onClose={onClose}>
      <div className={styles.root}>
        <h2 className={styles.heading} tabIndex={-1} ref={headingRef}>
          Edit profile
        </h2>

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
                  maxLength={512}
                  disabled={busy}
                  autoComplete="off"
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
                  rows={3}
                  disabled={busy}
                />
                <ByteCounter value={bio} maxBytes={MAX_BIO} size="sm" />
              </div>
            </div>

            {/* Avatar URL/CID + live preview */}
            <div className={styles.field}>
              <label className={styles.label} htmlFor="ep-avatar">
                Avatar
              </label>
              <div className={styles.avatarRow}>
                <Avatar address={ss58} src={avatarSrc} size="lg" name={name} />
                <div className={styles.avatarInput}>
                  <div className={styles.inputRow}>
                    <input
                      id="ep-avatar"
                      className={styles.input}
                      value={avatar}
                      onChange={(e) => setAvatar(e.target.value)}
                      placeholder="https://… or ipfs://…"
                      maxLength={512}
                      disabled={busy}
                      autoComplete="off"
                      inputMode="url"
                    />
                    <ByteCounter value={avatar} maxBytes={MAX_AVATAR} size="sm" />
                  </div>
                  <p className={styles.hint}>A link or IPFS CID, not an upload.</p>
                </div>
              </div>
            </div>

            {/* Pinned post control */}
            <div className={styles.field}>
              <span className={styles.label}>Pinned post</span>
              {pinnedId !== null ? (
                <div className={styles.pinnedRow}>
                  <span className={styles.pinnedId}>Post #{pinnedId.toString()}</span>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={onUnpin}
                    disabled={busy}
                  >
                    {saving === "unpin" ? <Spinner size="sm" label="Unpinning" /> : "Unpin"}
                  </button>
                </div>
              ) : (
                <div className={styles.pinnedRow}>
                  <input
                    className={styles.input}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    placeholder="Post id to pin"
                    inputMode="numeric"
                    disabled={busy}
                    aria-label="Post id to pin"
                  />
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={onPin}
                    disabled={busy || !pinInputValid}
                  >
                    {saving === "pin" ? <Spinner size="sm" label="Pinning" /> : "Pin"}
                  </button>
                </div>
              )}
              {ownPosts && (
                <p className={styles.warn} aria-live="polite">
                  Enter a numeric post id.
                </p>
              )}
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
                disabled={busy}
              >
                Clear profile
              </button>
              <div className={styles.actionsRight}>
                <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={onSave}
                  disabled={!canWrite || busy || overLimit}
                >
                  {saving === "save" ? (
                    <>
                      <Spinner size="sm" label="Saving" /> Saving
                    </>
                  ) : (
                    "Save"
                  )}
                </button>
              </div>
            </div>

            {/* Clear confirm dialog */}
            {confirmClear && (
              <div className={styles.confirm} role="alertdialog" aria-label="Clear your profile?">
                <p className={styles.confirmText}>Clear your profile? Your posts stay.</p>
                <div className={styles.confirmActions}>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    onClick={() => setConfirmClear(false)}
                    disabled={saving === "clear"}
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
                    disabled={saving === "clear"}
                  >
                    {saving === "clear" ? <Spinner size="sm" label="Clearing" /> : "Clear profile"}
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
