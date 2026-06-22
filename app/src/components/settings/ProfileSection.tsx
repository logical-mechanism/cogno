"use client";

// ProfileSection — Settings §3 (doc 12). A live preview of the viewer's own profile (name / handle /
// bio / avatar) + [Edit profile] (opens EditProfileModal via the modal route) + [Clear profile]
// (confirm) + the current pinned post (resolved via source.thread(pinnedPostId).root) + [Unpin].
//
// SPEC-117: profile writes are FEELESS + capacity-metered + optimistic — there is NO funded-account
// gate (D9 obsolete). When the viewer is connected-but-unbound, the panel nudges them to finish setup
// (reusing the same bind affordance) and Edit/Clear are hidden.

import { useCallback, useEffect, useState } from "react";
import styles from "./ProfileSection.module.css";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { Handle } from "@/components/Handle";
import { PostBody } from "@/components/PostBody";
import { Spinner } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useMutation } from "@/hooks/useMutation";
import { useToaster, RATE_LIMIT_COPY } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitClearProfile, submitUnpinPost } from "@/lib/chain/mutations";
import type { CognoPost } from "@/lib/types";

function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

interface ProfilePreview {
  displayName?: string;
  bio?: string;
  avatar?: string;
  pinnedPostId?: bigint;
}

export function ProfileSection() {
  const { api, signer, source, signerCtl, identity } = useSession();
  const { run } = useMutation();
  const { toast } = useToaster();

  const ss58 = signerCtl.signer.ss58;
  const bound = identity.bound;
  const walletId = signerCtl.connectedWalletId;

  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pinnedPost, setPinnedPost] = useState<CognoPost | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [working, setWorking] = useState<null | "clear" | "unpin">(null);

  // Load the viewer's own profile (indexer path) for the preview. PAPI-direct falls back to the ss58 +
  // identicon (blank bio/avatar) — editing still works (the modal reads storage one-shot).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPinnedPost(null);
    void (async () => {
      try {
        if (source && source.caps.profiles && bound) {
          const p = await source.profile({ author: ss58 });
          if (cancelled) return;
          setPreview({
            displayName: p.displayName,
            bio: p.bio,
            avatar: p.avatar,
            pinnedPostId: p.pinnedPostId,
          });
          // Resolve the pinned post (thread().root IS the one-post resolver). Silent on 404.
          if (p.pinnedPostId != null) {
            try {
              const t = await source.thread(p.pinnedPostId);
              if (!cancelled) setPinnedPost(t.root ?? null);
            } catch {
              if (!cancelled) setPinnedPost(null);
            }
          }
        } else {
          if (!cancelled) setPreview({});
        }
      } catch {
        if (!cancelled) setPreview({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, ss58, bound]);

  const submit = useCallback(
    (kind: "clear" | "unpin", stream: ReturnType<typeof submitClearProfile>, success: string, onOk?: () => void) => {
      if (!api) return;
      setWorking(kind);
      void run(stream, {
        onConfirm: () => {
          onOk?.();
          setWorking(null);
          toast({ kind: "success", message: success });
        },
        onError: (message: string) => {
          setWorking(null);
          if (isRateLimit(message)) toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {});
    },
    [api, run, toast],
  );

  const onClear = useCallback(() => {
    if (!api) return;
    submit("clear", submitClearProfile(api, signer), "Profile cleared", () =>
      setPreview({ displayName: undefined, bio: undefined, avatar: undefined, pinnedPostId: undefined }),
    );
  }, [api, signer, submit]);

  const onUnpin = useCallback(() => {
    if (!api) return;
    submit("unpin", submitUnpinPost(api, signer), "Post unpinned", () => {
      setPinnedPost(null);
      setPreview((p) => (p ? { ...p, pinnedPostId: undefined } : p));
    });
  }, [api, signer, submit]);

  // connected-but-unbound: nudge to finish setup; Edit/Clear hidden.
  if (signerCtl.postingEnabled && bound === false) {
    return (
      <div className={styles.card}>
        <p className={styles.prompt}>Finish setting up your account to edit your profile.</p>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => walletId && identity.bind(walletId)}
          disabled={identity.binding || !walletId}
        >
          {identity.binding ? (
            <>
              <Spinner size="sm" label="Registering" /> Registering…
            </>
          ) : (
            "Finish setup"
          )}
        </button>
      </div>
    );
  }

  // not connected at all.
  if (!signerCtl.postingEnabled) {
    return (
      <div className={styles.card}>
        <p className={styles.prompt}>Connect a wallet to set up your profile.</p>
      </div>
    );
  }

  if (loading || bound === null) {
    return (
      <div className={styles.card}>
        <Skeleton variant="profileHeader" />
      </div>
    );
  }

  const p = preview ?? {};
  const bioText = p.bio?.trim() ?? "";

  return (
    <div className={styles.cards}>
      {/* Live preview */}
      <div className={styles.card}>
        <div className={styles.previewRow}>
          <Avatar address={ss58} src={p.avatar ?? null} size="lg" name={p.displayName} />
          <div className={styles.previewText}>
            <DisplayName address={ss58} displayName={p.displayName} truncate={false} />
            <Handle address={ss58} truncate="middle" />
            {bioText.length > 0 && (
              <div className={styles.bio}>
                <PostBody text={bioText} />
              </div>
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.primaryBtn} onClick={() => modalActions.openEditProfile()}>
            Edit profile
          </button>
          <button
            type="button"
            className={styles.dangerLink}
            onClick={() => setConfirmClear(true)}
            disabled={working === "clear"}
          >
            Clear profile
          </button>
        </div>

        {confirmClear && (
          <div className={styles.confirm} role="alertdialog" aria-label="Clear your profile?">
            <p className={styles.confirmText}>Clear your profile? Your posts stay.</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.outlineBtn}
                onClick={() => setConfirmClear(false)}
                disabled={working === "clear"}
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
                disabled={working === "clear"}
              >
                {working === "clear" ? <Spinner size="sm" label="Clearing" /> : "Clear profile"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Pinned post */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Pinned post</h3>
        {pinnedPost ? (
          <div className={styles.pinned}>
            <PostBody text={pinnedPost.text} dim={pinnedPost.authorRevoked} />
            <button
              type="button"
              className={styles.outlineBtn}
              onClick={onUnpin}
              disabled={working === "unpin"}
            >
              {working === "unpin" ? <Spinner size="sm" label="Unpinning" /> : "Unpin"}
            </button>
          </div>
        ) : (
          <EmptyState variant="generic" title="No pinned post" description="Pin a post from its menu to feature it here." />
        )}
      </div>
    </div>
  );
}
