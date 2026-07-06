// Toast stack renderer (audit r5 P1): the one notification surface.
// Info toasts self-expire; the error toast persists until dismissed
// (it is playback-critical feedback, not ambience). Enter animation
// in App.css (.toast); list semantics in toasts.ts.

import { useEffect } from "react";
import type { Toast } from "./toasts";

/** Info toasts linger this long (matches the old scan-report timer). */
const TOAST_TTL_MS = 8000;

function InfoToast({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      <button className="toast-dismiss" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function ToastStack({
  toasts,
  error,
  onDismiss,
  onDismissError,
}: {
  toasts: Toast[];
  error: string | null;
  onDismiss: (id: number) => void;
  onDismissError: () => void;
}) {
  if (toasts.length === 0 && !error) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <InfoToast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
      {error && (
        <div className="toast error" role="alert">
          <span>{error}</span>
          <button className="toast-dismiss" onClick={onDismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
