/** Auth state persisted to localStorage. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAuth = create(persist((set) => ({
    token: null,
    user: null,
    setSession: (token, user) => set({ token, user }),
    logout: () => set({ token: null, user: null }),
}), { name: 'kp-wfm-auth' }));

export const isManager = (u) => u && ['Manager', 'Administrator'].includes(u.role);
