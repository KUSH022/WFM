# KP Workforce Management (KP WFM)

A simplified enterprise **Workforce Management** application (in the spirit of Legion WFM / UKG Dimensions) for the fictional company **KP Retail Group**.

**Stack:** React 19 + Vite · JavaScript · Tailwind CSS · React Router · Zustand · Recharts · React Hook Form · Day.js · Vercel Serverless Functions · MongoDB Atlas (free M0)

No Docker, no Redis, no paid services, no external backend — one GitHub repo deploys everything to Vercel.

> **v1.1 – WFM rules audit:** scheduling business rules engine, Edit Mode for published schedules, schedule integrity locks,
> inbound/outbound integration APIs, API Documentation + API Explorer, and extended audit logging.
> See [`docs/WFM_RULES_AUDIT.md`](docs/WFM_RULES_AUDIT.md).

---

## Demo logins (seeded automatically)

| Role | Email | Password |
|---|---|---|
| Administrator | admin@kpwfm.com | Admin123 |
| Manager | manager@kpwfm.com | Manager123 |
| Employee | employee@kpwfm.com | Employee123 |

On the **first API request** the server detects an empty database and seeds the full KP Retail Group data set. The dashboard then shows:
Total Employees **50** · Active **47** · Locations **5** · Open Shifts **12** · Pending Time Off **8** · Labor Budget Utilization **92%** · Weekly Scheduled Hours **1,850** · Attendance Exceptions **6**.

> These numbers reflect the freshly-seeded state. They change as you use the app. Admin → System Settings → **Reset demo data** restores them.
> v1.1 does not change the seed: existing databases keep working and new rule settings fall back to defaults.

---

## Build phases → where the code lives

| Phase | Scope | Files |
|---|---|---|
| 1. Structure & database | Folder layout, Mongo connection cache, collections, auto-seed | `server/db.js`, `server/seed.js`, `server/utils.js` |
| 2. Authentication & roles | bcrypt + JWT, role guards, role-based sidebar | `server/auth.js`, `server/router.js`, `src/store/authStore.js`, `src/App.jsx`, `src/components/Layout.jsx`, `src/pages/Login.jsx` |
| 3. Employees & locations | CRUD, manager assignment, availability, skills, operating hours, department hierarchy, cost center, labor budget | `server/handlers.js`, `src/pages/Employees.jsx`, `src/pages/Locations.jsx` |
| 4. Scheduling | Weekly & daily views, drag & drop, open shifts, publish, Edit Mode, copy week, filters, rules engine | `server/rules.js`, `src/pages/Scheduling.jsx`, `src/pages/MySchedule.jsx` |
| 5. Time & attendance | Clock in/out, meal start/end, timesheets, exceptions, missing-punch tracking, manager edits | `src/pages/TimeClock.jsx`, `src/pages/Timesheets.jsx` |
| 6. Time off | Vacation / sick / personal requests, approval workflow, status tracking, cancel | `src/pages/TimeOff.jsx` |
| 7. Forecasting & budgets | 12-week daily forecast, generation logic, weekly budget vs planned vs actual, variance | `src/pages/Forecast.jsx`, `src/pages/Budget.jsx` |
| 8. Reports | Roster, schedule, attendance, labor cost, time off + CSV export, run history | `src/pages/Reports.jsx` |
| 9. Admin | Users, role permission matrix, system settings & WFM rules, organization config, audit logs, API documentation & explorer | `src/pages/Admin.jsx`, `src/pages/ApiDocs.jsx`, `server/apiDocs.js`, `server/integrations.js` |
| 10. Deployment | `vercel.json`, env vars, this README | `vercel.json`, `.env.example` |

## Folder structure

```
kp-wfm/
├── api/
│   └── index.js            # Single Vercel Serverless Function (all /api/* routes)
├── server/                 # Backend modules bundled into the function
│   ├── db.js               # Cached MongoClient (serverless-safe)
│   ├── auth.js             # bcrypt + JWT helpers, role checks
│   ├── router.js           # Route registry, auth, auto-seed, API request/failure logging
│   ├── handlers.js         # Core business logic + core route table
│   ├── rules.js            # WFM scheduling rules engine (v1.1)
│   ├── integrations.js     # Inbound / outbound integration APIs (v1.1)
│   ├── apiDocs.js          # API documentation generator (v1.1)
│   ├── seed.js             # KP Retail Group demo data generator
│   ├── audit.js            # Audit log writer
│   ├── http.js             # HttpError, body parsing, JSON responses
│   ├── utils.js            # Date / timecard / pagination helpers
│   └── dev.js              # Local API server (development only)
├── src/
│   ├── components/         # Layout, DataTable, SearchBar, Toasts, UI primitives
│   ├── hooks/useFetch.js   # Fetch hook w/ loading + error
│   ├── lib/                # api client (+ raw explorer client), formatters, CSV export
│   ├── store/              # Zustand stores (auth, toasts, lookups)
│   ├── pages/              # One file per module (incl. ApiDocs.jsx)
│   ├── App.jsx  main.jsx  index.css
├── docs/WFM_RULES_AUDIT.md
├── vercel.json  vite.config.js  tailwind.config.js  postcss.config.js
├── .env.example  package.json  index.html
```

> **Why one function?** The Vercel Hobby plan limits the number of serverless functions per deployment. All endpoints are served by `api/index.js` through a rewrite (`/api/:path*` → `/api?path=...`), which also keeps a single warm MongoDB connection — ideal for Atlas M0 connection limits.

## API reference

The full, always-current reference is generated at runtime: sign in as Administrator → **Administration → API Documentation**
(or `GET /api/admin/api-docs`). It lists every endpoint with method, purpose, request/response payloads, validation rules and examples, and includes an **API Explorer** to send live requests.

