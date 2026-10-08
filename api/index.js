/**
 * Single Vercel Serverless Function that serves every /api/* route.
 * vercel.json rewrites /api/<path> -> /api?path=<path>; server/router.js dispatches it.
 */
import { handle } from '../server/router.js';

export default async function handler(req, res) {
    return handle(req, res);
}
