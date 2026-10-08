/** Local API server for development: `npm run dev:api` (reads .env). Vite proxies /api to this port. */
import http from 'node:http';
import { handle } from './router.js';

const port = process.env.API_PORT || 3001;
http.createServer((req, res) => handle(req, res)).listen(port, () => console.log(`KP WFM API running at http://localhost:${port}/api`));
