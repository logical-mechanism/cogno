"use client";

// ProfileSection — Settings. A live preview of the viewer's own profile (name / handle /
// bio / avatar) + [Edit profile] (opens EditProfileModal via the modal route) + [Clear profile]
// (confirm) + the current pinned post (resolved via source.thread(pinnedPostId).root) + [Unpin].
//
// SPEC-117: profile writes are FEELESS + capacity-metered + optimistic — there is NO funded-account
// gate (D9 obsolete). When the viewer is connected-but-unbound, the panel nudges them to finish setup
// (reusing the same bind affordance) and Edit/Clear are hidden.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./ProfileSection.module.css";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { Handle } from "@/components/Handle";
import { PostBody } from "@/components/PostBody";
import { Spinner } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { useSession, useBestBlock } from "@/components/Providers";
import { useMutation } from "@/hooks/useMutation";
import { useOptimistic } from "@/hooks/useOptimistic";
import { useToaster } from "@/components/toast/ToasterProvider";
import { useActionToast } from "@/hooks/useActionToast";
import { modalActions } from "@/lib/modalStore";
import { submitClearProfile, submitUnpinPost } from "@/lib/chain/mutations";
import { useInvalidateAccountProfile } from "@/hooks/useAccountProfile";
import { invalidateHoverProfile } from "@/components/ProfileHoverCard";
import type { CognoPost } from "@/lib/types";

interface ProfilePreview {
  displayName?: string;
  bio?: string;
  avatar?: string;
  pinnedPostId?: bigint;
  /**
   * Whether a `Profile::Profiles` row exists for the viewer. Read from THAT MAP, not derived from
   * whether the presentation fields look non-empty: the runtime accepts a `set_profile` whose six
   * fields are all blank (a blank Edit-profile save, or the CLI, reaches it), and `contains_key` is
   * the exact predicate `ProfileCapacityCost` prices the call on. A field-emptiness proxy would say
   * "no profile" for a real row and leave its owner no way to remove it.
   *
   * `undefined` while unknown (loading, or the read failed) — the Clear control is only offered on a
   * definite `true`, so a transient read failure hides it rather than offering a doomed call.
   *
   * Why any of this matters: `clear_profile` is priced per account since spec 211 — free with a row
   * to clear, `UNPAYABLE` without one, so the pool refuses the doomed no-op instead of including it
   * free. Offering Clear when there is nothing to clear just bounces the user off the pool.
   */
  hasProfile?: boolean;
}

