/** Minimal HTTP helpers that work on both Vercel functions and the local Node dev server. */
export class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export async function readBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    try {
        if (req.body && typeof req.body === 'object') return req.body;
        if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    } catch { return {}; }
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

export function send(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}
