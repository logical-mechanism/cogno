"use client";

// ProfileView — the client half of /u/[address]. Reads the live ss58 from useParams() and validates
// it as a plausible address; invalid → in-app not-found (NOT a hard 404). STUB: the full ProfileHeader
// + ProfileTabs is surface 07.

import { useParams } from "next/navigation";
import { StickyHeader, NotFoundInline } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

/** A base58, length-plausible ss58 (prefix-42 addresses are ~47–48 chars). */
function isPlausibleSs58(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{46,52}$/.test(value);
}

export function ProfileView() {
  const params = useParams<{ address: string }>();
  const address = params?.address ?? "";

  if (!isPlausibleSs58(address)) return <NotFoundInline kind="profile" />;

  return (
    <>
      <StickyHeader showBack title="Profile" />
      <EmptyState
        title="Profiles are coming soon"
        description={`The profile for ${address.slice(0, 8)}… lands here.`}
      />
    </>
  );
}
