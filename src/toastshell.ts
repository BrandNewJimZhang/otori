// Toast shell (audit r5 P1): state + id sequence for the capped info
// stack — scan reports, undo handles, notices. List semantics stay
// pure in toasts.ts, timing/render in ToastStack.tsx. The persistent
// error slot stays in App: it is a separate surface with one owner.

import { useCallback, useRef, useState } from "react";
import { dismissToast, pushToast, type Toast } from "./toasts";

export interface ToastShell {
  toasts: Toast[];
  /** Push a transient info toast onto the capped stack. */
  push(text: string): void;
  dismiss(id: number): void;
}

export function useToasts(): ToastShell {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback(
    (text: string) => setToasts((ts) => pushToast(ts, { id: ++seq.current, text })),
    [],
  );
  const dismiss = useCallback(
    (id: number) => setToasts((ts) => dismissToast(ts, id)),
    [],
  );
  return { toasts, push, dismiss };
}
