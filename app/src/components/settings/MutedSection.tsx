"use client";

// MutedSection — Settings "Muted accounts": manage the device-local mute list (see lib/muteStore).
// Muting is client-only and hides posts for THIS viewer on THIS device only — never moderation of
// anyone else's content. Mute from the ··· menu on a post; unmute here or from a revealed card.

import styles from "./MutedSection.module.css";
import { Avatar } from "@/components/Avatar";
import { Handle } from "@/components/Handle";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useMutedList, muteActionsFor } from "@/lib/muteStore";
import { handleOf } from "@/lib/ss58";

export function MutedSection() {
  const { viewer } = useSession();
  const me = viewer.address ?? null;
  const muted = useMutedList(me);

  if (muted.length === 0) {
    return (
      <EmptyState
        title="No muted accounts"
        description="Mute an account from the ··· menu on any of its posts. Muting is saved on this device, per account, and only hides their posts for you."
      />
    );
  }

  return (
    <div className={styles.list}>
      {muted.map((addr) => (
        <div key={addr} className={styles.row}>
          <div className={styles.who}>
            <Avatar address={addr} size="md" name={handleOf(addr)} />
            <Handle address={addr} />
          </div>
          <button type="button" className={styles.unmute} onClick={() => muteActionsFor(me).unmute(addr)}>
            Unmute
          </button>
        </div>
      ))}
    </div>
  );
}
