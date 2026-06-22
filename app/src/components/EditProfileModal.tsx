"use client";

// EditProfileModal — STUB (doc 01 §7.1: opens as an overlay; its standalone fallback is /settings/).
//
// The full display-name / bio / avatar / pinned editor (FEELESS + capacity-metered + optimistic under
// spec 117, D9 obsolete) is owned by surface 12 (12-surface-settings.md). The foundation ships this
// chrome + an EmptyState placeholder so the modal route + the ProfileHeader "Edit profile" affordance
// resolve to something real; the surface task replaces the body with the form. Presentational; no
// extrinsic built here.

import { ComposerModal } from "./ComposerModal";
import { EmptyState } from "./EmptyState";
import { useRouter } from "next/navigation";

export interface EditProfileModalProps {
  onClose: () => void;
}

export function EditProfileModal({ onClose }: EditProfileModalProps) {
  const router = useRouter();
  return (
    <ComposerModal title="Edit profile" onClose={onClose}>
      <EmptyState
        title="Edit your profile"
        description="Profile editing lives in Settings for now."
        action={{
          label: "Open settings",
          onClick: () => {
            onClose();
            router.push("/settings/");
          },
        }}
      />
    </ComposerModal>
  );
}

export default EditProfileModal;
