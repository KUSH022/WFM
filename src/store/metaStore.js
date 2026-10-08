/** Cached lookup data (locations, employees, departments, job titles) shared across pages. */
import { create } from 'zustand';
import { api } from '../lib/api';

export const useMeta = create((set, get) => ({
    meta: null,
    loading: false,
    load: async (force = false) => {
        if ((get().meta && !force) || get().loading) return get().meta;
        set({ loading: true });
        try { const meta = await api('/meta'); set({ meta }); return meta; }
        finally { set({ loading: false }); }
    },
}));