| Area | Endpoints (under `/api`) |
|---|---|
| Auth | `POST auth/login`, `GET auth/me` |
| Lookups / dashboard | `GET meta`, `GET dashboard`, `GET health` |
| Employees | `GET/POST employees`, `GET/PUT/DELETE employees/:id` |
| Locations | `GET/POST locations`, `PUT/DELETE locations/:id` |
| Scheduling | `GET/POST shifts`, `PUT/DELETE shifts/:id`, `POST shifts/:id/assign`, `POST shifts/:id/claim`, `GET schedules`, `POST schedules/publish`, `POST schedules/edit-mode`, `POST schedules/copy` |
| Timecards | `GET timecards`, `GET timecards/status`, `POST timecards/punch`, `PUT timecards/:id` |
| Time off | `GET/POST timeoff`, `PUT timeoff/:id/decision`, `DELETE timeoff/:id` |
| Forecasting / budgets | `GET forecasts`, `POST forecasts/generate`, `GET budgets`, `PUT budgets/:id` |
| Reports | `GET reports`, `GET reports/:type` |
| Admin | `admin/users`, `admin/settings`, `admin/audit`, `admin/reseed`, `GET admin/api-docs` |
| Inbound integrations | `POST integrations/inbound/{employees,locations,schedules,timecards,forecasts,labor-budgets,time-off-requests,departments,jobs,availability}` |
| Outbound integrations | `GET integrations/outbound/{same entities}` |

### WFM scheduling rules (v1.1)
Applied to every shift create, edit, open-shift assignment, employee pickup and inbound import (`server/rules.js`):
open shifts keep their date · employee active · same location · same department · required skills · availability & approved time off ·
no overlap / duplicates · max daily & weekly hours · minimum rest between shifts · max shift length · published schedules need Edit Mode ·
date/location/department/job role locked on existing shifts · labor budget warning. Thresholds: **Administration → System Settings**.

### Forecast generation logic
Weighted moving average of the same weekday over the last 4 weeks (40/30/20/10%) × growth % × promotion uplift → **traffic**. Sales = traffic × 32% conversion × $58 ticket. Labor demand = traffic × 0.105 hrs. Recommended staff = ⌈labor hrs ÷ 8⌉.

### Timecard rules
Late arrival > 7 min after scheduled start · early arrival ≥ 10 min before · missing punch = no clock-out on a past day or unfinished meal · missed meal on shifts > 6 hrs · early departure > 15 min. Managers can edit punches and mark exceptions resolved.

---

## Run locally

Prereqs: Node.js 20+, a free MongoDB Atlas cluster.

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI and JWT_SECRET
npm run dev:api               # terminal 1 – API on http://localhost:3001
npm run dev                   # terminal 2 – UI on http://localhost:5173 (proxies /api)
```

Alternative: `npm i -g vercel && vercel dev` runs UI + function exactly as in production.

---

## Deploy to Vercel (step by step)

### 1. Create the free MongoDB Atlas database
1. Sign up at https://www.mongodb.com/cloud/atlas and create an **M0 (Free)** cluster.
2. **Database Access** → Add database user (username + password, role *Read and write to any database*).
3. **Network Access** → Add IP Address → **Allow access from anywhere (`0.0.0.0/0`)**. Vercel functions use dynamic IPs, so this is required on the free tier.
4. **Connect** → *Drivers* → copy the connection string, e.g.
   `mongodb+srv://kpuser:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   (URL-encode special characters in the password.)

### 2. Push the code to GitHub
```bash
git init
git add .
git commit -m "KP WFM"
git branch -M main
git remote add origin https://github.com/<you>/kp-wfm.git
git push -u origin main
```

### 3. Import into Vercel
1. Go to https://vercel.com → **Add New… → Project** → import the GitHub repo.
2. Framework preset: **Vite** (auto-detected). Build command `npm run build`, output `dist` (already set in `vercel.json`).
3. **Environment Variables** (Production + Preview):
   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas connection string |
   | `MONGODB_DB` | `kpwfm` |
   | `JWT_SECRET` | a long random string (e.g. `openssl rand -hex 32`) |
4. Click **Deploy**.

### 4. First launch
Open the deployment URL and sign in with `admin@kpwfm.com / Admin123`. The first request seeds the database (a few seconds), then every dashboard, grid, chart and report is populated.
Health check: `https://<your-app>.vercel.app/api/health`.

### 5. Upgrading an existing v1.0 deployment
Push the v1.1 code — no migration or re-seed is required. Seeded data is preserved; new rule settings use defaults until saved in System Settings.

### Troubleshooting
| Symptom | Fix |
|---|---|
| `MONGODB_URI environment variable is not set` | Add env vars in Vercel → Settings → Environment Variables, then **Redeploy** |
| Function timeout / `MongoServerSelectionError` | Atlas Network Access must allow `0.0.0.0/0`; verify user/password |
| 404 on page refresh | Ensure `vercel.json` is in the repo root (SPA rewrite) |
| "Schedule is published. Turn on Edit Mode" (423) | Click **Enable Edit Mode** in Scheduling, make changes, then **Publish** |
| Want fresh demo data | Admin → System Settings → Reset demo data |

## Notes & production hardening
- Time-clock punches use the browser's local time (HH:mm) so store time zones stay correct regardless of the server's UTC clock.
- Passwords are bcrypt-hashed; sessions are 12-hour JWTs stored in localStorage. For production consider httpOnly cookies, rate limiting on login, and changing the demo passwords.
- Write API calls and all API failures are logged to `auditlogs`. Enable "Log read-only API requests" only when needed (Atlas M0 has 512 MB storage).
