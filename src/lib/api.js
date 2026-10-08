/** Fetch wrapper: adds JWT, normalizes errors, logs out on 401. */
import { useAuth } from '../store/authStore';

export async function api(path, { method = 'GET', body, params } = {}) {
    const url = new URL('/api' + path, window.location.origin);
    if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
    const token = useAuth.getState().token;
    let res;
    try {
        res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new Error('Network error - please check your connection');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) useAuth.getState().logout();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}
