/** Data-fetching hook with loading / error / reload. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export function useFetch(path, params = {}, { skip = false } = {}) {
    const key = JSON.stringify(params);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(!skip);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (skip || !path) return;
        setLoading(true); setError(null);
        try { setData(await api(path, { params: JSON.parse(key) })); }
        catch (e) { setError(e.message); }
        finally { setLoading(false); }
    }, [path, key, skip]);

    useEffect(() => { load(); }, [load]);
    return { data, loading, error, reload: load, setData };
}
