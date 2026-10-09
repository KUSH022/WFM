/** Global toast notifications: toast.success('Saved'), toast.error('Oops'), toast.warning('Over budget'). */
import { create } from 'zustand';

export const useToasts = create((set) => ({
    toasts: [],
    push: (type, message, ms = 4000) => {
        const id = Math.random().toString(36).slice(2);
        set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
    },
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
    success: (m) => useToasts.getState().push('success', m),
    error: (m) => useToasts.getState().push('error', m, 7000),
    info: (m) => useToasts.getState().push('info', m),
    warning: (m) => useToasts.getState().push('warning', m, 7000),
    /** Show every non-blocking rule warning returned by the API (e.g. labor budget, overtime). */
    warnings: (list = []) => list.forEach((w) => useToasts.getState().push('warning', w, 7000)),
};
