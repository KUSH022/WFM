/** Fetch wrapper: adds JWT, normalizes errors (incl. rule-violation details), logs out on 401. */
import { useAuth } from '../store/authStore';

function buildUrl(path, params) {
    const url = new URL('/api' + path, window.location.origin);
    if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
    return url;
}

export async function api(path, { method = 'GET', body, params } = {}) {
    const token = useAuth.getState().token;
    let res;
    try {
        res = await fetch(buildUrl(path, params), {
            method,
            headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new Error('Network error - please check your connection');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) useAuth.getState().logout();
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.details = data.details || [];
        throw err;
    }
    return data;
}

/**
 * Raw call used by the API Explorer: never throws on HTTP errors and returns
 * { status, ok, ms, data, headers }. Sends X-Api-Explorer so calls are tagged in the audit log.
 */
export async function apiRaw(path, { method = 'GET', body, params, rawBody } = {}) {
    const token = useAuth.getState().token;
    const t0 = performance.now();
    try {
        const res = await fetch(buildUrl(path, params), {
            method,
            headers: { 'Content-Type': 'application/json', 'X-Api-Explorer': '1', ...(token && { Authorization: `Bearer ${token}` }) },
            body: method === 'GET' ? undefined : rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, ok: res.ok, ms: Math.round(performance.now() - t0), data, headers: Object.fromEntries(res.headers.entries()) };
    } catch (e) {
        return { status: 0, ok: false, ms: Math.round(performance.now() - t0), data: { error: e.message } };
    }
}