export function ProfileSection() {
  const { api, signer, source, signerCtl, identity, viewer } = useSession();
  const bestBlock = useBestBlock();
  const router = useRouter();
  const { run } = useMutation();
  const { overlay } = useOptimistic();
  const { toast } = useToaster();
  const { fail } = useActionToast();
  const invalidateAccountProfile = useInvalidateAccountProfile();

  const ss58 = signerCtl.signer.ss58;
  const bound = identity.bound;
  const walletId = signerCtl.connectedWalletId;

  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pinnedPost, setPinnedPost] = useState<CognoPost | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [working, setWorking] = useState<null | "clear" | "unpin">(null);
  // Which (account, bound) we've already shown data for — a bestBlock tick is then a SILENT refresh (no
  // skeleton, no pinned-post flash) so an edit saved elsewhere lands here on the next block.
  const loadedKey = useRef<string | null>(null);

  // Load the viewer's own profile (node-served via the seam) for the preview — display name / bio /
  // avatar / pinned. Re-reads silently each block so a save (from the Edit modal) reconciles here too.
  useEffect(() => {
    if (!(source && bound)) {
      setPreview({});
      setPinnedPost(null);
      setLoading(false);
      loadedKey.current = null;
      return;
    }
    let cancelled = false;
    const readKey = `${ss58}|${bound}`;
    const firstForKey = loadedKey.current !== readKey;
    if (firstForKey) {
      setLoading(true);
      setPinnedPost(null);
    }
    void (async () => {
      try {
        // The row check goes straight to `Profile::Profiles` — the map the runtime prices
        // `clear_profile` on. `source.profile()` returns presentation fields, which cannot tell an
        // all-blank row apart from no row at all. `undefined` if the storage read fails, so Clear is
        // hidden rather than offered on a guess.
        const [p, row] = await Promise.all([
          source.profile({ author: ss58 }),
          api
            ? api.query.Profile.Profiles.getValue(ss58).then(
                (r) => r != null,
                () => undefined,
              )
            : Promise.resolve(undefined),
        ]);
        if (cancelled) return;
        loadedKey.current = readKey;
        setPreview({
          displayName: p.displayName,
          bio: p.bio,
          avatar: p.avatar,
          pinnedPostId: p.pinnedPostId,
          hasProfile: row,
        });
        // Resolve the pinned post (thread().root IS the one-post resolver). Silent on 404.
        if (p.pinnedPostId != null) {
          try {
            const t = await source.thread(p.pinnedPostId);
            if (!cancelled) setPinnedPost(t.root ?? null);
          } catch {
            if (!cancelled) setPinnedPost(null);
          }
        } else if (!cancelled) {
          setPinnedPost(null);
        }
      } catch {
        // Only blank the preview on the initial load; a silent refresh failure keeps what's shown.
        if (!cancelled && firstForKey) setPreview({});
      } finally {
        if (!cancelled && firstForKey) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, source, ss58, bound, bestBlock]);

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
        onError: (error) => {
          setWorking(null);
          // This branch WAS a hand-rolled copy of useActionToast.fail() — the same rate-limit-vs-generic
          // split, the same toast ids — sitting behind a third copy of the isRateLimit regex. It is just
          // fail().
          fail(error);
        },
      });
    },
    [api, run, toast, fail],
  );

  const onClear = useCallback(() => {
    if (!api) return;
    // A profile write is gated on full setup (bound + stake-bound + posting power) like every other
    // write — an unfinished account is funneled to /welcome instead of firing a doomed extrinsic.
    if (!viewer.writeReady) return void router.push("/welcome/");
    submit("clear", submitClearProfile(api, signer), "Profile cleared", () => {
      setPreview((p) => ({
        displayName: undefined,
        bio: undefined,
        avatar: undefined,
        pinnedPostId: p?.pinnedPostId,
        hasProfile: false,
      }));
      // This path clears the profile WITHOUT going through ModalRouteHost, so it must drop the shared
      // caches itself — otherwise every mention chip and hover card keeps rendering the name you just
      // cleared, and only a reload fixes it. (It previously updated local state and leaned entirely on
      // useSelfProfile's per-block poll, which no other surface reads.)
      if (ss58) {
        invalidateAccountProfile(ss58);
        invalidateHoverProfile(ss58);
      }
    });
  }, [api, signer, submit, ss58, invalidateAccountProfile, viewer.writeReady, router]);

  const onUnpin = useCallback(() => {
    if (!api) return;
    if (!viewer.writeReady) return void router.push("/welcome/");
    submit("unpin", submitUnpinPost(api, signer), "Post unpinned", () => {
      setPinnedPost(null);
      setPreview((p) => (p ? { ...p, pinnedPostId: undefined } : p));
    });
  }, [api, signer, submit, viewer.writeReady, router]);

  // connected-but-unbound: nudge to finish setup; Edit/Clear hidden.
  if (signerCtl.postingEnabled && bound === false) {
    return (
      <div className={styles.card}>
        <p className={styles.prompt}>Finish setup to edit your profile.</p>
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
  // Merge the optimistic overlay so a just-saved edit (still confirming) shows instantly here too.
  const patch = overlay.profiles[ss58];
  const shown = patch
    ? {
        ...p,
        displayName: patch.displayName.trim() || undefined,
        bio: patch.bio.trim() || undefined,
        avatar: patch.avatar.trim() || undefined,
      }
    : p;
  const bioText = shown.bio?.trim() ?? "";

  return (
    <div className={styles.cards}>
      {/* Live preview */}
      <div className={styles.card}>
        <div className={styles.previewRow}>
          <Avatar address={ss58} src={shown.avatar ?? null} size="lg" name={shown.displayName} eager noRing />
          <div className={styles.previewText}>
            <DisplayName address={ss58} displayName={shown.displayName} truncate={false} />
            <Handle address={ss58} truncate="middle" />
            {bioText.length > 0 && (
              <div className={styles.bio}>
                <PostBody text={bioText} />
              </div>
            )}
          </div>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() =>
              viewer.writeReady ? modalActions.openEditProfile() : router.push("/welcome/")
            }
          >
            Edit profile
          </button>
          {/* Only offered on a CONFIRMED `Profile::Profiles` row. With none, the runtime prices the
              call unpayable and the pool rejects it, so the button would only ever bounce. `undefined`
              (unknown — the storage read failed) hides it too. */}
          {preview?.hasProfile === true && (
            <button
              type="button"
              className={styles.dangerLink}
              onClick={() => setConfirmClear(true)}
              disabled={working === "clear"}
            >
              Clear profile
            </button>
          )}
        </div>

        {confirmClear && (
          <div className={styles.confirm} role="alert">
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
          <EmptyState variant="generic" title="No pinned post" description="Pin a post from the ··· menu on it." />
        )}
      </div>
    </div>
  );
}
