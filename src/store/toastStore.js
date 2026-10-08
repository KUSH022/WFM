/** Global toast notifications: toast.success('Saved'), toast.error('Oops'). */
import { create } from 'zustand';

export const useToasts = create((set) => ({
    toasts: [],
    push: (type, message) => {
        const id = Math.random().toString(36).slice(2);
        set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
        setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
    },
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
    success: (m) => useToasts.getState().push('success', m),
    error: (m) => useToasts.getState().push('error', m),
    info: (m) => useToasts.getState().push('info', m),
};
