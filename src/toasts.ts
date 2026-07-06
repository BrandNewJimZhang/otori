// Toast stack (audit r5 P1): scan reports and transient info used to
// be a self-erasing toolbar span; errors a separate bar. Info now goes
// through this one capped stack (errors stay a persistent toast — see
// Toasts.tsx). Pure list semantics here; timing/render in Toasts.tsx.

export interface Toast {
  id: number;
  text: string;
}

/** Visible ceiling: beyond it the oldest toast yields the slot. */
export const TOAST_CAP = 4;

export function pushToast(list: Toast[], toast: Toast): Toast[] {
  const next = [...list, toast];
  return next.length > TOAST_CAP ? next.slice(next.length - TOAST_CAP) : next;
}

export function dismissToast(list: Toast[], id: number): Toast[] {
  return list.filter((t) => t.id !== id);
}
