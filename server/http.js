/** Minimal HTTP helpers that work on both Vercel functions and the local Node dev server. */
export class HttpError extends Error {
    /** @param details optional array of individual validation messages (returned to the client as `details`) */
    constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function readBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    try {
        if (req.body && typeof req.body === 'object') return req.body;
        if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    } catch { throw new HttpError(400, 'Request body is not valid JSON'); }
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Request body is not valid JSON')); } });
        req.on('error', () => resolve({}));
    });
}

export function send(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}
