"use client";

// ToasterProvider + useToaster — the global toast bus.
//
// The optimistic-mutation layer + components raise toasts through this imperative API: error on
// dispatch failure, the dedicated RATE-LIMIT toast on a CheckCapacity pool rejection (distinct copy,
// never the generic error), and SUCCESS sparingly (feeless social actions are SILENT on success per
// D11 — success is only for non-visible outcomes like "Address copied" / "Profile saved"). Dedupe by
// id so a burst of identical failures doesn't stack. Pending toasts are sticky (duration null) until
// replaced/dismissed.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Toaster } from "./Toaster";
import type { ToastApi, ToastKind, ToastSpec } from "../kit";
import { errorCopy } from "@/lib/chain/errors";

const ToasterContext = createContext<ToastApi | null>(null);

// Default auto-dismiss per kind (ms). Pending is sticky.
const DEFAULT_DURATION: Record<ToastKind, number | null> = {
  success: 3000,
  error: 6000,
  "rate-limit": 5000,
  info: 4000,
  pending: null,
};

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${seq}`;
}

// The rate-limit line has ONE source (lib/chain/errors.ts). It used to be written here AND in the
// chain layer, in two subtly different sentences ("You're" vs "You are"), the chain one existing only
// to be regex-matched and discarded.
export const RATE_LIMIT_COPY = errorCopy({ kind: "rate-limit" });

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: string, duration: number | null) => {
      clearTimer(id);
      if (duration == null) return;
      const handle = setTimeout(() => dismiss(id), duration);
      timers.current.set(id, handle);
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback<ToastApi["toast"]>(
    (spec) => {
      const id = spec.id ?? nextId();
      const duration = spec.duration === undefined ? DEFAULT_DURATION[spec.kind] : spec.duration;
      const full: ToastSpec = { ...spec, id, duration };
      setToasts((prev) => {
        // dedupe by id (replace in place, newest semantics)
        const without = prev.filter((t) => t.id !== id);
        // cap the stack at 3, newest on top
        return [full, ...without].slice(0, 3);
      });
      schedule(id, duration ?? null);
      return id;
    },
    [schedule],
  );

  const rateLimit = useCallback<ToastApi["rateLimit"]>(
    () => toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY }),
    [toast],
  );

  // Pause auto-dismiss on hover/focus; resume on leave.
  const pause = useCallback((id: string) => clearTimer(id), [clearTimer]);
  const resume = useCallback(
    (id: string) => {
      const t = toasts.find((x) => x.id === id);
      if (t) schedule(id, t.duration ?? null);
    },
    [toasts, schedule],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss, rateLimit }), [toast, dismiss, rateLimit]);

  return (
    <ToasterContext.Provider value={api}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToasterContext.Provider>
  );
}

/** The imperative toast bus. Throws if used outside ToasterProvider. */
export function useToaster(): ToastApi {
  const ctx = useContext(ToasterContext);
  if (!ctx) {
    throw new Error("useToaster must be used within a ToasterProvider");
  }
  return ctx;
}
