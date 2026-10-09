/**
 * Tiny router: matches method + path against the route table, enforces auth/roles, auto-seeds the DB,
 * and writes API activity to the audit log:
 *   - API_REQUEST  for every write call (POST/PUT/DELETE) and, if settings.system.logReadRequests is on, GET calls
 *   - API_FAILURE  for every failed call (4xx/5xx) including failed logins and rule violations
 */
import { routes as coreRoutes, ADMIN } from './handlers.js';
import { integrationRoutes } from './integrations.js';
import { buildDocs } from './apiDocs.js';
import { getDb } from './db.js';
import { ensureSeed } from './seed.js';
import { getUser, requireRole } from './auth.js';
import { readBody, send, HttpError } from './http.js';
import { audit } from './audit.js';
import { getRules } from './rules.js';

/** Every registered API. The documentation module is generated from this list. */
export const routes = [
    ...coreRoutes,
    ...integrationRoutes,
    ['GET', 'admin/api-docs', async () => buildDocs(routes), ADMIN],
];

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

/** Best-effort user identification for logging (never throws). */
function peekUser(req) { try { return getUser(req); } catch { return null; } }

export async function handle(req, res) {
    const started = Date.now();
    let db = null, user = null, path = '', status;
    const explorer = req.headers['x-api-explorer'] === '1';
    try {
        const url = new URL(req.url, 'http://localhost');
        // Vercel rewrite sends the sub-path as ?path=..., local dev server sends the real path
        path = url.searchParams.get('path') ?? url.pathname.replace(/^\/api\/?/, '');
        path = path.replace(/^\/+|\/+$/g, '');
        url.searchParams.delete('path');
        const query = Object.fromEntries(url.searchParams.entries());

        let found = null;
        for (const [method, pattern, fn, roles] of routes) {
            if (method !== req.method) continue;
            const params = match(pattern, path);
            if (params) { found = { fn, roles, params }; break; }
        }
        db = await getDb();
        if (!found) throw new HttpError(404, `Route not found: ${req.method} /api/${path}`);

        await ensureSeed(db); // first launch: populate KP Retail Group demo data
        if (found.roles !== null) { user = getUser(req); requireRole(user, found.roles); }
        const body = await readBody(req);
        const result = await found.fn({ db, user, params: found.params, query, body, req });

        // ---- API request logging (written before responding: serverless functions may freeze after the response) ----
        const rules = await getRules(db).catch(() => ({}));
        if (path !== 'auth/login' && (req.method !== 'GET' || rules.logReadRequests || explorer)) {
            await audit(db, user, 'API_REQUEST', 'API', `${req.method} /api/${path} → 200 (${Date.now() - started} ms)${explorer ? ' [API Explorer]' : ''}`);
        }
        send(res, 200, result);
    } catch (err) {
        status = err.status || 500;
        if (status >= 500) console.error(err);
        if (db) {
            await audit(db, user || peekUser(req), 'API_FAILURE', 'API',
                `${req.method} /api/${path} → ${status} (${Date.now() - started} ms): ${String(err.message).slice(0, 400)}${explorer ? ' [API Explorer]' : ''}`);
        }
        send(res, status, {
            error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
            ...(err.details && { details: err.details }),
        });
    }
}
