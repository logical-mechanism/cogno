"use client";

// BlockedSection — Settings "Blocked accounts": manage the device-local block list (see lib/blockStore).
// Blocking is client-only: it HARD-suppresses an account for THIS viewer on THIS device (their posts,
// replies, People/search rows, suggestions and notifications). It is not moderation of anyone else's
// content, and it cannot stop a blocked account from seeing or replying to your public posts. Block from
// the ··· menu on a post; unblock here or from the "You've blocked this account" stub.
//
// Reuses MutedSection's row styles — the two managers are the same list, one Unmute/Unblock apart.

import styles from "./MutedSection.module.css";
import { Avatar } from "@/components/Avatar";
import { Handle } from "@/components/Handle";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useBlockedList, blockActionsFor } from "@/lib/blockStore";
import { handleOf } from "@/lib/ss58";

export function BlockedSection() {
  const { viewer } = useSession();
  const me = viewer.address ?? null;
  const blocked = useBlockedList(me);

  if (blocked.length === 0) {
    return (
      <EmptyState
        title="No blocked accounts"
        description="Block an account from the ··· menu on any of its posts. Blocking is saved on this device, per account, and hides everything from them for you."
      />
    );
  }

  return (
    <div className={styles.list}>
      {blocked.map((addr) => (
        <div key={addr} className={styles.row}>
          <div className={styles.who}>
            <Avatar address={addr} size="md" name={handleOf(addr)} />
            <Handle address={addr} />
          </div>
          <button
            type="button"
            className={styles.unmute}
            onClick={() => blockActionsFor(me).unblock(addr)}
          >
            Unblock
          </button>
        </div>
      ))}
    </div>
  );
}
