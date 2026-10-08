/** Tiny router: matches method + path against the route table, enforces auth/roles, auto-seeds the DB. */
import { routes } from './handlers.js';
import { getDb } from './db.js';
import { ensureSeed } from './seed.js';
import { getUser, requireRole } from './auth.js';
import { readBody, send, HttpError } from './http.js';

function match(pattern, path) {
    const p = pattern.split('/'), s = path.split('/');
    if (p.length !== s.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
        if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
        else if (p[i] !== s[i]) return null;
    }
    return params;
}

export async function handle(req, res) {
    try {
        const url = new URL(req.url, 'http://localhost');
        // Vercel rewrite sends the sub-path as ?path=..., local dev server sends the real path
        let path = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/?/, '');
        path = path.replace(/^\/+|\/+$/g, '');
        url.searchParams.delete('path');
        const query = Object.fromEntries(url.searchParams.entries());

        let found = null;
        for (const [method, pattern, fn, roles] of routes) {
            if (method !== req.method) continue;
            const params = match(pattern, path);
            if (params) { found = { fn, roles, params }; break; }
        }
        if (!found) throw new HttpError(404, `Route not found: ${req.method} /api/${path}`);

        const db = await getDb();
        await ensureSeed(db); // first launch: populate KP Retail Group demo data
        let user = null;
        if (found.roles !== null) { user = getUser(req); requireRole(user, found.roles); }
        const body = await readBody(req);
        const result = await found.fn({ db, user, params: found.params, query, body, req });
        send(res, 200, result);
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(err);
        send(res, status, { error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message });
    }
}
