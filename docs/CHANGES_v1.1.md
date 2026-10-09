# KP WFM v1.1 – Change Log (WFM Rules Audit)

This document lists every file added or modified in v1.1, where it lives, and its **complete code**.
All other files are unchanged from v1.0. Seed data (`server/seed.js`) is **not** modified – the KP Retail Group demo data is preserved.

## Summary

### Added files

| File | Purpose |
|---|---|
| `server/rules.js` | Backend – WFM scheduling rules engine (all business rules in one place) |
| `server/integrations.js` | Backend – Inbound/Outbound integration APIs for 10 entities |
| `server/apiDocs.js` | Backend – API documentation generator (built from registered routes) |
| `src/pages/ApiDocs.jsx` | Frontend – Administration → API Documentation + API Explorer |
| `docs/WFM_RULES_AUDIT.md` | Docs – audit findings, corrections, rules, test checklist |

### Modified files

| File | What changed |
|---|---|
| `server/handlers.js` | Rules engine wired into scheduling; Edit Mode; open-shift assign endpoint; integrity locks; field-level audit; shift release on deactivation; settings defaults |
| `server/router.js` | Registers core + integration + api-docs routes; logs API_REQUEST / API_FAILURE |
| `server/http.js` | HttpError carries validation details[]; invalid JSON returns 400 |
| `src/pages/Scheduling.jsx` | Same-date drag rule, assign endpoint, Edit Mode toggle/lock banner, budget banner, locked fields, dept-filtered employees, required skills, rule-violation panel |
| `src/pages/Employees.jsx` | Skills field; released-shift warnings |
| `src/pages/Admin.jsx` | WFM rule settings, new audit filters (action/entity), API Documentation link |
| `src/pages/MySchedule.jsx` | Shows rule warnings after pickup |
| `src/pages/TimeOff.jsx` | Shows conflicting-shift warning after approval |
| `src/components/Layout.jsx` | New “API Documentation” menu item under Administration |
| `src/App.jsx` | Route /admin/api-docs |
| `src/lib/api.js` | Errors include details[]; new apiRaw() for the explorer |
| `src/store/toastStore.js` | warning / warnings() toasts |
| `src/components/Toasts.jsx` | Warning toast style |
| `package.json` | Version 1.1.0 |
| `README.md` | v1.1 notes, new files, API docs, upgrade notes |

### Unchanged files

`api/index.js`, `server/db.js`, `server/auth.js`, `server/utils.js`, `server/audit.js`, `server/seed.js`, `server/dev.js`, `vercel.json`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `.env.example`, `.gitignore`, `public/favicon.svg`, `src/main.jsx`, `src/index.css`, `src/lib/format.js`, `src/store/authStore.js`, `src/store/metaStore.js`, `src/hooks/useFetch.js`, `src/components/ui.jsx`, `src/components/DataTable.jsx`, `src/components/SearchBar.jsx`, `src/pages/Login.jsx`, `src/pages/Dashboard.jsx`, `src/pages/Locations.jsx`, `src/pages/TimeClock.jsx`, `src/pages/Timesheets.jsx`, `src/pages/Budget.jsx`, `src/pages/Forecast.jsx`, `src/pages/Reports.jsx`.


## Part A – New files (full code)

---

### NEW: `server/rules.js`

**Location:** `kp-wfm/server/rules.js`  
**Change:** Backend – WFM scheduling rules engine (all business rules in one place)

```javascript
/**
 * WFM business-rule engine (scheduling).
 * Central place for every rule applied when a shift is created, edited, assigned, claimed or imported:
 *   - Open shifts are bound to their date (no date change during assignment)
 *   - Employee must be active, belong to the location and department, have required skills
 *   - Availability and approved time off are respected
 *   - Overlap / duplicate prevention
 *   - Daily & weekly hour limits, minimum rest period between shifts
 *   - Published schedules require Edit Mode
 *   - Schedule integrity: date, location, department and job role never change on an existing shift
 *   - Labor budget warnings (non-blocking)
 * Rule thresholds live in settings._id = 'system' and fall back to DEFAULT_RULES, so databases
 * seeded before this audit keep working without re-seeding.
 */
import dayjs from 'dayjs';
import { HttpError } from './http.js';
import { fmt, weekStart, toMin, round2 } from './utils.js';

export const DEFAULT_RULES = {
  overtimeThresholdWeekly: 40, overtimeThresholdDaily: 10, lateGraceMinutes: 7, mealBreakAfterHours: 6, minMealMinutes: 30,
  schedulePublishLeadDays: 7, allowShiftPickup: true, sessionHours: 12,
  // --- added by WFM rules audit ---
  maxDailyHours: 10,              // hard limit of scheduled hours per employee per day
  maxWeeklyHours: 48,             // hard limit of scheduled hours per employee per week (Mon-Sun)
  minRestHours: 10,               // minimum rest between two shifts on different days
  maxShiftHours: 12,              // maximum length of a single shift
  enforceAvailability: true,      // block assignment on unavailable days / approved time off
  enforceDepartmentMatch: true,   // employee department must equal shift department
  enforceSkills: true,            // employee must have every requiredSkills entry of the shift
  requireEditModeForPublished: true,
  preventDuplicateOpenShifts: true,
  budgetWarningPct: 100,          // warn when scheduled cost exceeds this % of the weekly labor budget
  logReadRequests: false,         // also log GET API calls in the audit log (writes & failures are always logged)
};

const cache = { at: 0, rules: null };
export async function getRules(db, fresh = false) {
  if (!fresh && cache.rules && Date.now() - cache.at < 30000) return cache.rules;
  const s = await db.collection('settings').findOne({ _id: 'system' });
  cache.rules = { ...DEFAULT_RULES, ...(s || {}) };
  cache.at = Date.now();
  return cache.rules;
}
export const invalidateRules = () => { cache.rules = null; };

/** Default skills per job role (used when an employee has no explicit skills configured). */
export const JOB_SKILLS = {
  'Store Manager': ['Store Operations', 'Cash Handling', 'Key Holder', 'Scheduling'],
  'Assistant Manager': ['Store Operations', 'Cash Handling', 'Key Holder'],
  Supervisor: ['Cash Handling', 'Key Holder', 'Sales'],
  'Sales Associate': ['Sales', 'Cash Handling'],
  Optician: ['Optical Dispensing', 'Licensed Optician'],
  'Inventory Specialist': ['Inventory Control', 'Receiving'],
  'Customer Service Representative': ['Customer Service', 'Cash Handling'],
};
export const employeeSkills = (e, profiles = {}) =>
  (Array.isArray(e.skills) && e.skills.length ? e.skills : profiles?.[e.jobTitle]?.skills || JOB_SKILLS[e.jobTitle] || []);

export const toList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

/** Absolute minute span of a shift (handles overnight shifts). */
const dayNum = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
export function span(s) {
  const st = dayNum(s.date) * 1440 + toMin(s.start);
  let en = dayNum(s.date) * 1440 + toMin(s.end);
  if (en <= st) en += 1440;
  return [st, en];
}
export const shiftHours = (s) => { const [a, b] = span(s); return round2((b - a) / 60); };
const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const weekdayName = (date) => DAY[(dayjs(date).day() + 6) % 7];
export const isTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || '');
export const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && dayjs(d).isValid();

/** Fields that can never change on an existing shift. */
export const LOCKED_FIELDS = ['date', 'locationId', 'department', 'jobTitle'];
export function assertIntegrity(existing, body) {
  const changed = LOCKED_FIELDS.filter((f) => body[f] !== undefined && body[f] !== null && body[f] !== '' && body[f] !== existing[f]);
  if (changed.length) {
    const msg = changed.includes('date') && !existing.employeeId
      ? `Open shifts belong to their date: this ${weekdayName(existing.date)} shift (${existing.date}) can only be assigned on ${weekdayName(existing.date)}.`
      : `Schedule integrity: ${changed.join(', ')} cannot be changed on an existing shift. Delete it and create a new shift instead.`;
    throw new HttpError(409, msg, changed.map((f) => `${f} is locked (original: ${existing[f]})`));
  }
}

/** Published schedules can only be changed after a manager enables Edit Mode. */
export async function assertEditable(db, locationId, ws, rules) {
  if (!rules.requireEditModeForPublished) return null;
  const sc = await db.collection('schedules').findOne({ locationId, weekStart: ws });
  if (sc?.status === 'Published' && !sc.editMode)
    throw new HttpError(423, `The schedule for the week of ${ws} is published. Turn on Edit Mode before making changes.`);
  return sc;
}

/**
 * Validate a (new or changed) shift. Returns { errors, warnings, employee, hours }.
 * `ignoreId` excludes the shift being edited from overlap/limit calculations.
 */
export async function validateShift(db, s, { rules, ignoreId = null, checkDuplicates = true } = {}) {
  rules ||= await getRules(db);
  const errors = [], warnings = [];
  if (!s.locationId || !s.date || !s.start || !s.end) return { errors: ['Location, date, start and end are required'], warnings };
  if (!isDate(s.date)) errors.push('Date must be YYYY-MM-DD');
  if (!isTime(s.start) || !isTime(s.end)) errors.push('Start and end must be HH:mm (24h)');
  if (!s.department) errors.push('Department is required');
  if (!s.jobTitle) errors.push('Job role is required');
  if (errors.length) return { errors, warnings };
  const hours = shiftHours(s);
  if (hours > rules.maxShiftHours) errors.push(`Shift length ${hours}h exceeds the maximum single shift of ${rules.maxShiftHours}h`);

  const [loc, org] = await Promise.all([
    db.collection('locations').findOne({ _id: s.locationId }),
    db.collection('settings').findOne({ _id: 'organization' }),
  ]);
  if (!loc) errors.push('Location not found');
  else if (loc.status === 'Inactive') errors.push(`${loc.name} is inactive`);
  if (org?.departments && !org.departments.includes(s.department)) errors.push(`Unknown department "${s.department}"`);
  if (org?.jobTitles && !org.jobTitles.includes(s.jobTitle)) errors.push(`Unknown job role "${s.jobTitle}"`);

  const shifts = db.collection('shifts');
  const notSelf = ignoreId ? { _id: { $ne: ignoreId } } : {};

  // Duplicate open shift (same location, date, time, department and job role)
  if (!s.employeeId && checkDuplicates && rules.preventDuplicateOpenShifts) {
    const dup = await shifts.findOne({ ...notSelf, employeeId: null, locationId: s.locationId, date: s.date, start: s.start, end: s.end, department: s.department, jobTitle: s.jobTitle });
    if (dup) errors.push('Duplicate shift: an identical open shift already exists for this date, time, department and job role');
  }

  let employee = null;
  const ws = fmt(weekStart(s.date));
  if (s.employeeId) {
    employee = await db.collection('employees').findOne({ _id: s.employeeId });
    if (!employee) return { errors: [...errors, 'Employee not found'], warnings };
    const name = `${employee.firstName} ${employee.lastName}`;
    if (employee.status !== 'Active' || ['Terminated', 'On Leave'].includes(employee.employmentStatus))
      errors.push(`${name} is not active (${employee.employmentStatus || employee.status})`);
    if (employee.locationId !== s.locationId) errors.push(`${name} belongs to ${employee.locationName || 'another location'}, not ${loc?.name || 'this location'}`);
    if (rules.enforceDepartmentMatch && employee.department !== s.department) errors.push(`${name} belongs to ${employee.department}, but this shift is for ${s.department}`);
    if (employee.jobTitle !== s.jobTitle) warnings.push(`${name} is a ${employee.jobTitle}; shift job role is ${s.jobTitle}`);

    const required = toList(s.requiredSkills);
    if (rules.enforceSkills && required.length) {
      const have = employeeSkills(employee, org?.jobProfiles).map((x) => x.toLowerCase());
      const missing = required.filter((r) => !have.includes(r.toLowerCase()));
      if (missing.length) errors.push(`${name} is missing required skill(s): ${missing.join(', ')}`);
    }

    if (rules.enforceAvailability) {
      const idx = (dayjs(s.date).day() + 6) % 7;
      if (employee.availability?.[idx]?.available === false) errors.push(`${name} is not available on ${weekdayName(s.date)}s`);
      const to = await db.collection('timeoffrequests').findOne({ employeeId: employee._id, status: { $in: ['Approved', 'Pending'] }, startDate: { $lte: s.date }, endDate: { $gte: s.date } });
      if (to?.status === 'Approved') errors.push(`${name} has approved ${to.type} time off on ${s.date}`);
      if (to?.status === 'Pending') warnings.push(`${name} has a pending ${to.type} time off request on ${s.date}`);
    }

    // Employee's shifts from the day before the week to the day after (covers overlap, rest, daily & weekly limits)
    const lo = fmt(dayjs(ws).subtract(1, 'day')), hi = fmt(dayjs(ws).add(7, 'day'));
    const others = await shifts.find({ ...notSelf, employeeId: employee._id, date: { $gte: lo, $lte: hi } }).toArray();
    const [st, en] = span(s);
    let day = 0, week = 0;
    for (const o of others) {
      const [ost, oen] = span(o);
      if (o.date === s.date && o.start === s.start && o.end === s.end) errors.push(`Duplicate shift: ${name} already has ${o.start}-${o.end} on ${o.date}`);
      else if (ost < en && st < oen) errors.push(`Overlap: ${name} already works ${o.start}-${o.end} on ${o.date}`);
      else if (o.date !== s.date) {
        const gap = ost >= en ? ost - en : st - oen;
        if (gap < rules.minRestHours * 60) errors.push(`Rest period: only ${round2(gap / 60)}h between this shift and ${o.date} ${o.start}-${o.end} (minimum ${rules.minRestHours}h)`);
      }
      if (o.date === s.date) day += o.hours || 0;
      if (o.weekStart === ws) week += o.hours || 0;
    }
    if (day + hours > rules.maxDailyHours) errors.push(`Daily limit: ${round2(day + hours)}h scheduled on ${s.date} exceeds ${rules.maxDailyHours}h`);
    if (week + hours > rules.maxWeeklyHours) errors.push(`Weekly limit: ${round2(week + hours)}h scheduled this week exceeds ${rules.maxWeeklyHours}h`);
    else if (week + hours > rules.overtimeThresholdWeekly) warnings.push(`Overtime: ${name} will have ${round2(week + hours)}h this week (threshold ${rules.overtimeThresholdWeekly}h)`);
  }

  // Labor budget (warning only)
  const budget = await db.collection('laborbudgets').findOne({ locationId: s.locationId, weekStart: ws });
  if (budget?.budgetAmount) {
    const agg = await shifts.aggregate([{ $match: { ...notSelf, locationId: s.locationId, weekStart: ws, employeeId: { $ne: null } } }, { $group: { _id: null, c: { $sum: '$cost' } } }]).toArray();
    const cost = (agg[0]?.c || 0) + (employee ? hours * employee.hourlyRate : 0);
    const limit = budget.budgetAmount * (rules.budgetWarningPct / 100);
    if (cost > limit) warnings.push(`Labor budget: scheduled cost $${Math.round(cost).toLocaleString()} exceeds ${rules.budgetWarningPct}% of the weekly budget $${Math.round(budget.budgetAmount).toLocaleString()} (${Math.round((cost / budget.budgetAmount) * 100)}%)`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], employee, hours };
}

export function throwIfInvalid(v) {
  if (v.errors.length) throw new HttpError(422, v.errors.join(' • '), v.errors);
}
```

---

### NEW: `server/integrations.js`

**Location:** `kp-wfm/server/integrations.js`  
**Change:** Backend – Inbound/Outbound integration APIs for 10 entities

```javascript
/**
 * Integration APIs (Inbound = import into KP WFM, Outbound = export from KP WFM).
 *
 *   POST /api/integrations/inbound/<entity>   body: { "records": [ ... ] }   (Administrator)
 *   GET  /api/integrations/outbound/<entity>  query filters + page/limit       (Manager, Administrator)
 *
 * Records use business keys (employeeId "KP1004", location code "DTN") instead of internal ids,
 * so external HR / payroll / BI systems can integrate without knowing database ids.
 * Every inbound record goes through the same validation and WFM rules as the UI
 * (scheduling records use server/rules.js). Results are reported per record; one bad record
 * never blocks the rest of the batch.
 */
import dayjs from 'dayjs';
import { newId } from './db.js';
import { HttpError } from './http.js';
import { audit } from './audit.js';
import { fmt, weekStart, round2, calcTimecard } from './utils.js';
import { isDate, isTime, toList, employeeSkills, weekdayName } from './rules.js';
import {
  MGR, ADMIN, must, diff, normalizeEmployee, releaseFutureShifts, LOC_FIELDS,
  createShiftCore, updateShiftCore, createTimeoffCore, listBudgets,
} from './handlers.js';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_BATCH = 500;
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---------------------------------------------------------------- validation
/** Field spec: [type, required, description]. Types: string number email date time boolean array object enum:A|B department job locationCode employeeRef */
function checkRecord(def, rec, ctx) {
  const errs = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['Record must be a JSON object'];
  for (const [f, [type, req]] of Object.entries(def.fields)) {
    const v = rec[f];
    if (v === undefined || v === null || v === '') { if (req) errs.push(`${f} is required`); continue; }
    if (type === 'string' && typeof v !== 'string') errs.push(`${f} must be a string`);
    if (type === 'number' && !Number.isFinite(Number(v))) errs.push(`${f} must be a number`);
    if (type === 'number' && Number(v) < 0) errs.push(`${f} cannot be negative`);
    if (type === 'email' && !/^\S+@\S+\.\S+$/.test(v)) errs.push(`${f} must be a valid email`);
    if (type === 'date' && !isDate(v)) errs.push(`${f} must be a date YYYY-MM-DD`);
    if (type === 'time' && !isTime(v)) errs.push(`${f} must be a time HH:mm (24h)`);
    if (type === 'boolean' && typeof v !== 'boolean') errs.push(`${f} must be true or false`);
    if (type === 'array' && !Array.isArray(v) && typeof v !== 'string') errs.push(`${f} must be an array`);
    if (type === 'object' && typeof v !== 'object') errs.push(`${f} must be an object`);
    if (type.startsWith('enum:') && !type.slice(5).split('|').includes(v)) errs.push(`${f} must be one of ${type.slice(5).split('|').join(', ')}`);
    if (type === 'department' && !ctx.org.departments.includes(v)) errs.push(`${f} "${v}" is not a configured department`);
    if (type === 'job' && !ctx.org.jobTitles.includes(v)) errs.push(`${f} "${v}" is not a configured job role`);
    if (type === 'locationCode' && !ctx.loc[v]) errs.push(`${f} "${v}" does not match any location code`);
    if (type === 'employeeRef' && !ctx.emp[v]) errs.push(`${f} "${v}" does not match any employee`);
  }
  return errs;
}

async function loadCtx(db) {
  const [org, locs, emps] = await Promise.all([
    db.collection('settings').findOne({ _id: 'organization' }),
    db.collection('locations').find({}).toArray(),
    db.collection('employees').find({}).toArray(),
  ]);
  return {
    org: { departments: [], jobTitles: [], jobProfiles: {}, ...(org || {}) },
    loc: Object.fromEntries(locs.filter((l) => l.code).map((l) => [l.code, l])),
    locById: Object.fromEntries(locs.map((l) => [l._id, l])),
    emp: Object.fromEntries(emps.map((e) => [e.employeeId, e])),
    empById: Object.fromEntries(emps.map((e) => [e._id, e])),
  };
}
const paged = (records, q) => {
  const page = Math.max(1, parseInt(q.page) || 1), limit = Math.min(500, Math.max(1, parseInt(q.limit) || 100));
  return { total: records.length, page, pages: Math.max(1, Math.ceil(records.length / limit)), records: records.slice((page - 1) * limit, page * limit) };
};

// ---------------------------------------------------------------- entity definitions
export const ENTITIES = {
  employees: {
    label: 'Employees', key: 'employeeId',
    fields: {
      employeeId: ['string', true, 'Business key, e.g. KP1061'], firstName: ['string', true], lastName: ['string', true], email: ['email', true],
      phone: ['string', false], locationCode: ['locationCode', true, 'Location code, e.g. DTN'], department: ['department', true], jobTitle: ['job', true],
      hireDate: ['date', false], hourlyRate: ['number', true], employmentType: ['enum:Full-Time|Part-Time|Weekend-Only', false],
      employmentStatus: ['enum:Active|On Leave|Terminated', false], status: ['enum:Active|Inactive', false],
      managerEmployeeId: ['employeeRef', false, 'employeeId of the manager'], skills: ['array', false, 'List of skills'],
    },
    sample: { employeeId: 'KP1061', firstName: 'Alex', lastName: 'Morgan', email: 'alex.morgan@kpretail.com', phone: '(555) 410-2231', locationCode: 'DTN', department: 'Retail Sales', jobTitle: 'Sales Associate', hireDate: '2026-09-01', hourlyRate: 16.5, employmentType: 'Part-Time', status: 'Active', managerEmployeeId: 'KP1001', skills: ['Sales', 'Cash Handling'] },
    async upsert(db, user, r, ctx) {
      const body = strip({ employeeId: r.employeeId, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, locationId: ctx.loc[r.locationCode]._id,
        department: r.department, jobTitle: r.jobTitle, hireDate: r.hireDate, hourlyRate: r.hourlyRate, employmentType: r.employmentType,
        employmentStatus: r.employmentStatus, status: r.status, skills: r.skills, managerId: r.managerEmployeeId ? ctx.emp[r.managerEmployeeId]._id : undefined });
      const doc = await normalizeEmployee(db, body);
      const ex = ctx.emp[r.employeeId];
      if (ex) {
        await db.collection('employees').updateOne({ _id: ex._id }, { $set: { ...doc, updatedAt: new Date().toISOString() } });
        await audit(db, user, 'UPDATE', 'Employee', `[Inbound API] Updated ${r.employeeId}: ${diff(ex, doc, Object.keys(doc)).join('; ') || 'no changes'}`, ex._id);
        const after = { ...ex, ...doc };
        if (after.status !== 'Active' || ['Terminated', 'On Leave'].includes(after.employmentStatus)) await releaseFutureShifts(db, user, after);
        ctx.emp[r.employeeId] = after;
        return 'updated';
      }
      const e = { _id: newId(), status: 'Active', employmentStatus: 'Active', employmentType: 'Full-Time', hireDate: fmt(dayjs()),
        availability: DAY_KEYS.map((d) => ({ day: d, available: d !== 'sun' })), managerId: null, managerName: '', ...doc, createdAt: new Date().toISOString() };
      await db.collection('employees').insertOne(e);
      ctx.emp[e.employeeId] = e; ctx.empById[e._id] = e;
      await audit(db, user, 'CREATE', 'Employee', `[Inbound API] Created employee ${e.firstName} ${e.lastName} (${e.employeeId})`, e._id);
      return 'inserted';
    },
    async outbound(db, q, ctx) {
      return Object.values(ctx.emp)
        .filter((e) => (!q.locationCode || ctx.locById[e.locationId]?.code === q.locationCode) && (!q.status || e.status === q.status) && (!q.department || e.department === q.department))
        .map((e) => ({ employeeId: e.employeeId, firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone, locationCode: ctx.locById[e.locationId]?.code,
          locationName: e.locationName, department: e.department, jobTitle: e.jobTitle, hireDate: e.hireDate, hourlyRate: e.hourlyRate, employmentType: e.employmentType,
          employmentStatus: e.employmentStatus, status: e.status, managerEmployeeId: ctx.empById[e.managerId]?.employeeId || null, skills: employeeSkills(e, ctx.org.jobProfiles) }))
        .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    },
    filters: { locationCode: 'Location code', status: 'Active | Inactive', department: 'Department name' },
  },

  locations: {
    label: 'Locations', key: 'code',
    fields: {
      code: ['string', true, 'Business key, e.g. NRT'], name: ['string', true], region: ['string', false], address: ['string', false], city: ['string', false],
      phone: ['string', false], costCenter: ['string', true], status: ['enum:Active|Inactive', false], weeklyLaborBudget: ['number', false],
      operatingHours: ['object', false, '{ mon: { open, close, closed } ... }'],
    },
    sample: { code: 'NRT', name: 'KP Northgate Store', region: 'North Region', address: '9 Northgate Mall', city: 'Milwaukee, WI', phone: '(555) 300-1200', costCenter: 'CC-1004', status: 'Active', weeklyLaborBudget: 9500 },
    async upsert(db, user, r, ctx) {
      const d = {}; LOC_FIELDS.forEach((f) => r[f] !== undefined && (d[f] = r[f]));
      if (d.weeklyLaborBudget !== undefined) d.weeklyLaborBudget = Number(d.weeklyLaborBudget);
      const ex = ctx.loc[r.code];
      if (ex) {
        await db.collection('locations').updateOne({ _id: ex._id }, { $set: { ...d, updatedAt: new Date().toISOString() } });
        if (d.name) await db.collection('employees').updateMany({ locationId: ex._id }, { $set: { locationName: d.name } });
        await audit(db, user, 'UPDATE', 'Location', `[Inbound API] Updated ${r.code}: ${diff(ex, d, LOC_FIELDS).join('; ') || 'no changes'}`, ex._id);
        ctx.loc[r.code] = { ...ex, ...d };
        return 'updated';
      }
      const l = { _id: newId(), status: 'Active', baseTraffic: 450, weeklyLaborBudget: 0, departments: ctx.org.departments.map((n) => ({ name: n, parent: null })),
        operatingHours: Object.fromEntries(DAY_KEYS.map((k) => [k, { open: '08:00', close: '20:00', closed: false }])), ...d, createdAt: new Date().toISOString() };
      await db.collection('locations').insertOne(l);
      ctx.loc[l.code] = l; ctx.locById[l._id] = l;
      await audit(db, user, 'CREATE', 'Location', `[Inbound API] Created location ${l.name} (${l.code})`, l._id);
      return 'inserted';
    },
    async outbound(db, q, ctx) {
      return Object.values(ctx.locById).filter((l) => !q.region || l.region === q.region).map((l) => ({ code: l.code, name: l.name, region: l.region, address: l.address, city: l.city,
        phone: l.phone, costCenter: l.costCenter, status: l.status, weeklyLaborBudget: l.weeklyLaborBudget, operatingHours: l.operatingHours, departments: l.departments }));
    },
    filters: { region: 'North Region | South Region' },
  },

  schedules: {
    label: 'Schedules (Shifts)', key: 'externalId',
    fields: {
      externalId: ['string', false, 'Your system\'s shift id. Re-sending the same externalId updates the shift.'], locationCode: ['locationCode', true],
      date: ['date', true], start: ['time', true], end: ['time', true], department: ['department', true], jobTitle: ['job', true],
      employeeId: ['employeeRef', false, 'Leave empty to create an open shift'], requiredSkills: ['array', false], notes: ['string', false], posted: ['boolean', false, 'Post open shift for pickup'],
    },
    sample: { externalId: 'EXT-SHIFT-1001', locationCode: 'DTN', date: fmt(weekStart().add(7, 'day')), start: '10:00', end: '18:00', department: 'Retail Sales', jobTitle: 'Sales Associate', employeeId: 'KP1004', requiredSkills: ['Sales'], notes: 'Imported from legacy scheduler' },
    rules: ['All scheduling rules apply: active employee, same location & department, required skills, availability, approved time off, overlap, duplicates, daily/weekly limits, rest period',
      'Published schedules must be in Edit Mode', 'Re-sent externalId: date, location, department and job role cannot change (schedule integrity)'],
    async upsert(db, user, r, ctx) {
      const body = strip({ locationId: ctx.loc[r.locationCode]._id, date: r.date, start: r.start, end: r.end, department: r.department, jobTitle: r.jobTitle,
        employeeId: r.employeeId ? ctx.emp[r.employeeId]._id : null, requiredSkills: r.requiredSkills, notes: r.notes, posted: r.posted, externalId: r.externalId });
      const ex = r.externalId ? await db.collection('shifts').findOne({ externalId: r.externalId }) : null;
      if (ex) { const s = await updateShiftCore(db, user, ex._id, body, { source: 'Inbound API' }); return { result: 'updated', warnings: s.warnings }; }
      const s = await createShiftCore(db, user, body, { source: 'Inbound API' });
      return { result: 'inserted', warnings: s.warnings };
    },
    async outbound(db, q, ctx) {
      const ws = q.weekStart || fmt(weekStart());
      const f = { weekStart: ws };
      if (q.locationCode) f.locationId = ctx.loc[q.locationCode]?._id || '__none__';
      if (q.publishedOnly === 'true') f.published = true;
      const [shifts, scheds] = await Promise.all([db.collection('shifts').find(f).sort({ date: 1, start: 1 }).toArray(), db.collection('schedules').find({ weekStart: ws }).toArray()]);
      return shifts.map((s) => ({ shiftId: s._id, externalId: s.externalId || null, locationCode: ctx.locById[s.locationId]?.code, date: s.date, weekday: weekdayName(s.date),
        start: s.start, end: s.end, hours: s.hours, department: s.department, jobTitle: s.jobTitle, employeeId: ctx.empById[s.employeeId]?.employeeId || null,
        employeeName: s.employeeName || null, openShift: !s.employeeId, posted: !!s.posted, published: !!s.published, overtime: !!s.overtime,
        requiredSkills: s.requiredSkills || [], cost: s.cost, scheduleStatus: scheds.find((x) => x.locationId === s.locationId)?.status || 'Draft' }));
    },
    filters: { weekStart: 'Monday YYYY-MM-DD (default current week)', locationCode: 'Location code', publishedOnly: 'true | false' },
  },

  timecards: {
    label: 'Timecards', key: 'employeeId + date',
    fields: { employeeId: ['employeeRef', true], date: ['date', true], clockIn: ['time', true], mealStart: ['time', false], mealEnd: ['time', false], clockOut: ['time', false], notes: ['string', false] },
    sample: { employeeId: 'KP1004', date: fmt(dayjs().subtract(1, 'day')), clockIn: '08:02', mealStart: '12:00', mealEnd: '12:30', clockOut: '16:05', notes: 'Imported from badge reader' },
    rules: ['mealEnd requires mealStart', 'Dates in the future are rejected', 'Exceptions (late, missing punch, missed meal, early departure) are recalculated'],
    async upsert(db, user, r, ctx) {
      must(r.date <= fmt(dayjs()), 400, 'Timecards cannot be imported for future dates');
      must(!r.mealEnd || r.mealStart, 400, 'mealEnd requires mealStart');
      const emp = ctx.emp[r.employeeId];
      const [ex, shift] = await Promise.all([db.collection('timecards').findOne({ employeeId: emp._id, date: r.date }), db.collection('shifts').findOne({ employeeId: emp._id, date: r.date })]);
      let card = { ...(ex || { _id: newId(), employeeId: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, locationId: emp.locationId, date: r.date, rate: emp.hourlyRate, exceptions: [], resolved: false }),
        shiftId: shift?._id || null, scheduledStart: shift?.start || null, scheduledEnd: shift?.end || null,
        clockIn: r.clockIn, mealStart: r.mealStart || null, mealEnd: r.mealEnd || null, clockOut: r.clockOut || null, notes: r.notes || ex?.notes || '' };
      card = calcTimecard(card); card.cost = round2(card.totalHours * card.rate);
      await db.collection('timecards').replaceOne({ _id: card._id }, card, { upsert: true });
      await audit(db, user, ex ? 'UPDATE' : 'CREATE', 'Timecard', `[Inbound API] ${ex ? 'Updated' : 'Created'} timecard ${r.employeeId} ${r.date}${card.exceptions.length ? ' – exceptions: ' + card.exceptions.join(', ') : ''}`, card._id);
      return ex ? 'updated' : 'inserted';
    },
    async outbound(db, q, ctx) {
      const f = { date: { $gte: q.from || fmt(dayjs().subtract(14, 'day')), $lte: q.to || fmt(dayjs()) } };
      if (q.locationCode) f.locationId = ctx.loc[q.locationCode]?._id || '__none__';
      if (q.employeeId) f.employeeId = ctx.emp[q.employeeId]?._id || '__none__';
      if (q.exceptionsOnly === 'true') f['exceptions.0'] = { $exists: true };
      return (await db.collection('timecards').find(f).sort({ date: -1 }).toArray()).map((t) => ({ employeeId: ctx.empById[t.employeeId]?.employeeId, employeeName: t.employeeName,
        locationCode: ctx.locById[t.locationId]?.code, date: t.date, scheduledStart: t.scheduledStart, scheduledEnd: t.scheduledEnd, clockIn: t.clockIn, mealStart: t.mealStart,
        mealEnd: t.mealEnd, clockOut: t.clockOut, totalHours: t.totalHours, cost: t.cost, exceptions: t.exceptions, earlyArrival: !!t.earlyArrival, resolved: !!t.resolved }));
    },
    filters: { from: 'YYYY-MM-DD (default today-14)', to: 'YYYY-MM-DD (default today)', locationCode: 'Location code', employeeId: 'Employee id', exceptionsOnly: 'true | false' },
  },

  forecasts: {
    label: 'Forecasts', key: 'locationCode + date',
    fields: { locationCode: ['locationCode', true], date: ['date', true], customerTraffic: ['number', true], salesProjection: ['number', false], laborDemandHours: ['number', true] },
    sample: { locationCode: 'DTN', date: fmt(weekStart().add(14, 'day')), customerTraffic: 610, salesProjection: 11300, laborDemandHours: 64 },
    rules: ['recommendedStaff is calculated as ceil(laborDemandHours / 8)', 'salesProjection defaults to traffic x 32% x $58'],
    async upsert(db, user, r, ctx) {
      const loc = ctx.loc[r.locationCode];
      const traffic = Math.round(Number(r.customerTraffic)), labor = round2(Number(r.laborDemandHours));
      const doc = { locationId: loc._id, date: r.date, weekStart: fmt(weekStart(r.date)), dayOfWeek: dayjs(r.date).format('ddd').toLowerCase(), customerTraffic: traffic,
        salesProjection: r.salesProjection !== undefined ? Number(r.salesProjection) : Math.round(traffic * 0.32 * 58), laborDemandHours: labor,
        recommendedStaff: Math.ceil(labor / 8), method: 'Inbound API', createdAt: new Date().toISOString() };
      const res = await db.collection('forecasts').updateOne({ locationId: loc._id, date: r.date }, { $set: doc, $setOnInsert: { _id: newId() } }, { upsert: true });
      return res.upsertedCount ? 'inserted' : 'updated';
    },
    async outbound(db, q, ctx) {
      const f = { date: { $gte: q.from || fmt(weekStart()), $lte: q.to || fmt(weekStart().add(6, 'day')) } };
      if (q.locationCode) f.locationId = ctx.loc[q.locationCode]?._id || '__none__';
      return (await db.collection('forecasts').find(f).sort({ date: 1 }).toArray()).map((x) => ({ locationCode: ctx.locById[x.locationId]?.code, date: x.date, weekStart: x.weekStart,
        customerTraffic: x.customerTraffic, salesProjection: x.salesProjection, laborDemandHours: x.laborDemandHours, recommendedStaff: x.recommendedStaff, method: x.method }));
    },
    filters: { from: 'YYYY-MM-DD (default current Monday)', to: 'YYYY-MM-DD (default current Sunday)', locationCode: 'Location code' },
  },

  'labor-budgets': {
    label: 'Labor Budgets', key: 'locationCode + weekStart',
    fields: { locationCode: ['locationCode', true], weekStart: ['date', true, 'Must be a Monday'], budgetHours: ['number', true], budgetAmount: ['number', true], notes: ['string', false] },
    sample: { locationCode: 'DTN', weekStart: fmt(weekStart().add(7, 'day')), budgetHours: 420, budgetAmount: 9200, notes: 'FY26 plan' },
    rules: ['weekStart must be a Monday', 'Current-week budgetAmount also updates the location weekly labor budget'],
    async upsert(db, user, r, ctx) {
      must(fmt(weekStart(r.weekStart)) === r.weekStart, 400, 'weekStart must be a Monday');
      const loc = ctx.loc[r.locationCode];
      const set = { locationName: loc.name, budgetHours: Number(r.budgetHours), budgetAmount: Number(r.budgetAmount), ...(r.notes !== undefined && { notes: r.notes }) };
      const res = await db.collection('laborbudgets').updateOne({ locationId: loc._id, weekStart: r.weekStart }, { $set: set,
        $setOnInsert: { _id: newId(), plannedHours: 0, plannedCost: 0, actualHours: null, actualCost: null } }, { upsert: true });
      if (r.weekStart === fmt(weekStart())) await db.collection('locations').updateOne({ _id: loc._id }, { $set: { weeklyLaborBudget: set.budgetAmount } });
      await audit(db, user, 'UPDATE', 'Labor Budget', `[Inbound API] ${res.upsertedCount ? 'Created' : 'Updated'} budget ${r.locationCode} week ${r.weekStart}: ${set.budgetHours}h / $${set.budgetAmount}`);
      return res.upsertedCount ? 'inserted' : 'updated';
    },
    async outbound(db, q, ctx) {
      const rows = await listBudgets({ db, query: q.locationCode ? { locationId: ctx.loc[q.locationCode]?._id || '__none__' } : {} });
      return rows.filter((b) => (!q.from || b.weekStart >= q.from) && (!q.to || b.weekStart <= q.to)).map((b) => ({ locationCode: ctx.locById[b.locationId]?.code, weekStart: b.weekStart,
        budgetHours: b.budgetHours, budgetAmount: b.budgetAmount, plannedHours: b.plannedHours, plannedCost: b.plannedCost, actualHours: b.actualHours, actualCost: b.actualCost,
        hoursVariance: b.hoursVariance, costVariance: b.costVariance, utilization: b.utilization }));
    },
    filters: { locationCode: 'Location code', from: 'weekStart from', to: 'weekStart to' },
  },

  'time-off-requests': {
    label: 'Time Off Requests', key: 'externalId',
    fields: { externalId: ['string', false, 'Your system\'s request id'], employeeId: ['employeeRef', true], type: ['enum:Vacation|Sick|Personal', true],
      startDate: ['date', true], endDate: ['date', true], reason: ['string', false], status: ['enum:Pending|Approved|Rejected', false, 'Default Pending'] },
    sample: { externalId: 'HR-LV-5521', employeeId: 'KP1004', type: 'Vacation', startDate: fmt(dayjs().add(30, 'day')), endDate: fmt(dayjs().add(32, 'day')), reason: 'Family trip', status: 'Pending' },
    rules: ['endDate >= startDate', 'No overlap with another Pending/Approved request', 'Re-sent externalId may only change status of a Pending request'],
    async upsert(db, user, r, ctx) {
      must(r.endDate >= r.startDate, 400, 'endDate must be on or after startDate');
      const ex = r.externalId ? await db.collection('timeoffrequests').findOne({ externalId: r.externalId }) : null;
      const decide = async (t) => {
        if (!r.status || r.status === 'Pending' || r.status === t.status) return;
        must(t.status === 'Pending', 409, `Request ${r.externalId} is already ${t.status}`);
        await db.collection('timeoffrequests').updateOne({ _id: t._id }, { $set: { status: r.status, decidedAt: new Date().toISOString(), decidedBy: 'Inbound API', comment: 'Decision imported' } });
        await audit(db, user, r.status === 'Approved' ? 'APPROVE' : 'REJECT', 'Time Off', `[Inbound API] ${r.status} ${t.type} request for ${t.employeeName}`, t._id);
      };
      if (ex) { await decide(ex); return 'updated'; }
      const t = await createTimeoffCore(db, user, ctx.emp[r.employeeId]._id, r);
      await decide(t);
      return 'inserted';
    },
    async outbound(db, q, ctx) {
      const f = {};
      if (q.status) f.status = q.status;
      if (q.from) f.endDate = { $gte: q.from };
      if (q.to) f.startDate = { $lte: q.to };
      if (q.employeeId) f.employeeId = ctx.emp[q.employeeId]?._id || '__none__';
      return (await db.collection('timeoffrequests').find(f).sort({ startDate: -1 }).toArray()).map((t) => ({ requestId: t._id, externalId: t.externalId || null,
        employeeId: ctx.empById[t.employeeId]?.employeeId, employeeName: t.employeeName, locationCode: ctx.locById[t.locationId]?.code, type: t.type, startDate: t.startDate,
        endDate: t.endDate, days: t.days, hours: t.hours, reason: t.reason, status: t.status, submittedAt: t.submittedAt, decidedAt: t.decidedAt, decidedBy: t.decidedBy }));
    },
    filters: { status: 'Pending | Approved | Rejected | Cancelled', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', employeeId: 'Employee id' },
  },

  departments: {
    label: 'Departments', key: 'name',
    fields: { name: ['string', true], parent: ['string', false, 'Parent department in the location hierarchy'], locationCodes: ['array', false, 'Add to these locations\' hierarchy'] },
    sample: { name: 'Eyewear Repair', parent: 'Optical Services', locationCodes: ['DTN', 'UPT'] },
    rules: ['Name cannot contain "."', 'Unknown locationCodes are rejected'],
    async upsert(db, user, r, ctx) {
      must(!r.name.includes('.'), 400, 'Department name cannot contain "."');
      const codes = toList(r.locationCodes);
      const bad = codes.filter((c) => !ctx.loc[c]); must(!bad.length, 400, `Unknown location code(s): ${bad.join(', ')}`);
      const isNew = !ctx.org.departments.includes(r.name);
      if (isNew) { await db.collection('settings').updateOne({ _id: 'organization' }, { $addToSet: { departments: r.name } }); ctx.org.departments.push(r.name); }
      for (const c of codes) {
        const loc = ctx.loc[c];
        const deps = (loc.departments || []).filter((d) => d.name !== r.name).concat({ name: r.name, parent: r.parent || null });
        await db.collection('locations').updateOne({ _id: loc._id }, { $set: { departments: deps } });
        loc.departments = deps;
      }
      await audit(db, user, isNew ? 'CREATE' : 'UPDATE', 'Department', `[Inbound API] ${isNew ? 'Created' : 'Updated'} department ${r.name}${codes.length ? ' at ' + codes.join(', ') : ''}`);
      return isNew ? 'inserted' : 'updated';
    },
    async outbound(db, q, ctx) {
      const emps = Object.values(ctx.empById);
      return ctx.org.departments.map((name) => ({ name, activeHeadcount: emps.filter((e) => e.department === name && e.status === 'Active').length,
        locations: Object.values(ctx.locById).filter((l) => (l.departments || []).some((d) => d.name === name)).map((l) => ({ code: l.code, parent: l.departments.find((d) => d.name === name).parent })) }));
    },
    filters: {},
  },

  jobs: {
    label: 'Jobs', key: 'title',
    fields: { title: ['string', true], department: ['department', false, 'Default department'], skills: ['array', false, 'Default skills for this job role'], defaultRate: ['number', false] },
    sample: { title: 'Visual Merchandiser', department: 'Retail Sales', skills: ['Visual Merchandising', 'Sales'], defaultRate: 18.25 },
    rules: ['Title cannot contain "."', 'Skills become the default skills of employees with this job and no explicit skills'],
    async upsert(db, user, r, ctx) {
      must(!r.title.includes('.'), 400, 'Job title cannot contain "."');
      const isNew = !ctx.org.jobTitles.includes(r.title);
      const profile = strip({ department: r.department, skills: r.skills !== undefined ? toList(r.skills) : undefined, defaultRate: r.defaultRate !== undefined ? Number(r.defaultRate) : undefined });
      await db.collection('settings').updateOne({ _id: 'organization' }, { $addToSet: { jobTitles: r.title }, $set: { [`jobProfiles.${r.title}`]: { ...(ctx.org.jobProfiles?.[r.title] || {}), ...profile } } });
      if (isNew) ctx.org.jobTitles.push(r.title);
      await audit(db, user, isNew ? 'CREATE' : 'UPDATE', 'Job', `[Inbound API] ${isNew ? 'Created' : 'Updated'} job role ${r.title}`);
      return isNew ? 'inserted' : 'updated';
    },
    async outbound(db, q, ctx) {
      const emps = Object.values(ctx.empById);
      return ctx.org.jobTitles.map((title) => ({ title, ...(ctx.org.jobProfiles?.[title] || {}), skills: employeeSkills({ jobTitle: title }, ctx.org.jobProfiles),
        activeHeadcount: emps.filter((e) => e.jobTitle === title && e.status === 'Active').length }));
    },
    filters: {},
  },

  availability: {
    label: 'Availability', key: 'employeeId',
    fields: { employeeId: ['employeeRef', true], availability: ['array', true, '[{ "day": "mon", "available": true }, ...] - partial lists are merged'] },
    sample: { employeeId: 'KP1004', availability: [{ day: 'sat', available: false }, { day: 'sun', available: true }] },
    rules: ['day must be mon..sun', 'available must be boolean', 'Existing shifts are not changed; future assignments are validated against the new availability'],
    async upsert(db, user, r, ctx) {
      must(Array.isArray(r.availability), 400, 'availability must be an array');
      for (const a of r.availability) {
        must(DAY_KEYS.includes(a?.day), 400, `Invalid day "${a?.day}" (use mon..sun)`);
        must(typeof a.available === 'boolean', 400, `available for ${a.day} must be true or false`);
      }
      const emp = ctx.emp[r.employeeId];
      const cur = Object.fromEntries((emp.availability || DAY_KEYS.map((d) => ({ day: d, available: true }))).map((a) => [a.day, a.available]));
      r.availability.forEach((a) => { cur[a.day] = a.available; });
      const next = DAY_KEYS.map((d) => ({ day: d, available: !!cur[d] }));
      await db.collection('employees').updateOne({ _id: emp._id }, { $set: { availability: next, updatedAt: new Date().toISOString() } });
      await audit(db, user, 'UPDATE', 'Employee', `[Inbound API] Availability ${r.employeeId}: ${diff(emp, { availability: next }, ['availability']).join('; ') || 'no changes'}`, emp._id);
      emp.availability = next;
      return 'updated';
    },
    async outbound(db, q, ctx) {
      return Object.values(ctx.empById).filter((e) => e.status === 'Active' && (!q.locationCode || ctx.locById[e.locationId]?.code === q.locationCode))
        .map((e) => ({ employeeId: e.employeeId, employeeName: `${e.firstName} ${e.lastName}`, locationCode: ctx.locById[e.locationId]?.code, employmentType: e.employmentType,
          availability: e.availability, availableDays: (e.availability || []).filter((a) => a.available).map((a) => a.day) }));
    },
    filters: { locationCode: 'Location code' },
  },
};

// ---------------------------------------------------------------- handlers
function inbound(key) {
  const def = ENTITIES[key];
  return async ({ db, user, body }) => {
    const records = Array.isArray(body) ? body : body.records;
    must(Array.isArray(records), 400, 'Body must be { "records": [ ... ] }');
    must(records.length > 0, 400, 'records cannot be empty');
    must(records.length <= MAX_BATCH, 413, `Maximum ${MAX_BATCH} records per request`);
    const ctx = await loadCtx(db);
    const out = { entity: key, received: records.length, inserted: 0, updated: 0, failed: 0, errors: [], warnings: [] };
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const keyVal = def.key.split(' + ').map((k) => rec?.[k]).filter(Boolean).join(' / ') || `#${i}`;
      const errs = checkRecord(def, rec, ctx);
      if (errs.length) { out.failed++; out.errors.push({ index: i, key: keyVal, errors: errs }); continue; }
      try {
        const r = await def.upsert(db, user, rec, ctx);
        const result = typeof r === 'string' ? r : r.result;
        out[result]++;
        if (r?.warnings?.length) out.warnings.push({ index: i, key: keyVal, warnings: r.warnings });
      } catch (e) {
        out.failed++;
        out.errors.push({ index: i, key: keyVal, errors: e.details || [e.message] });
      }
    }
    await audit(db, user, out.failed ? 'INBOUND_PARTIAL' : 'INBOUND', 'Integration', `Inbound ${def.label}: ${out.received} received, ${out.inserted} inserted, ${out.updated} updated, ${out.failed} failed`);
    return out;
  };
}
function outbound(key) {
  const def = ENTITIES[key];
  return async ({ db, query }) => {
    const ctx = await loadCtx(db);
    const all = await def.outbound(db, query, ctx);
    return { entity: key, generatedAt: new Date().toISOString(), ...paged(all, query) };
  };
}

/** Auto-generated documentation for every integration route. */
function docFor(key, dir) {
  const def = ENTITIES[key];
  const fieldRules = Object.entries(def.fields).map(([f, [type, req, desc]]) => `${f}: ${type}${req ? ' (required)' : ''}${desc ? ' – ' + desc : ''}`);
  if (dir === 'inbound') {
    return {
      group: 'Inbound Integrations', purpose: `Create or update ${def.label} in bulk from an external system (upsert by ${def.key}).`,
      request: { records: [`${def.label} record`, '... up to 500'], fields: Object.fromEntries(Object.entries(def.fields).map(([f, [t, r]]) => [f, `${t}${r ? ' *' : ''}`])) },
      response: { entity: 'string', received: 'number', inserted: 'number', updated: 'number', failed: 'number', errors: '[{ index, key, errors[] }]', warnings: '[{ index, key, warnings[] }]' },
      rules: ['Body must be { records: [...] } with 1-500 records', 'Each record is validated independently; failures are reported per record', ...fieldRules, ...(def.rules || [])],
      exampleRequest: { body: { records: [def.sample] } },
      exampleResponse: { entity: key, received: 1, inserted: 1, updated: 0, failed: 0, errors: [], warnings: [] },
    };
  }
  return {
    group: 'Outbound Integrations', purpose: `Export ${def.label} using business keys for HR, payroll, BI or downstream systems.`,
    request: { query: { ...def.filters, page: 'number (default 1)', limit: 'number 1-500 (default 100)' } },
    response: { entity: 'string', generatedAt: 'ISO datetime', total: 'number', page: 'number', pages: 'number', records: `[${def.label} record]` },
    rules: ['Read-only', 'Manager or Administrator role required', ...Object.entries(def.filters).map(([k, v]) => `Filter ${k}: ${v}`)],
    exampleRequest: { query: { page: 1, limit: 2 } },
    exampleResponse: { entity: key, generatedAt: '2026-10-08T06:00:00.000Z', total: 1, page: 1, pages: 1, records: [Object.fromEntries(Object.entries(def.sample).slice(0, 8))] },
  };
}

export const integrationRoutes = Object.keys(ENTITIES).flatMap((key) => [
  ['POST', `integrations/inbound/${key}`, inbound(key), ADMIN, docFor(key, 'inbound')],
  ['GET', `integrations/outbound/${key}`, outbound(key), MGR, docFor(key, 'outbound')],
]);
```

---

### NEW: `server/apiDocs.js`

**Location:** `kp-wfm/server/apiDocs.js`  
**Change:** Backend – API documentation generator (built from registered routes)

```javascript
/**
 * API documentation generator.
 * GET /api/admin/api-docs walks the *registered* route table at runtime (server/router.js passes it in),
 * so every endpoint that exists is documented automatically. Rich descriptions come from CORE_DOCS
 * (core routes) or from the 5th element of a route tuple (integration routes generate their own docs).
 * Routes without a description still appear with method, path and roles.
 */
const ID = 'string (24-char id)';
const PAGE = { items: '[...]', total: 'number', page: 'number', pages: 'number' };
const WEEK = '2026-10-05';

export const CORE_DOCS = {
  'GET health': { group: 'System', purpose: 'Database connectivity health check.', response: { ok: 'boolean', time: 'ISO datetime' }, exampleResponse: { ok: true, time: '2026-10-08T06:00:00.000Z' } },
  'POST auth/login': { group: 'Authentication', purpose: 'Sign in with email/password and receive a JWT (12h).',
    request: { email: 'string *', password: 'string *' }, response: { token: 'JWT', user: '{ _id, email, name, role, employeeId }' },
    rules: ['Email is case-insensitive', 'Disabled accounts receive 403', 'Wrong credentials receive 401 (logged as API_FAILURE)'],
    exampleRequest: { body: { email: 'manager@kpwfm.com', password: 'Manager123' } },
    exampleResponse: { token: 'eyJhbGciOi...', user: { _id: 'usr-manager', email: 'manager@kpwfm.com', name: 'James Anderson', role: 'Manager', employeeId: 'emp-001' } } },
  'GET auth/me': { group: 'Authentication', purpose: 'Current user profile and linked employee record.', response: { user: 'object', employee: 'object | null' } },
  'GET meta': { group: 'System', purpose: 'Lookup data: locations, employees, departments, job roles, skills, managers and active WFM rules.',
    response: { locations: '[]', employees: '[]', departments: '[string]', jobTitles: '[string]', skills: '[string]', managers: '[]', rules: 'object' } },
  'GET dashboard': { group: 'Dashboard', purpose: 'Workforce KPIs, staffing overview and trends (personal dashboard for Employees).',
    response: { cards: '{ totalEmployees, activeEmployees, locations, openShifts, pendingTimeOff, attendanceExceptions, scheduledHours, laborCost, laborBudget, budgetUtilization }', staffing: '[]', laborTrend: '[]' } },

  'GET employees': { group: 'Employees', purpose: 'Search and page employees.', request: { query: { q: 'text', locationId: ID, department: 'string', status: 'Active|Inactive', employmentType: 'string', page: 'number', limit: 'number' } },
    response: PAGE, exampleRequest: { query: { q: 'garcia', page: 1, limit: 5 } } },
  'POST employees': { group: 'Employees', purpose: 'Create an employee.',
    request: { firstName: 'string *', lastName: 'string *', email: 'string *', locationId: `${ID} *`, department: 'string', jobTitle: 'string', hourlyRate: 'number', employmentType: 'Full-Time|Part-Time|Weekend-Only', managerId: ID, skills: '[string]', availability: '[{ day, available }]' },
    rules: ['firstName, lastName, email, locationId required', 'employeeId must be unique (auto KPxxxx when omitted)', 'hourlyRate > 0', 'Audited as CREATE Employee'],
    exampleRequest: { body: { firstName: 'Alex', lastName: 'Morgan', email: 'alex.morgan@kpretail.com', locationId: 'loc-dtn', department: 'Retail Sales', jobTitle: 'Sales Associate', hourlyRate: 16.5, skills: ['Sales'] } } },
  'GET employees/:id': { group: 'Employees', purpose: 'Get one employee (employees can only read their own record).', exampleRequest: { params: { id: 'emp-004' } } },
  'PUT employees/:id': { group: 'Employees', purpose: 'Update an employee (partial).', request: { '...': 'any POST field', status: 'Active|Inactive', employmentStatus: 'Active|On Leave|Terminated' },
    rules: ['Field-level changes are written to the audit log (before → after)', 'Inactive / On Leave / Terminated employees have their future shifts released to open shifts'],
    exampleRequest: { params: { id: 'emp-004' }, body: { hourlyRate: 17.25, skills: ['Sales', 'Cash Handling', 'Key Holder'] } } },
  'DELETE employees/:id': { group: 'Employees', purpose: 'Deactivate an employee (soft delete).', rules: ['History is preserved', 'Future shifts are released to open shifts'], exampleRequest: { params: { id: 'emp-050' } } },

  'GET locations': { group: 'Locations', purpose: 'List locations with active headcount.' },
  'POST locations': { group: 'Locations', purpose: 'Create a location.', request: { name: 'string *', costCenter: 'string *', code: 'string (unique)', region: 'string', operatingHours: 'object', departments: '[{ name, parent }]', weeklyLaborBudget: 'number' },
    rules: ['name and costCenter required', 'code must be unique'], exampleRequest: { body: { name: 'KP Northgate Store', code: 'NRT', costCenter: 'CC-1004', region: 'North Region', weeklyLaborBudget: 9500 } } },
  'PUT locations/:id': { group: 'Locations', purpose: 'Update a location.', rules: ['Changes are audited field by field', 'weeklyLaborBudget also updates the current week budget'],
    exampleRequest: { params: { id: 'loc-dtn' }, body: { phone: '(555) 777-1000' } } },
  'DELETE locations/:id': { group: 'Locations', purpose: 'Delete a location (Administrator).', rules: ['Rejected with 409 while active employees are assigned'] },

  'GET shifts': { group: 'Schedules', purpose: 'Shifts for a week (employees see only their own published shifts and posted open shifts).',
    request: { query: { weekStart: 'YYYY-MM-DD Monday', locationId: ID, department: 'string', date: 'YYYY-MM-DD', employeeId: ID } }, exampleRequest: { query: { weekStart: WEEK, locationId: 'loc-dtn' } } },
  'POST shifts': { group: 'Schedules', purpose: 'Create a shift (assigned or open).',
    request: { locationId: `${ID} *`, date: 'YYYY-MM-DD *', start: 'HH:mm *', end: 'HH:mm *', department: 'string *', jobTitle: 'string *', employeeId: `${ID} | null`, requiredSkills: '[string]', posted: 'boolean', notes: 'string' },
    response: { '...shift': 'object', warnings: '[string] e.g. labor budget / overtime' },
    rules: ['Published schedule requires Edit Mode (423)', 'Employee must be active, in the same location and department', 'Required skills must be present',
      'Availability & approved time off are checked', 'No overlapping or duplicate shifts', 'Daily / weekly hour limits and minimum rest period', 'Max single shift length',
      'Duplicate identical open shifts are blocked', 'Labor budget overrun returns a warning (not an error)', 'Violations return 422 with details[]'],
    exampleRequest: { body: { locationId: 'loc-ctr', date: WEEK, start: '10:00', end: '18:00', department: 'Retail Sales', jobTitle: 'Sales Associate', employeeId: null, posted: true } },
    exampleResponse: { _id: '6f1c...', date: WEEK, start: '10:00', end: '18:00', employeeId: null, hours: 8, published: false, warnings: [] } },
  'PUT shifts/:id': { group: 'Schedules', purpose: 'Edit a shift: times, employee, required skills, notes.',
    request: { start: 'HH:mm', end: 'HH:mm', employeeId: `${ID} | null`, requiredSkills: '[string]', notes: 'string', posted: 'boolean' },
    rules: ['Schedule integrity: date, locationId, department and jobTitle are locked (409 if changed)', 'All assignment rules re-run when employee, times or skills change', 'Edit Mode required on published schedules', 'Before → after audit trail'],
    exampleRequest: { params: { id: '<shiftId>' }, body: { start: '09:00', end: '17:00' } } },
  'POST shifts/:id/assign': { group: 'Schedules', purpose: 'Assign an open shift to an employee.',
    request: { employeeId: `${ID} *`, date: 'optional – must equal the open shift date' },
    rules: ['Open shifts belong to their date: a Monday open shift can only be assigned on Monday', 'All assignment rules apply', 'Audited as ASSIGN Open Shift'],
    exampleRequest: { params: { id: '<openShiftId>' }, body: { employeeId: 'emp-005' } } },
  'POST shifts/:id/claim': { group: 'Schedules', purpose: 'Employee self-service pickup of a posted open shift.', rules: ['allowShiftPickup must be enabled', 'All assignment rules apply', 'Atomic – only one employee can claim'] },
  'DELETE shifts/:id': { group: 'Schedules', purpose: 'Delete a shift.', rules: ['Edit Mode required on published schedules', 'Audited'] },
  'GET schedules': { group: 'Schedules', purpose: 'Schedule status per location for a week, incl. edit mode, cost and labor budget utilization.',
    request: { query: { weekStart: 'YYYY-MM-DD' } }, response: '[{ locationId, status, editMode, locked, shifts, hours, open, cost, budgetAmount, budgetUtilization, overBudget }]', exampleRequest: { query: { weekStart: WEEK } } },
  'POST schedules/publish': { group: 'Schedules', purpose: 'Publish a location-week (all shifts become visible to employees) and close Edit Mode.',
    request: { locationId: `${ID} *`, weekStart: 'YYYY-MM-DD *' }, exampleRequest: { body: { locationId: 'loc-ctr', weekStart: WEEK } } },
  'POST schedules/edit-mode': { group: 'Schedules', purpose: 'Enable or disable Edit Mode on a published schedule.',
    request: { locationId: `${ID} *`, weekStart: 'YYYY-MM-DD *', enabled: 'boolean *' }, rules: ['Only published schedules', 'Audited as EDIT_MODE'],
    exampleRequest: { body: { locationId: 'loc-dtn', weekStart: WEEK, enabled: true } } },
  'POST schedules/copy': { group: 'Schedules', purpose: 'Copy a week of shifts to another week (keeps weekday, location, department, job role).',
    request: { locationId: `${ID} *`, fromWeek: 'Monday *', toWeek: 'Monday *', replace: 'boolean' },
    rules: ['Weeks must be Mondays', 'Target must be editable', 'Assignments failing rule checks (inactive, unavailable, approved time off, department) become open shifts'] },

  'GET timecards': { group: 'Timecards', purpose: 'Timecards with exceptions (employees see their own).', request: { query: { from: 'date', to: 'date', locationId: ID, employeeId: ID, exceptionsOnly: 'true|false', q: 'name', page: 'number', limit: 'number' } }, response: PAGE },
  'GET timecards/status': { group: 'Timecards', purpose: "Today's timecard and shift for the signed-in employee." },
  'POST timecards/punch': { group: 'Timecards', purpose: 'Record a punch.', request: { action: 'in|mealStart|mealEnd|out *', date: 'YYYY-MM-DD', time: 'HH:mm' },
    rules: ['One clock-in per day', 'Meal must end before clock-out', 'Inactive employees cannot clock in'], exampleRequest: { body: { action: 'in', time: '08:01' } } },
  'PUT timecards/:id': { group: 'Timecards', purpose: 'Manager correction of punches / resolve exceptions.', request: { clockIn: 'HH:mm', clockOut: 'HH:mm', mealStart: 'HH:mm', mealEnd: 'HH:mm', notes: 'string', resolved: 'boolean' } },

  'GET timeoff': { group: 'Time Off Requests', purpose: 'List requests.', request: { query: { status: 'Pending|Approved|Rejected|Cancelled', type: 'Vacation|Sick|Personal', q: 'name', page: 'number' } }, response: PAGE },
  'POST timeoff': { group: 'Time Off Requests', purpose: 'Submit a request.', request: { type: 'Vacation|Sick|Personal *', startDate: 'date *', endDate: 'date *', reason: 'string', employeeId: 'managers only' },
    rules: ['endDate >= startDate', 'No overlap with Pending/Approved requests'], exampleRequest: { body: { type: 'Vacation', startDate: '2026-11-16', endDate: '2026-11-18', reason: 'Family trip' } } },
  'PUT timeoff/:id/decision': { group: 'Time Off Requests', purpose: 'Approve or reject.', request: { decision: 'Approved|Rejected *', comment: 'string' },
    rules: ['Only Pending requests', 'Approval warns about conflicting scheduled shifts'] },
  'DELETE timeoff/:id': { group: 'Time Off Requests', purpose: 'Cancel a pending request.' },

  'GET forecasts': { group: 'Forecasts', purpose: 'Daily forecast records.', request: { query: { locationId: ID, from: 'date', to: 'date' } } },
  'POST forecasts/generate': { group: 'Forecasts', purpose: 'Generate forecasts from history (weighted 4-week moving average).', request: { locationId: ID, weeks: '1-12', growthPct: 'number', promoPct: 'number' },
    exampleRequest: { body: { weeks: 4, growthPct: 2, promoPct: 0 } } },
  'GET budgets': { group: 'Labor Budgets', purpose: 'Weekly budget vs scheduled vs actual with variance.', request: { query: { locationId: ID } } },
  'PUT budgets/:id': { group: 'Labor Budgets', purpose: 'Update weekly budget.', request: { budgetHours: 'number >= 0', budgetAmount: 'number >= 0', notes: 'string' } },

  'GET reports': { group: 'Reports', purpose: 'Recent report runs.' },
  'GET reports/:type': { group: 'Reports', purpose: 'Run a report: roster | schedule | attendance | laborcost | timeoff.', request: { query: { locationId: ID, weekStart: 'date', from: 'date', to: 'date', status: 'string', format: 'csv' } },
    exampleRequest: { params: { type: 'roster' }, query: { status: 'Active' } } },

  'GET admin/users': { group: 'Administration', purpose: 'List users.' },
  'POST admin/users': { group: 'Administration', purpose: 'Create a login.', request: { name: 'string *', email: 'string *', password: 'min 6 *', role: 'Employee|Manager|Administrator *', employeeId: ID } },
  'PUT admin/users/:id': { group: 'Administration', purpose: 'Update user / reset password.', rules: ['You cannot disable or demote yourself'] },
  'DELETE admin/users/:id': { group: 'Administration', purpose: 'Delete a user.' },
  'GET admin/settings': { group: 'Administration', purpose: 'Organization, system (WFM rules) and role settings.' },
  'PUT admin/settings/:key': { group: 'Administration', purpose: 'Update settings group organization | system | roles.',
    rules: ['Numeric rules must be positive', 'maxDailyHours <= maxWeeklyHours'], exampleRequest: { params: { key: 'system' }, body: { maxWeeklyHours: 45, minRestHours: 11 } } },
  'GET admin/audit': { group: 'Administration', purpose: 'Audit log search.', request: { query: { q: 'text', action: 'string', entity: 'string', page: 'number' } } },
  'POST admin/reseed': { group: 'Administration', purpose: 'Reset KP Retail Group demo data.' },
  'GET admin/api-docs': { group: 'Administration', purpose: 'This documentation, generated from the registered route table.' },
};

const rolesLabel = (r) => (r === null ? ['Public'] : r.length ? r : ['Any signed-in user']);

export function buildDocs(routes) {
  const endpoints = routes.map(([method, path, , roles, extra]) => {
    const d = extra || CORE_DOCS[`${method} ${path}`] || {};
    const group = d.group || path.split('/')[0];
    const params = (path.match(/:\w+/g) || []).map((p) => p.slice(1));
    return {
      id: `${method} /api/${path}`, method, path: `/api/${path}`, params, roles: rolesLabel(roles),
      group, direction: path.startsWith('integrations/inbound') ? 'Inbound' : path.startsWith('integrations/outbound') ? 'Outbound' : 'Core',
      purpose: d.purpose || 'No description provided.', request: d.request || (method === 'GET' ? { query: 'none' } : {}),
      response: d.response || 'JSON object', rules: [...(roles === null ? [] : ['Requires Authorization: Bearer <token>']), ...(d.rules || [])],
      exampleRequest: d.exampleRequest || {}, exampleResponse: d.exampleResponse || null, documented: !!(extra || CORE_DOCS[`${method} ${path}`]),
    };
  });
  return {
    title: 'KP WFM API', version: '1.1', baseUrl: '/api', generatedAt: new Date().toISOString(),
    authentication: 'POST /api/auth/login → use the returned token as "Authorization: Bearer <token>".',
    errorFormat: { error: 'message', details: '[string] (validation errors)' },
    statusCodes: { 200: 'OK', 400: 'Bad request', 401: 'Not authenticated', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict / integrity violation', 413: 'Batch too large', 422: 'WFM rule violation', 423: 'Published schedule locked – enable Edit Mode', 500: 'Server error' },
    total: endpoints.length, endpoints,
  };
}
```

---

### NEW: `src/pages/ApiDocs.jsx`

**Location:** `kp-wfm/src/pages/ApiDocs.jsx`  
**Change:** Frontend – Administration → API Documentation + API Explorer

```jsx
/**
 * Administration → API Documentation.
 * Documentation is generated by the server from the registered route table (GET /api/admin/api-docs),
 * so new endpoints appear automatically. Includes a Swagger-like API Explorer to try calls with the
 * current session token and inspect responses. Explorer calls are tagged "[API Explorer]" in the audit log.
 */
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Play, Copy, Search, Lock, ArrowDownToLine, ArrowUpFromLine, Server } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { apiRaw } from '../lib/api';
import { useAuth } from '../store/authStore';
import { toast } from '../store/toastStore';
import { PageHeader, Card, PageLoader, ErrorState, Badge, Spinner, EmptyState, Tabs } from '../components/ui';

const METHOD_TONE = { GET: 'bg-emerald-100 text-emerald-700', POST: 'bg-brand-100 text-brand-700', PUT: 'bg-amber-100 text-amber-700', DELETE: 'bg-red-100 text-red-700' };
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
function Method({ m, className = '' }) { return <span className={`inline-block w-16 text-center rounded px-1.5 py-0.5 text-[11px] font-bold ${METHOD_TONE[m]} ${className}`}>{m}</span>; }
function Code({ value, className = '' }) { return <pre className={`bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-80 ${className}`}>{pretty(value)}</pre>; }

export default function ApiDocs() {
  const { data, loading, error, reload } = useFetch('/admin/api-docs');
  const [dir, setDir] = useState('All');
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState(null);

  const list = useMemo(() => (data?.endpoints || []).filter((e) => (dir === 'All' || e.direction === dir)
    && (!q || `${e.method} ${e.path} ${e.group} ${e.purpose}`.toLowerCase().includes(q.toLowerCase()))), [data, dir, q]);
  const groups = useMemo(() => list.reduce((m, e) => ((m[e.group] ||= []).push(e), m), {}), [list]);
  const sel = data?.endpoints.find((e) => e.id === selId) || list[0];

  if (loading && !data) return <PageLoader label="Generating API documentation…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const counts = { Core: 0, Inbound: 0, Outbound: 0 };
  data.endpoints.forEach((e) => counts[e.direction]++);

  return (
    <>
      <PageHeader title="API Documentation" subtitle={`${data.title} v${data.version} · ${data.total} endpoints generated from the registered API routes`}
        actions={<button className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(JSON.stringify(data, null, 2)); toast.success('OpenAPI-style JSON copied'); }}><Copy className="h-4 w-4" />Copy JSON</button>} />
      <div className="grid sm:grid-cols-3 gap-3 mb-4 text-sm">
        <div className="card p-3 flex items-center gap-2"><Server className="h-4 w-4 text-brand-600" />Core APIs <b className="ml-auto">{counts.Core}</b></div>
        <div className="card p-3 flex items-center gap-2"><ArrowDownToLine className="h-4 w-4 text-brand-600" />Inbound integration APIs <b className="ml-auto">{counts.Inbound}</b></div>
        <div className="card p-3 flex items-center gap-2"><ArrowUpFromLine className="h-4 w-4 text-brand-600" />Outbound integration APIs <b className="ml-auto">{counts.Outbound}</b></div>
      </div>
      <div className="card p-3 mb-4 text-xs text-slate-600 space-y-1">
        <p><b>Base URL:</b> <code>{window.location.origin}{data.baseUrl}</code> · <b>Auth:</b> {data.authentication}</p>
        <p><b>Errors:</b> <code>{JSON.stringify(data.errorFormat)}</code> · <b>Status codes:</b> {Object.entries(data.statusCodes).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
      </div>
      <Tabs value={dir} onChange={setDir} tabs={[{ value: 'All', label: 'All', count: data.total }, { value: 'Core', label: 'Core', count: counts.Core }, { value: 'Inbound', label: 'Inbound', count: counts.Inbound }, { value: 'Outbound', label: 'Outbound', count: counts.Outbound }]} />
      <div className="grid lg:grid-cols-[360px_1fr] gap-4 items-start">
        <div className="card overflow-hidden lg:sticky lg:top-20">
          <div className="p-3 border-b relative"><Search className="h-4 w-4 text-slate-400 absolute left-6 top-1/2 -translate-y-1/2" /><input className="input pl-9" placeholder="Filter endpoints…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="max-h-[70vh] overflow-y-auto">
            {Object.entries(groups).map(([g, eps]) => (
              <div key={g}>
                <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g}</p>
                {eps.map((e) => (
                  <button key={e.id} onClick={() => setSelId(e.id)} className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-brand-50 ${sel?.id === e.id ? 'bg-brand-50 border-l-2 border-brand-600' : ''}`}>
                    <Method m={e.method} /><span className="font-mono truncate">{e.path.replace('/api/', '')}</span>
                  </button>))}
              </div>))}
            {!list.length && <EmptyState icon={BookOpen} title="No endpoints match" />}
          </div>
        </div>
        {sel ? <EndpointDetail key={sel.id} ep={sel} /> : <EmptyState icon={BookOpen} title="Select an endpoint" />}
      </div>
    </>
  );
}

function EndpointDetail({ ep }) {
  return (
    <div className="space-y-4 min-w-0">
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-2"><Method m={ep.method} /><code className="font-mono text-sm font-semibold break-all">{ep.path}</code>
          <Badge tone={ep.direction === 'Core' ? 'blue' : ep.direction === 'Inbound' ? 'purple' : 'green'}>{ep.direction}</Badge>
          {!ep.documented && <Badge tone="gray">auto-generated</Badge>}</div>
        <p className="text-sm text-slate-700">{ep.purpose}</p>
        <p className="text-xs text-slate-500 mt-2 flex items-center gap-1"><Lock className="h-3 w-3" />Roles: {ep.roles.join(', ')}</p>
      </Card>
      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Request payload"><Code value={ep.request} /></Card>
        <Card title="Response payload"><Code value={ep.response} /></Card>
      </div>
      <Card title="Validation rules">
        {ep.rules.length ? <ul className="list-disc pl-5 text-sm text-slate-700 space-y-1">{ep.rules.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="text-sm text-slate-500">No additional rules.</p>}
      </Card>
      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Example request"><Code value={ep.exampleRequest && Object.keys(ep.exampleRequest).length ? ep.exampleRequest : `${ep.method} ${ep.path}`} /></Card>
        <Card title="Example response"><Code value={ep.exampleResponse || { note: 'Run "Try it" to see a live response' }} /></Card>
      </div>
      <TryIt ep={ep} />
    </div>
  );
}

function TryIt({ ep }) {
  const token = useAuth((s) => s.token);
  const ex = ep.exampleRequest || {};
  const [params, setParams] = useState(Object.fromEntries(ep.params.map((p) => [p, ex.params?.[p] || ''])));
  const [query, setQuery] = useState(ex.query ? JSON.stringify(ex.query, null, 2) : '{}');
  const [body, setBody] = useState(ex.body ? JSON.stringify(ex.body, null, 2) : ep.method === 'GET' || ep.method === 'DELETE' ? '' : '{}');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRes(null), [ep.id]);
  const unsafe = ep.method !== 'GET';

  const build = () => {
    let path = ep.path.replace(/^\/api/, '');
    for (const p of ep.params) path = path.replace(`:${p}`, encodeURIComponent(params[p] || `:${p}`));
    let qp = {};
    try { qp = query.trim() ? JSON.parse(query) : {}; } catch { throw new Error('Query must be valid JSON'); }
    return { path, qp };
  };
  const send = async () => {
    let b;
    try {
      const { path, qp } = build();
      if (body.trim() && unsafe) { try { JSON.parse(body); } catch { throw new Error('Body must be valid JSON'); } }
      b = { path, qp };
    } catch (e) { toast.error(e.message); return; }
    if (ep.params.some((p) => !params[p])) { toast.error(`Fill in path parameter(s): ${ep.params.join(', ')}`); return; }
    setBusy(true);
    setRes(await apiRaw(b.path, { method: ep.method, params: b.qp, rawBody: unsafe && body.trim() ? body : undefined }));
    setBusy(false);
  };
  const curl = () => {
    try {
      const { path, qp } = build();
      const qs = new URLSearchParams(qp).toString();
      const cmd = `curl -X ${ep.method} "${window.location.origin}/api${path}${qs ? '?' + qs : ''}" \\\n  -H "Authorization: Bearer ${token ? token.slice(0, 12) + '…' : '<token>'}" \\\n  -H "Content-Type: application/json"${unsafe && body.trim() ? ` \\\n  -d '${body.replace(/\s*\n\s*/g, ' ')}'` : ''}`;
      navigator.clipboard?.writeText(cmd); toast.success('cURL copied (token truncated)');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card title="Try it – API Explorer" actions={<div className="flex gap-2"><button className="btn-secondary btn-sm" onClick={curl}><Copy className="h-3.5 w-3.5" />cURL</button>
      <button className="btn-primary btn-sm" onClick={send} disabled={busy}>{busy ? <Spinner className="h-3.5 w-3.5 text-white" /> : <Play className="h-3.5 w-3.5" />}Send request</button></div>}>
      {unsafe && <p className="mb-3 text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-2">This is a {ep.method} call and will change live data (and be written to the audit log). Use "Reset demo data" to restore the KP demo if needed.</p>}
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="space-y-3">
          {ep.params.length > 0 && <div><label className="label">Path parameters</label>
            {ep.params.map((p) => <div key={p} className="flex items-center gap-2 mb-2"><code className="text-xs w-16">:{p}</code><input className="input font-mono text-xs" value={params[p]} onChange={(e) => setParams({ ...params, [p]: e.target.value })} placeholder={p} /></div>)}</div>}
          <div><label className="label">Query parameters (JSON)</label><textarea className="input font-mono text-xs" rows={4} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          {unsafe && <div><label className="label">Request body (JSON)</label><textarea className="input font-mono text-xs" rows={10} value={body} onChange={(e) => setBody(e.target.value)} /></div>}
        </div>
        <div>
          <label className="label">Response</label>
          {res ? (
            <>
              <div className="flex items-center gap-2 mb-2 text-sm">
                <Badge tone={res.ok ? 'green' : res.status >= 500 || res.status === 0 ? 'red' : 'yellow'}>{res.status || 'ERR'}</Badge>
                <span className="text-slate-500">{res.ms} ms</span>
                {Array.isArray(res.data?.items) && <span className="text-slate-500">{res.data.items.length} items</span>}
                {Array.isArray(res.data?.records) && <span className="text-slate-500">{res.data.records.length} records</span>}
                {Array.isArray(res.data) && <span className="text-slate-500">{res.data.length} rows</span>}
              </div>
              <Code value={res.data} className="max-h-[480px]" />
            </>
          ) : <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Send a request to see the live response.</div>}
        </div>
      </div>
    </Card>
  );
}
```

---

### NEW: `docs/WFM_RULES_AUDIT.md`

**Location:** `kp-wfm/docs/WFM_RULES_AUDIT.md`  
**Change:** Docs – audit findings, corrections, rules, test checklist

```markdown
# KP WFM – Workforce Management Rules Audit (v1.1)

Scope: review of the whole application against WFM scheduling rules. No redesign; all v1.0 functionality and the
seeded KP Retail Group demo data are preserved. Rules live in **one** place (`server/rules.js`) and are applied to
every entry point: UI create/edit, drag & drop, open-shift assignment, employee pickup and inbound API import.

## 1. Findings and corrections

| # | Rule | v1.0 behaviour (violation) | v1.1 correction | Where |
|---|---|---|---|---|
| 1 | Open shifts belong to a specific date | Dragging an open shift to another day moved its date | Date is locked. Drag to another day is rejected in UI; API returns 409 *"this Monday shift can only be assigned on Monday"*. New `POST /shifts/:id/assign` rejects a different `date` | `rules.assertIntegrity`, `handlers.assignOpenShift`, `Scheduling.jsx move()` |
| 2 | Employee must be active | Checked only `status` | Checks `status` **and** `employmentStatus` (On Leave / Terminated). Deactivated employees' future shifts are released to open shifts | `rules.validateShift`, `handlers.releaseFutureShifts` |
| 3 | Employee must belong to the location | Not checked | Enforced (422) | `rules.validateShift` |
| 4 | Employee must belong to the department | Not checked; assigning overwrote the shift department with the employee's | Enforced (configurable); shift department never overwritten | `rules.validateShift`, `handlers.finalizeShift` |
| 5 | Required skills | Not supported | `requiredSkills` on shifts, `skills` on employees (defaults by job role / job profile); missing skills block assignment | `rules.validateShift`, `Employees.jsx`, `Scheduling.jsx` |
| 6 | Overlap validation | Same-day overlap only | Overlap across days incl. overnight shifts | `rules.span/validateShift` |
| 7 | Duplicate shifts | Not checked | Identical employee shift blocked; identical open shift (location/date/time/dept/job) blocked | `rules.validateShift` |
| 8 | Daily hour limit | Not enforced | `maxDailyHours` (default 10) + `maxShiftHours` (default 12) | `rules.validateShift` |
| 9 | Weekly hour limit | UI showed OT only | `maxWeeklyHours` (default 48) blocks; > overtime threshold (40) warns | `rules.validateShift` |
| 10 | Rest period | Not checked | `minRestHours` (default 10) between shifts on different days | `rules.validateShift` |
| 11 | Published schedule controls | Published schedules editable directly | Edit Mode required (423 otherwise). `POST /schedules/edit-mode`; publish closes Edit Mode; UI lock banner & read-only modal | `rules.assertEditable`, `handlers.setEditMode`, `Scheduling.jsx` |
| 12 | Track modifications | Generic audit text | Field-level *before → after* details for shifts, employees, locations, budgets, timecards, settings | `handlers.diff` |
| 13 | Availability validation | Visual hint only | Blocks assignment on unavailable weekday and on **approved** time off; pending time off warns | `rules.validateShift` |
| 14 | Labor budget validation | Not shown in scheduling | Warning returned on every change + over-budget banner and utilization in Scheduling | `rules.validateShift`, `handlers.listSchedules`, `Scheduling.jsx` |
| 15 | Schedule integrity | Date, location, department and job role could change on edit | Locked on every existing shift (409). UI fields disabled for existing shifts | `rules.assertIntegrity`, `Scheduling.jsx ShiftModal` |
| 16 | Copy schedule | Copied inactive / unavailable assignments | Keeps weekday/location/department/job; invalid assignments converted to open shifts; target must be editable | `handlers.copySchedule` |
| 17 | Open-shift pickup race | Two employees could claim the same shift | Atomic conditional replace (409 for the loser) + all assignment rules | `handlers.claimShift` |
| 18 | Time off approval | No schedule feedback | Approval warns about conflicting scheduled shifts | `handlers.decideTimeoff` |
| 19 | Inactive employee clock-in | Allowed | Blocked | `handlers.punch` |

## 2. Configurable rules (Administration → System Settings)

| Setting | Default | Type |
|---|---|---|
| maxDailyHours | 10 | hard |
| maxWeeklyHours | 48 | hard |
| minRestHours | 10 | hard |
| maxShiftHours | 12 | hard |
| overtimeThresholdWeekly | 40 | warning |
| budgetWarningPct | 100 | warning |
| enforceAvailability / enforceDepartmentMatch / enforceSkills | on | toggle |
| requireEditModeForPublished / preventDuplicateOpenShifts | on | toggle |
| logReadRequests | off | audit |

Defaults are merged at runtime, so databases seeded by v1.0 need no migration.

## 3. API documentation module
* Menu: **Administration → API Documentation** (Administrator).
* Generated from the registered route table (`server/router.js` → `server/apiDocs.js`): new routes appear automatically.
* Per API: endpoint, method, roles, purpose, request payload, response payload, validation rules, example request, example response.
* Inbound (`POST /api/integrations/inbound/<entity>`) and Outbound (`GET /api/integrations/outbound/<entity>`) APIs for
  Employees, Locations, Schedules, Timecards, Forecasts, Labor Budgets, Time Off Requests, Departments, Jobs and Availability.
* API Explorer: path/query/body editors, live call with the session token, status, latency and JSON response, copy cURL.

## 4. Audit logging
| Event | Action / Entity |
|---|---|
| Schedule creation | `CREATE Schedule` (first shift in a week, publish of a new week, copy) |
| Schedule edits | `CREATE/UPDATE/DELETE Shift`, `EDIT_MODE Schedule`, `PUBLISH Schedule` (with changed count) |
| Open shift assignment | `ASSIGN Open Shift` (manager assignment or employee pickup), `UNASSIGN Shift`, `RELEASE Shift` |
| Employee updates | `UPDATE Employee` with field-level changes |
| Location updates | `UPDATE Location` with field-level changes |
| API requests | `API_REQUEST API` – all write calls (+ GET when enabled or from API Explorer) with latency |
| API failures | `API_FAILURE API` – every 4xx/5xx with status and message (incl. failed logins & rule violations) |
| Integrations | `INBOUND / INBOUND_PARTIAL Integration` batch summary + per-record entity events tagged `[Inbound API]` |

## 5. Test checklist (demo data)
1. Manager → Scheduling → KP Downtown Store (published): drag any shift → error *enable Edit Mode*.
2. Enable Edit Mode → drag a Monday open shift onto Tuesday → rejected; onto an employee's Monday cell → assigned or rule error listed.
3. Assign an Optician open shift to a Sales Associate → *department* violation.
4. Create a 08:00–20:00 shift → *daily limit* (10h) violation.
5. Give an employee a 12:00–20:00 shift and a next-day 04:00 shift → *rest period* violation.
6. Add a shift with required skill "Key Holder" for a Sales Associate → *missing skill*.
7. Publish → Edit Mode closes; Admin → Audit Logs shows ASSIGN / UPDATE / PUBLISH / API_REQUEST / API_FAILURE.
8. Admin → API Documentation → `GET integrations/outbound/employees` → Send request.
```

## Part B – Modified files (full code)

---

### MODIFIED: `server/handlers.js`

**Location:** `kp-wfm/server/handlers.js`  
**Change:** Rules engine wired into scheduling; Edit Mode; open-shift assign endpoint; integrity locks; field-level audit; shift release on deactivation; settings defaults

```javascript
/**
 * All API route handlers. Each handler receives ({ db, user, params, query, body }) and returns JSON.
 * Kept in a single serverless function (api/index.js) so the project stays within the
 * Vercel Hobby plan function limit and shares one warm MongoDB connection.
 *
 * WFM rules audit (v1.1): scheduling handlers now delegate every business rule to server/rules.js,
 * published schedules require Edit Mode, shifts keep their original date/location/department/job role,
 * open shifts are assigned through a dedicated endpoint, and employee/location/schedule changes are
 * audited with field-level before -> after details.
 */
import dayjs from 'dayjs';
import { newId } from './db.js';
import { HttpError } from './http.js';
import { checkPassword, hashPassword, signToken, publicUser } from './auth.js';
import { audit } from './audit.js';
import { seedAll, DEPARTMENTS, JOB_TITLES } from './seed.js';
import { fmt, weekStart, paginate, regex, round2, calcTimecard } from './utils.js';
import {
  getRules, invalidateRules, DEFAULT_RULES, validateShift, throwIfInvalid, assertIntegrity, assertEditable,
  shiftHours, toList, employeeSkills, weekdayName, JOB_SKILLS,
} from './rules.js';

export const MGR = ['Manager', 'Administrator'];
export const ADMIN = ['Administrator'];
const today = () => fmt(dayjs());
const fullName = (e) => `${e.firstName} ${e.lastName}`;
export const must = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

/** Field-level change list used in audit details, e.g. "hourlyRate: 15 → 16.5". */
const show = (v) => {
  if (v === null || v === undefined || v === '') return '∅';
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'available' in v[0]) return v.filter((a) => a.available).map((a) => a.day).join('/') || 'none';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v);
};
export function diff(before, after, fields) {
  return fields.filter((f) => after[f] !== undefined && JSON.stringify(before?.[f]) !== JSON.stringify(after[f]))
    .map((f) => `${f}: ${show(before?.[f])} → ${show(after[f])}`);
}

// ============================== AUTH ==============================
async function login({ db, body }) {
  const email = String(body.email || '').trim().toLowerCase();
  const u = await db.collection('users').findOne({ email });
  must(u && checkPassword(body.password, u.password), 401, 'Invalid email or password');
  must(u.active !== false, 403, 'Account is disabled. Contact your administrator.');
  await db.collection('users').updateOne({ _id: u._id }, { $set: { lastLogin: new Date().toISOString() } });
  const token = signToken(u);
  await audit(db, { sub: u._id, name: u.name, email: u.email, role: u.role }, 'LOGIN', 'Auth', 'User signed in');
  return { token, user: publicUser(u) };
}
async function me({ db, user }) {
  const u = await db.collection('users').findOne({ _id: user.sub });
  must(u, 401, 'User not found');
  const employee = u.employeeId ? await db.collection('employees').findOne({ _id: u.employeeId }) : null;
  return { user: publicUser(u), employee };
}

// ============================== META / LOOKUPS ==============================
async function meta({ db }) {
  const [locations, employees, org, rules] = await Promise.all([
    db.collection('locations').find({}, { projection: { name: 1, code: 1, region: 1, departments: 1, operatingHours: 1 } }).sort({ name: 1 }).toArray(),
    db.collection('employees').find({}, { projection: { firstName: 1, lastName: 1, employeeId: 1, locationId: 1, department: 1, jobTitle: 1, hourlyRate: 1, status: 1, employmentStatus: 1, availability: 1, employmentType: 1, skills: 1 } }).sort({ firstName: 1 }).toArray(),
    db.collection('settings').findOne({ _id: 'organization' }),
    getRules(db),
  ]);
  employees.forEach((e) => { e.effectiveSkills = employeeSkills(e, org?.jobProfiles); });
  const skills = [...new Set(Object.values({ ...JOB_SKILLS, ...Object.fromEntries(Object.entries(org?.jobProfiles || {}).map(([k, v]) => [k, v.skills || []])) }).flat())].sort();
  return { locations, employees, departments: org?.departments || DEPARTMENTS, jobTitles: org?.jobTitles || JOB_TITLES, skills,
    regions: org?.regions || [], rules, managers: employees.filter((e) => ['Store Manager', 'Assistant Manager', 'Supervisor'].includes(e.jobTitle) && e.status === 'Active') };
}

// ============================== DASHBOARD ==============================
async function dashboard({ db, user }) {
  const ws = fmt(weekStart()), we = fmt(weekStart().add(6, 'day'));
  if (user.role === 'Employee') {
    const eid = user.employeeId;
    const [shifts, timeoff, cards, open] = await Promise.all([
      db.collection('shifts').find({ employeeId: eid, weekStart: ws, published: true }).sort({ date: 1 }).toArray(),
      db.collection('timeoffrequests').find({ employeeId: eid }).sort({ startDate: -1 }).limit(5).toArray(),
      db.collection('timecards').find({ employeeId: eid }).sort({ date: -1 }).limit(7).toArray(),
      db.collection('shifts').countDocuments({ employeeId: null, posted: true, published: true, weekStart: ws }),
    ]);
    const approvedDays = (await db.collection('timeoffrequests').find({ employeeId: eid, status: 'Approved' }).toArray()).reduce((a, t) => a + t.days, 0);
    return { role: 'Employee', weekStart: ws, shifts, timeoff, timecards: cards, openShifts: open,
      scheduledHours: shifts.reduce((a, s) => a + s.hours, 0), workedHours: round2(cards.reduce((a, c) => a + (c.totalHours || 0), 0)),
      vacationBalance: Math.max(0, 15 - approvedDays) };
  }
  const shiftsCol = db.collection('shifts');
  const [total, active, locations, openShifts, pending, exceptions, weekShifts, budgets, forecasts, trend, recentPending, recentExceptions] = await Promise.all([
    db.collection('employees').countDocuments({}),
    db.collection('employees').countDocuments({ status: 'Active' }),
    db.collection('locations').countDocuments({}),
    shiftsCol.countDocuments({ weekStart: ws, employeeId: null }),
    db.collection('timeoffrequests').countDocuments({ status: 'Pending' }),
    db.collection('timecards').countDocuments({ 'exceptions.0': { $exists: true }, resolved: { $ne: true } }),
    shiftsCol.find({ weekStart: ws }).toArray(),
    db.collection('laborbudgets').find({ weekStart: ws }).toArray(),
    db.collection('forecasts').find({ date: { $gte: ws, $lte: we } }).toArray(),
    db.collection('laborbudgets').aggregate([{ $group: { _id: '$weekStart', budgetHours: { $sum: '$budgetHours' }, plannedHours: { $sum: '$plannedHours' },
      actualHours: { $sum: '$actualHours' }, budgetAmount: { $sum: '$budgetAmount' }, actualCost: { $sum: '$actualCost' }, plannedCost: { $sum: '$plannedCost' } } }, { $sort: { _id: 1 } }]).toArray(),
    db.collection('timeoffrequests').find({ status: 'Pending' }).sort({ startDate: 1 }).limit(5).toArray(),
    db.collection('timecards').find({ 'exceptions.0': { $exists: true }, resolved: { $ne: true } }).sort({ date: -1 }).limit(6).toArray(),
  ]);
  const assigned = weekShifts.filter((s) => s.employeeId);
  const scheduledHours = round2(assigned.reduce((a, s) => a + s.hours, 0));
  const laborCost = round2(assigned.reduce((a, s) => a + s.cost, 0));
  const budgetAmount = budgets.reduce((a, b) => a + b.budgetAmount, 0);
  const staffing = Array.from({ length: 7 }, (_, i) => {
    const date = fmt(weekStart().add(i, 'day'));
    const day = assigned.filter((s) => s.date === date);
    const fc = forecasts.filter((f) => f.date === date);
    return { date, day: dayjs(date).format('ddd'), scheduled: day.length, scheduledHours: day.reduce((a, s) => a + s.hours, 0),
      requiredHours: Math.round(fc.reduce((a, f) => a + f.laborDemandHours, 0)), required: fc.reduce((a, f) => a + f.recommendedStaff, 0),
      open: weekShifts.filter((s) => s.date === date && !s.employeeId).length };
  });
  const byDept = {};
  assigned.forEach((s) => { byDept[s.department] = (byDept[s.department] || 0) + s.hours; });
  return {
    role: user.role, weekStart: ws,
    cards: { totalEmployees: total, activeEmployees: active, locations, openShifts, pendingTimeOff: pending, attendanceExceptions: exceptions,
      scheduledHours, laborCost, laborBudget: budgetAmount, budgetUtilization: budgetAmount ? Math.round((laborCost / budgetAmount) * 100) : 0 },
    staffing, laborTrend: trend.map((t) => ({ week: dayjs(t._id).format('MMM D'), ...t, actualHours: t.actualHours || null, isCurrent: t._id === ws })),
    departmentHours: Object.entries(byDept).map(([name, value]) => ({ name, value })),
    recentPending, recentExceptions,
  };
}

// ============================== EMPLOYEES ==============================
const EMP_FIELDS = ['employeeId', 'firstName', 'lastName', 'email', 'phone', 'department', 'jobTitle', 'locationId', 'hireDate', 'hourlyRate',
  'employmentType', 'employmentStatus', 'status', 'managerId', 'availability', 'skills'];
export async function normalizeEmployee(db, body) {
  const doc = {};
  EMP_FIELDS.forEach((f) => body[f] !== undefined && (doc[f] = body[f]));
  if (doc.hourlyRate !== undefined) { doc.hourlyRate = round2(Number(doc.hourlyRate)); must(doc.hourlyRate > 0, 400, 'Hourly rate must be greater than 0'); }
  if (doc.skills !== undefined) doc.skills = toList(doc.skills);
  if (doc.locationId) {
    const loc = await db.collection('locations').findOne({ _id: doc.locationId });
    must(loc, 400, 'Location not found');
    doc.locationName = loc.name;
  }
  if (doc.managerId !== undefined) {
    const m = doc.managerId ? await db.collection('employees').findOne({ _id: doc.managerId }) : null;
    doc.managerName = m ? fullName(m) : ''; doc.managerId = m ? m._id : null;
  }
  return doc;
}
/** Inactive employees cannot hold shifts: future shifts are released back to open shifts. */
export async function releaseFutureShifts(db, user, emp) {
  const r = await db.collection('shifts').updateMany({ employeeId: emp._id, date: { $gte: today() } },
    { $set: { employeeId: null, employeeName: '', cost: 0, posted: true, notes: `Released - ${fullName(emp)} inactive` } });
  if (r.modifiedCount) await audit(db, user, 'RELEASE', 'Shift', `Released ${r.modifiedCount} future shift(s) of ${fullName(emp)} to open shifts (employee inactive)`, emp._id);
  return r.modifiedCount;
}
async function listEmployees({ db, query }) {
  const f = {};
  if (query.q) f.$or = ['firstName', 'lastName', 'email', 'employeeId', 'jobTitle'].map((k) => ({ [k]: regex(query.q) }));
  ['locationId', 'department', 'status', 'employmentType', 'jobTitle'].forEach((k) => query[k] && (f[k] = query[k]));
  return paginate(db.collection('employees'), f, query, { lastName: 1, firstName: 1 });
}
async function getEmployee({ db, user, params }) {
  must(user.role !== 'Employee' || user.employeeId === params.id, 403, 'Forbidden');
  const e = await db.collection('employees').findOne({ _id: params.id });
  must(e, 404, 'Employee not found');
  return e;
}
async function createEmployee({ db, user, body }) {
  must(body.firstName && body.lastName && body.email && body.locationId, 400, 'First name, last name, email and location are required');
  const doc = await normalizeEmployee(db, body);
  const count = await db.collection('employees').countDocuments({});
  const e = { _id: newId(), employeeId: doc.employeeId || `KP${1001 + count}`, status: 'Active', employmentStatus: 'Active', employmentType: 'Full-Time',
    availability: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => ({ day: d, available: d !== 'sun' })),
    hireDate: today(), ...doc, createdAt: new Date().toISOString() };
  must(!(await db.collection('employees').findOne({ employeeId: e.employeeId })), 409, 'Employee ID already exists');
  await db.collection('employees').insertOne(e);
  await audit(db, user, 'CREATE', 'Employee', `Created employee ${fullName(e)} (${e.employeeId}) at ${e.locationName}, ${e.department} / ${e.jobTitle}`, e._id);
  return e;
}
async function updateEmployee({ db, user, params, body }) {
  const before = await db.collection('employees').findOne({ _id: params.id });
  must(before, 404, 'Employee not found');
  const doc = await normalizeEmployee(db, body);
  if (doc.status === 'Inactive' && !doc.employmentStatus) doc.employmentStatus = 'Terminated';
  if (doc.employeeId && doc.employeeId !== before.employeeId)
    must(!(await db.collection('employees').findOne({ employeeId: doc.employeeId })), 409, 'Employee ID already exists');
  const r = await db.collection('employees').findOneAndUpdate({ _id: params.id }, { $set: { ...doc, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
  if (doc.firstName || doc.lastName) await db.collection('shifts').updateMany({ employeeId: r._id }, { $set: { employeeName: fullName(r) } });
  const changes = diff(before, doc, EMP_FIELDS.filter((f) => f !== 'managerId').concat('managerName'));
  await audit(db, user, 'UPDATE', 'Employee', `Updated employee ${fullName(r)} (${r.employeeId})${changes.length ? ': ' + changes.join('; ') : ' (no changes)'}`, r._id);
  let released = 0;
  if (r.status !== 'Active' || ['Terminated', 'On Leave'].includes(r.employmentStatus)) released = await releaseFutureShifts(db, user, r);
  return { ...r, releasedShifts: released };
}
async function deleteEmployee({ db, user, params }) {
  // Soft delete keeps history (timecards / shifts) intact
  const r = await db.collection('employees').findOneAndUpdate({ _id: params.id }, { $set: { status: 'Inactive', employmentStatus: 'Terminated' } }, { returnDocument: 'after' });
  must(r, 404, 'Employee not found');
  await audit(db, user, 'DEACTIVATE', 'Employee', `Deactivated employee ${fullName(r)}`, r._id);
  const released = await releaseFutureShifts(db, user, r);
  return { ok: true, releasedShifts: released };
}

// ============================== LOCATIONS ==============================
async function listLocations({ db }) {
  const [locs, counts] = await Promise.all([
    db.collection('locations').find({}).sort({ name: 1 }).toArray(),
    db.collection('employees').aggregate([{ $match: { status: 'Active' } }, { $group: { _id: '$locationId', n: { $sum: 1 } } }]).toArray(),
  ]);
  return locs.map((l) => ({ ...l, employeeCount: counts.find((c) => c._id === l._id)?.n || 0 }));
}
export const LOC_FIELDS = ['name', 'code', 'region', 'address', 'city', 'phone', 'costCenter', 'status', 'operatingHours', 'departments', 'weeklyLaborBudget', 'baseTraffic'];
const pickLoc = (b) => { const d = {}; LOC_FIELDS.forEach((f) => b[f] !== undefined && (d[f] = b[f])); if (d.weeklyLaborBudget !== undefined) d.weeklyLaborBudget = Number(d.weeklyLaborBudget) || 0; return d; };
async function createLocation({ db, user, body }) {
  must(body.name && body.costCenter, 400, 'Name and cost center are required');
  const l = { _id: newId(), status: 'Active', baseTraffic: 450, departments: DEPARTMENTS.map((n) => ({ name: n, parent: null })), ...pickLoc(body), createdAt: new Date().toISOString() };
  if (l.code) must(!(await db.collection('locations').findOne({ code: l.code })), 409, `Location code ${l.code} already exists`);
  await db.collection('locations').insertOne(l);
  await audit(db, user, 'CREATE', 'Location', `Created location ${l.name} (${l.costCenter})`, l._id);
  return l;
}
async function updateLocation({ db, user, params, body }) {
  const before = await db.collection('locations').findOne({ _id: params.id });
  must(before, 404, 'Location not found');
  const d = pickLoc(body);
  const r = await db.collection('locations').findOneAndUpdate({ _id: params.id }, { $set: { ...d, updatedAt: new Date().toISOString() } }, { returnDocument: 'after' });
  if (body.name) await db.collection('employees').updateMany({ locationId: r._id }, { $set: { locationName: r.name } });
  if (body.weeklyLaborBudget !== undefined)
    await db.collection('laborbudgets').updateOne({ locationId: r._id, weekStart: fmt(weekStart()) }, { $set: { budgetAmount: Number(body.weeklyLaborBudget) } });
  const changes = diff(before, d, LOC_FIELDS);
  await audit(db, user, 'UPDATE', 'Location', `Updated location ${r.name}${changes.length ? ': ' + changes.join('; ') : ' (no changes)'}`, r._id);
  return r;
}
async function deleteLocation({ db, user, params }) {
  const n = await db.collection('employees').countDocuments({ locationId: params.id, status: 'Active' });
  must(n === 0, 409, `Cannot delete: ${n} active employees are assigned to this location`);
  await db.collection('locations').deleteOne({ _id: params.id });
  await audit(db, user, 'DELETE', 'Location', `Deleted location ${params.id}`, params.id);
  return { ok: true };
}

// ============================== SCHEDULING ==============================
async function listShifts({ db, user, query }) {
  const ws = query.weekStart || fmt(weekStart());
  const f = { weekStart: ws };
  if (query.date) f.date = query.date;
  ['locationId', 'department'].forEach((k) => query[k] && (f[k] = query[k]));
  if (user.role === 'Employee') {
    // Employees only see their own published shifts plus posted open shifts
    f.published = true;
    f.$or = [{ employeeId: user.employeeId }, { employeeId: null, posted: true }];
  } else if (query.employeeId) f.employeeId = query.employeeId;
  return db.collection('shifts').find(f).sort({ date: 1, start: 1 }).toArray();
}

/** Recompute derived shift fields after validation. */
function finalizeShift(s, employee, rules) {
  s.weekStart = fmt(weekStart(s.date));
  s.hours = shiftHours(s);
  if (employee) {
    s.employeeName = fullName(employee); s.rate = employee.hourlyRate; s.posted = false;
  } else { s.employeeName = ''; s.rate = s.rate || 16; }
  s.cost = s.employeeId ? round2(s.hours * s.rate) : 0;
  s.overtime = s.hours > 8 || s.hours > rules.overtimeThresholdDaily;
  s.requiredSkills = toList(s.requiredSkills);
  return s;
}

/** Mark the location-week schedule as having unpublished changes; creates the schedule header if new. */
async function markDraft(db, user, s) {
  const r = await db.collection('schedules').updateOne({ locationId: s.locationId, weekStart: s.weekStart },
    { $set: { hasUnpublishedChanges: true }, $setOnInsert: { _id: newId(), status: 'Draft', editMode: false, createdAt: new Date().toISOString(), createdBy: user?.name || 'System' } }, { upsert: true });
  if (r.upsertedCount) await audit(db, user, 'CREATE', 'Schedule', `Created draft schedule for location ${s.locationId}, week of ${s.weekStart}`);
}

const shiftLabel = (s) => `${s.employeeName || 'Open'} ${s.date} (${weekdayName(s.date)}) ${s.start}-${s.end} ${s.department}/${s.jobTitle}`;

export async function createShiftCore(db, user, body, { source = 'UI' } = {}) {
  const rules = await getRules(db);
  must(body.locationId && body.date && body.start && body.end, 400, 'Location, date, start and end are required');
  must(body.department && body.jobTitle, 400, 'Department and job role are required for every shift');
  const s = { _id: newId(), shiftType: body.shiftType || 'Custom', locationId: body.locationId, date: body.date, start: body.start, end: body.end,
    department: body.department, jobTitle: body.jobTitle, requiredSkills: body.requiredSkills, notes: body.notes || '', posted: !!body.posted,
    employeeId: body.employeeId || null, externalId: body.externalId || null, published: false,
    createdAt: new Date().toISOString(), createdBy: user?.name || 'System', source };
  s.weekStart = fmt(weekStart(s.date));
  await assertEditable(db, s.locationId, s.weekStart, rules);
  const v = await validateShift(db, s, { rules });
  throwIfInvalid(v);
  finalizeShift(s, v.employee, rules);
  await db.collection('shifts').insertOne(s);
  await markDraft(db, user, s);
  await audit(db, user, 'CREATE', 'Shift', `Created ${s.employeeId ? 'shift' : 'open shift'}: ${shiftLabel(s)}${source !== 'UI' ? ` [${source}]` : ''}`, s._id);
  return { ...s, warnings: v.warnings };
}
async function createShift({ db, user, body }) { return createShiftCore(db, user, body); }

export async function updateShiftCore(db, user, id, body, { source = 'UI' } = {}) {
  const rules = await getRules(db);
  const ex = await db.collection('shifts').findOne({ _id: id });
  must(ex, 404, 'Shift not found');
  assertIntegrity(ex, body);                                  // date / location / department / job role are locked
  await assertEditable(db, ex.locationId, ex.weekStart, rules);
  const s = { ...ex };
  ['start', 'end', 'notes', 'posted', 'requiredSkills'].forEach((k) => body[k] !== undefined && (s[k] = body[k]));
  if (body.employeeId !== undefined) s.employeeId = body.employeeId || null;
  const ruleRelevant = s.employeeId !== ex.employeeId || s.start !== ex.start || s.end !== ex.end || JSON.stringify(toList(s.requiredSkills)) !== JSON.stringify(toList(ex.requiredSkills));
  let v = { errors: [], warnings: [], employee: null };
  if (ruleRelevant) { v = await validateShift(db, s, { rules, ignoreId: ex._id }); throwIfInvalid(v); }
  const employee = v.employee || (s.employeeId ? await db.collection('employees').findOne({ _id: s.employeeId }) : null);
  finalizeShift(s, employee, rules);
  s.published = false;                                        // change returns the shift to draft until re-published
  s.updatedAt = new Date().toISOString(); s.updatedBy = user?.name || 'System';
  await db.collection('shifts').replaceOne({ _id: s._id }, s);
  await markDraft(db, user, s);
  const changes = diff(ex, s, ['employeeName', 'start', 'end', 'notes', 'posted', 'requiredSkills']);
  const action = !ex.employeeId && s.employeeId ? 'ASSIGN' : ex.employeeId && !s.employeeId ? 'UNASSIGN' : 'UPDATE';
  await audit(db, user, action, action === 'ASSIGN' ? 'Open Shift' : 'Shift',
    `${action === 'ASSIGN' ? 'Assigned open shift' : 'Edited shift'} ${ex.date} (${weekdayName(ex.date)}) ${ex.department}/${ex.jobTitle}: ${changes.join('; ') || 'no changes'}${source !== 'UI' ? ` [${source}]` : ''}`, s._id);
  return { ...s, warnings: v.warnings };
}
async function updateShift({ db, user, params, body }) { return updateShiftCore(db, user, params.id, body); }

/** Assign an open shift to an employee. The open shift's date can never change. */
async function assignOpenShift({ db, user, params, body }) {
  const ex = await db.collection('shifts').findOne({ _id: params.id });
  must(ex, 404, 'Shift not found');
  must(!ex.employeeId, 409, `This shift is already assigned to ${ex.employeeName}`);
  must(body.employeeId, 400, 'employeeId is required');
  if (body.date && body.date !== ex.date)
    throw new HttpError(409, `Open shifts belong to their date: this ${weekdayName(ex.date)} shift (${ex.date}) can only be assigned on ${weekdayName(ex.date)}.`);
  return updateShiftCore(db, user, ex._id, { employeeId: body.employeeId });
}

async function deleteShift({ db, user, params }) {
  const rules = await getRules(db);
  const s = await db.collection('shifts').findOne({ _id: params.id });
  must(s, 404, 'Shift not found');
  await assertEditable(db, s.locationId, s.weekStart, rules);
  await db.collection('shifts').deleteOne({ _id: s._id });
  await markDraft(db, user, s);
  await audit(db, user, 'DELETE', 'Shift', `Deleted shift ${shiftLabel(s)}`, s._id);
  return { ok: true };
}

/** Employee self-service pickup of a posted, published open shift (same rules as manager assignment). */
async function claimShift({ db, user, params }) {
  const rules = await getRules(db);
  must(rules.allowShiftPickup, 403, 'Open shift pickup is disabled by your administrator');
  must(user.employeeId, 400, 'Your login is not linked to an employee record');
  const s = await db.collection('shifts').findOne({ _id: params.id, employeeId: null, posted: true, published: true });
  must(s, 404, 'This open shift is no longer available');
  const upd = { ...s, employeeId: user.employeeId };
  const v = await validateShift(db, upd, { rules, ignoreId: s._id });
  throwIfInvalid(v);
  finalizeShift(upd, v.employee, rules);
  upd.published = true; // pickup of a published open shift stays published
  upd.updatedAt = new Date().toISOString(); upd.updatedBy = user.name;
  // Atomic guard: only succeeds if nobody claimed it in the meantime
  const r = await db.collection('shifts').replaceOne({ _id: s._id, employeeId: null }, upd);
  must(r.modifiedCount === 1, 409, 'This open shift was just taken by someone else');
  await audit(db, user, 'ASSIGN', 'Open Shift', `Picked up open shift ${s.date} (${weekdayName(s.date)}) ${s.start}-${s.end} ${s.department}/${s.jobTitle}`, s._id);
  return { ...upd, warnings: v.warnings };
}

async function listSchedules({ db, query }) {
  const ws = query.weekStart || fmt(weekStart());
  const rules = await getRules(db);
  const [locs, scheds, agg, budgets] = await Promise.all([
    db.collection('locations').find({}).sort({ name: 1 }).toArray(),
    db.collection('schedules').find({ weekStart: ws }).toArray(),
    db.collection('shifts').aggregate([{ $match: { weekStart: ws } }, { $group: { _id: '$locationId', shifts: { $sum: 1 },
      hours: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, '$hours', 0] } }, open: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, 0, 1] } },
      cost: { $sum: '$cost' }, unpublished: { $sum: { $cond: ['$published', 0, 1] } } } }]).toArray(),
    db.collection('laborbudgets').find({ weekStart: ws }).toArray(),
  ]);
  return locs.map((l) => {
    const s = scheds.find((x) => x.locationId === l._id) || {}; const a = agg.find((x) => x._id === l._id) || {};
    const b = budgets.find((x) => x.locationId === l._id);
    const cost = round2(a.cost);
    return { locationId: l._id, locationName: l.name, weekStart: ws, status: s.status || 'Not Started', publishedAt: s.publishedAt || null,
      editMode: !!s.editMode, locked: rules.requireEditModeForPublished && s.status === 'Published' && !s.editMode,
      shifts: a.shifts || 0, hours: a.hours || 0, open: a.open || 0, cost, unpublished: a.unpublished || 0,
      budgetAmount: b?.budgetAmount || null, budgetUtilization: b?.budgetAmount ? Math.round((cost / b.budgetAmount) * 100) : null,
      overBudget: !!(b?.budgetAmount && cost > b.budgetAmount * (rules.budgetWarningPct / 100)) };
  });
}
/** Turn Edit Mode on/off for a published schedule. */
async function setEditMode({ db, user, body }) {
  must(body.locationId && body.weekStart, 400, 'locationId and weekStart are required');
  const sc = await db.collection('schedules').findOne({ locationId: body.locationId, weekStart: body.weekStart });
  must(sc, 404, 'Schedule not found');
  must(sc.status === 'Published', 400, 'Edit Mode only applies to published schedules');
  const enabled = !!body.enabled;
  await db.collection('schedules').updateOne({ _id: sc._id }, { $set: { editMode: enabled, editModeBy: user.name, editModeAt: new Date().toISOString() } });
  await audit(db, user, 'EDIT_MODE', 'Schedule', `${enabled ? 'Enabled' : 'Disabled'} edit mode for ${sc.locationName || body.locationId}, week of ${body.weekStart}`, sc._id);
  return { ok: true, editMode: enabled };
}
async function publishSchedule({ db, user, body }) {
  must(body.locationId && body.weekStart, 400, 'locationId and weekStart are required');
  const loc = await db.collection('locations').findOne({ _id: body.locationId });
  must(loc, 404, 'Location not found');
  const changed = await db.collection('shifts').countDocuments({ locationId: loc._id, weekStart: body.weekStart, published: false });
  const r = await db.collection('shifts').updateMany({ locationId: loc._id, weekStart: body.weekStart }, { $set: { published: true } });
  const up = await db.collection('schedules').updateOne({ locationId: loc._id, weekStart: body.weekStart },
    { $set: { status: 'Published', locationName: loc.name, publishedAt: new Date().toISOString(), publishedBy: user.name, hasUnpublishedChanges: false, editMode: false }, $setOnInsert: { _id: newId() } }, { upsert: true });
  if (up.upsertedCount) await audit(db, user, 'CREATE', 'Schedule', `Created schedule for ${loc.name}, week of ${body.weekStart}`);
  await audit(db, user, 'PUBLISH', 'Schedule', `Published schedule for ${loc.name}, week of ${body.weekStart} (${r.matchedCount} shifts, ${changed} changed since last publish); edit mode closed`);
  return { ok: true, published: r.matchedCount, changed };
}
/**
 * Copy a week. Copies keep weekday, location, department and job role.
 * Assignments that would break rules in the target week (inactive employee, unavailable day,
 * approved time off) are converted into open shifts.
 */
async function copySchedule({ db, user, body }) {
  const rules = await getRules(db);
  const { locationId, fromWeek, toWeek, replace } = body;
  must(locationId && fromWeek && toWeek && fromWeek !== toWeek, 400, 'locationId, fromWeek and a different toWeek are required');
  must(fmt(weekStart(toWeek)) === toWeek && fmt(weekStart(fromWeek)) === fromWeek, 400, 'fromWeek and toWeek must be Mondays');
  await assertEditable(db, locationId, toWeek, rules);
  const src = await db.collection('shifts').find({ locationId, weekStart: fromWeek }).toArray();
  must(src.length, 404, 'Source week has no shifts to copy');
  const existing = await db.collection('shifts').countDocuments({ locationId, weekStart: toWeek });
  must(!existing || replace, 409, `Target week already has ${existing} shifts. Enable "replace" to overwrite.`);
  if (existing) await db.collection('shifts').deleteMany({ locationId, weekStart: toWeek });
  const diffDays = dayjs(toWeek).diff(dayjs(fromWeek), 'day');
  const [emps, offs] = await Promise.all([
    db.collection('employees').find({ locationId }).toArray(),
    db.collection('timeoffrequests').find({ locationId, status: 'Approved', endDate: { $gte: toWeek }, startDate: { $lte: fmt(dayjs(toWeek).add(6, 'day')) } }).toArray(),
  ]);
  let opened = 0;
  const copies = src.map((s) => {
    const date = fmt(dayjs(s.date).add(diffDays, 'day'));
    const c = { ...s, _id: newId(), date, weekStart: toWeek, published: false, copiedFrom: s._id, createdAt: new Date().toISOString(), createdBy: user.name };
    if (c.employeeId) {
      const e = emps.find((x) => x._id === c.employeeId);
      const idx = (dayjs(date).day() + 6) % 7;
      const bad = !e || e.status !== 'Active' || ['Terminated', 'On Leave'].includes(e.employmentStatus) || e.department !== c.department
        || (rules.enforceAvailability && e.availability?.[idx]?.available === false)
        || offs.some((o) => o.employeeId === c.employeeId && o.startDate <= date && o.endDate >= date);
      if (bad) { opened++; Object.assign(c, { employeeId: null, employeeName: '', cost: 0, posted: false, notes: 'Converted to open shift during copy (rule check)' }); }
    }
    return c;
  });
  await db.collection('shifts').insertMany(copies);
  const up = await db.collection('schedules').updateOne({ locationId, weekStart: toWeek },
    { $set: { status: 'Draft', hasUnpublishedChanges: true, editMode: false }, $setOnInsert: { _id: newId(), createdAt: new Date().toISOString(), createdBy: user.name } }, { upsert: true });
  await audit(db, user, up.upsertedCount ? 'CREATE' : 'COPY', 'Schedule', `Copied ${copies.length} shifts for ${locationId} from week ${fromWeek} to ${toWeek}${opened ? ` (${opened} converted to open shifts)` : ''}`);
  return { ok: true, copied: copies.length, convertedToOpen: opened };
}

// ============================== TIME & ATTENDANCE ==============================
async function flagMissingPunches(db) {
  await db.collection('timecards').updateMany({ clockOut: null, date: { $lt: today() }, exceptions: { $ne: 'Missing Punch' } },
    { $addToSet: { exceptions: 'Missing Punch' }, $set: { resolved: false } });
}
async function listTimecards({ db, user, query }) {
  await flagMissingPunches(db);
  const f = {};
  if (user.role === 'Employee') f.employeeId = user.employeeId;
  else ['employeeId', 'locationId'].forEach((k) => query[k] && (f[k] = query[k]));
  if (query.from || query.to) f.date = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  if (query.exceptionsOnly === 'true') { f['exceptions.0'] = { $exists: true }; f.resolved = { $ne: true }; }
  if (query.q) f.employeeName = regex(query.q);
  return paginate(db.collection('timecards'), f, query, { date: -1, employeeName: 1 });
}
async function clockStatus({ db, user, query }) {
  must(user.employeeId, 400, 'Your login is not linked to an employee record');
  const date = query.date || today();
  const [card, shift] = await Promise.all([
    db.collection('timecards').findOne({ employeeId: user.employeeId, date }),
    db.collection('shifts').findOne({ employeeId: user.employeeId, date }),
  ]);
  return { card, shift };
}
async function punch({ db, user, body }) {
  must(user.employeeId, 400, 'Your login is not linked to an employee record');
  const date = body.date || today();
  const time = body.time || dayjs().format('HH:mm');
  const col = db.collection('timecards');
  let card = await col.findOne({ employeeId: user.employeeId, date });
  const action = body.action;
  if (action === 'in') {
    must(!card, 400, 'You have already clocked in today');
    const [emp, shift] = await Promise.all([db.collection('employees').findOne({ _id: user.employeeId }), db.collection('shifts').findOne({ employeeId: user.employeeId, date })]);
    must(emp && emp.status === 'Active', 403, 'Inactive employees cannot clock in');
    card = { _id: newId(), employeeId: emp._id, employeeName: fullName(emp), locationId: emp.locationId, shiftId: shift?._id || null, date,
      scheduledStart: shift?.start || null, scheduledEnd: shift?.end || null, clockIn: time, mealStart: null, mealEnd: null, clockOut: null,
      rate: emp.hourlyRate, resolved: false, notes: shift ? '' : 'Unscheduled punch', exceptions: [] };
  } else {
    must(card, 400, 'You need to clock in first');
    must(!card.clockOut, 400, 'You have already clocked out today');
    if (action === 'mealStart') { must(!card.mealStart, 400, 'Meal break already started'); card.mealStart = time; }
    else if (action === 'mealEnd') { must(card.mealStart && !card.mealEnd, 400, 'Start a meal break first'); card.mealEnd = time; }
    else if (action === 'out') { must(!card.mealStart || card.mealEnd, 400, 'End your meal break before clocking out'); card.clockOut = time; }
    else throw new HttpError(400, 'Unknown punch action');
  }
  card = calcTimecard(card);
  card.cost = round2(card.totalHours * card.rate);
  await col.replaceOne({ _id: card._id }, card, { upsert: true });
  await audit(db, user, 'PUNCH', 'Timecard', `Punch ${action} at ${time}`, card._id);
  return card;
}
async function updateTimecard({ db, user, params, body }) {
  const ex = await db.collection('timecards').findOne({ _id: params.id });
  must(ex, 404, 'Timecard not found');
  const merged = { ...ex };
  ['clockIn', 'clockOut', 'mealStart', 'mealEnd', 'notes'].forEach((k) => body[k] !== undefined && (merged[k] = body[k] || null));
  let card = calcTimecard(merged);
  card.cost = round2(card.totalHours * card.rate);
  card.resolved = body.resolved !== undefined ? !!body.resolved : card.exceptions.length === 0;
  if (card.resolved) { card.resolvedBy = user.name; card.resolvedAt = new Date().toISOString(); }
  await db.collection('timecards').replaceOne({ _id: card._id }, card);
  const changes = diff(ex, card, ['clockIn', 'mealStart', 'mealEnd', 'clockOut', 'notes']);
  await audit(db, user, 'UPDATE', 'Timecard', `Edited timecard for ${card.employeeName} on ${card.date}${changes.length ? ': ' + changes.join('; ') : ''}${card.resolved ? ' (exception resolved)' : ''}`, card._id);
  return card;
}

// ============================== TIME OFF ==============================
async function listTimeoff({ db, user, query }) {
  const f = {};
  if (user.role === 'Employee') f.employeeId = user.employeeId;
  else ['employeeId', 'locationId'].forEach((k) => query[k] && (f[k] = query[k]));
  ['status', 'type'].forEach((k) => query[k] && (f[k] = query[k]));
  if (query.q) f.employeeName = regex(query.q);
  return paginate(db.collection('timeoffrequests'), f, query, { status: -1, startDate: 1 });
}
export async function createTimeoffCore(db, user, eid, body) {
  must(eid, 400, 'Employee is required');
  must(['Vacation', 'Sick', 'Personal'].includes(body.type), 400, 'Type must be Vacation, Sick or Personal');
  must(body.startDate && body.endDate && body.endDate >= body.startDate, 400, 'Valid start and end dates are required');
  const e = await db.collection('employees').findOne({ _id: eid });
  must(e, 404, 'Employee not found');
  const overlap = await db.collection('timeoffrequests').findOne({ employeeId: eid, status: { $in: ['Pending', 'Approved'] }, startDate: { $lte: body.endDate }, endDate: { $gte: body.startDate } });
  must(!overlap, 409, 'An existing request overlaps these dates');
  const days = dayjs(body.endDate).diff(dayjs(body.startDate), 'day') + 1;
  const t = { _id: newId(), employeeId: e._id, employeeName: fullName(e), locationId: e.locationId, department: e.department, type: body.type,
    startDate: body.startDate, endDate: body.endDate, days, hours: Number(body.hours) || days * 8, reason: body.reason || '', status: 'Pending',
    submittedAt: new Date().toISOString(), decidedAt: null, decidedBy: null, comment: '', externalId: body.externalId || null };
  await db.collection('timeoffrequests').insertOne(t);
  await audit(db, user, 'CREATE', 'Time Off', `${t.type} request ${t.startDate} to ${t.endDate} for ${t.employeeName}`, t._id);
  return t;
}
async function createTimeoff({ db, user, body }) {
  const eid = user.role === 'Employee' ? user.employeeId : body.employeeId || user.employeeId;
  return createTimeoffCore(db, user, eid, body);
}
async function decideTimeoff({ db, user, params, body }) {
  must(['Approved', 'Rejected'].includes(body.decision), 400, 'Decision must be Approved or Rejected');
  const t = await db.collection('timeoffrequests').findOne({ _id: params.id });
  must(t, 404, 'Request not found');
  must(t.status === 'Pending', 400, `Request is already ${t.status}`);
  const upd = { status: body.decision, decidedAt: new Date().toISOString(), decidedBy: user.name, comment: body.comment || '' };
  await db.collection('timeoffrequests').updateOne({ _id: t._id }, { $set: upd });
  // Warn the approver about scheduled shifts that now conflict with approved leave
  const conflicts = body.decision === 'Approved'
    ? await db.collection('shifts').countDocuments({ employeeId: t.employeeId, date: { $gte: t.startDate, $lte: t.endDate } }) : 0;
  await audit(db, user, body.decision === 'Approved' ? 'APPROVE' : 'REJECT', 'Time Off', `${body.decision} ${t.type} request for ${t.employeeName} (${t.startDate} to ${t.endDate})${conflicts ? ` - ${conflicts} scheduled shift(s) conflict` : ''}`, t._id);
  return { ...t, ...upd, warnings: conflicts ? [`${t.employeeName} has ${conflicts} scheduled shift(s) during this leave. Reassign them in Scheduling.`] : [] };
}
async function cancelTimeoff({ db, user, params }) {
  const t = await db.collection('timeoffrequests').findOne({ _id: params.id });
  must(t, 404, 'Request not found');
  must(user.role !== 'Employee' || t.employeeId === user.employeeId, 403, 'Forbidden');
  must(t.status === 'Pending', 400, 'Only pending requests can be cancelled');
  await db.collection('timeoffrequests').updateOne({ _id: t._id }, { $set: { status: 'Cancelled', decidedAt: new Date().toISOString(), decidedBy: user.name } });
  await audit(db, user, 'CANCEL', 'Time Off', `Cancelled ${t.type} request for ${t.employeeName}`, t._id);
  return { ok: true };
}

// ============================== FORECASTING ==============================
async function listForecasts({ db, query }) {
  const f = {};
  if (query.locationId) f.locationId = query.locationId;
  if (query.from || query.to) f.date = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  return db.collection('forecasts').find(f).sort({ date: 1 }).toArray();
}
/**
 * Sample forecast generation logic:
 *   traffic(d) = weighted average of the same weekday over the last 4 weeks (0.4/0.3/0.2/0.1)
 *                x growth factor (default +2%) x optional promo uplift
 *   sales      = traffic x conversion (32%) x average ticket ($58)
 *   labor hrs  = traffic x labor standard (0.105 hrs per customer)
 *   staff      = ceil(labor hrs / 8)
 */
async function generateForecast({ db, user, body }) {
  const locs = body.locationId ? [body.locationId] : (await db.collection('locations').find({}).toArray()).map((l) => l._id);
  const weeks = Math.min(12, Math.max(1, Number(body.weeks) || 4));
  const growth = 1 + (Number(body.growthPct ?? 2) / 100);
  const uplift = 1 + (Number(body.promoPct || 0) / 100);
  const start = weekStart().add(1, 'week');
  let n = 0;
  for (const locationId of locs) {
    const hist = await db.collection('forecasts').find({ locationId, date: { $lt: fmt(start) } }).sort({ date: -1 }).limit(28).toArray();
    const loc = await db.collection('locations').findOne({ _id: locationId });
    const ops = [];
    for (let d = 0; d < weeks * 7; d++) {
      const date = start.add(d, 'day');
      const same = hist.filter((h) => dayjs(h.date).day() === date.day()).slice(0, 4);
      const w = [0.4, 0.3, 0.2, 0.1];
      const base = same.length ? same.reduce((a, h, i) => a + h.customerTraffic * w[i], 0) / w.slice(0, same.length).reduce((a, b) => a + b, 0) : (loc?.baseTraffic || 450);
      const traffic = Math.round(base * growth * uplift);
      const laborDemandHours = round2(traffic * 0.105);
      const doc = { locationId, date: fmt(date), weekStart: fmt(weekStart(date)), dayOfWeek: date.format('ddd').toLowerCase(), customerTraffic: traffic,
        salesProjection: Math.round(traffic * 0.32 * 58), laborDemandHours, recommendedStaff: Math.ceil(laborDemandHours / 8),
        method: `Weighted 4-week moving average, growth ${Math.round((growth - 1) * 100)}%, promo ${Math.round((uplift - 1) * 100)}%`, createdAt: new Date().toISOString() };
      ops.push({ updateOne: { filter: { locationId, date: doc.date }, update: { $set: doc, $setOnInsert: { _id: newId() } }, upsert: true } });
    }
    if (ops.length) { await db.collection('forecasts').bulkWrite(ops); n += ops.length; }
  }
  await audit(db, user, 'GENERATE', 'Forecast', `Generated ${weeks}-week forecast (${n} daily records)`);
  return { ok: true, records: n };
}

// ============================== LABOR BUDGETING ==============================
export async function listBudgets({ db, query }) {
  const f = query.locationId ? { locationId: query.locationId } : {};
  const [budgets, sched, actual] = await Promise.all([
    db.collection('laborbudgets').find(f).sort({ weekStart: 1, locationName: 1 }).toArray(),
    db.collection('shifts').aggregate([{ $match: { ...f, employeeId: { $ne: null } } }, { $group: { _id: { l: '$locationId', w: '$weekStart' }, h: { $sum: '$hours' }, c: { $sum: '$cost' } } }]).toArray(),
    db.collection('timecards').aggregate([{ $match: f }, { $group: { _id: { l: '$locationId', d: '$date' }, h: { $sum: '$totalHours' }, c: { $sum: '$cost' } } }]).toArray(),
  ]);
  // Overlay live scheduled hours (from shifts) and actual hours (from timecards) where they exist
  const curWs = fmt(weekStart());
  return budgets.map((b) => {
    const s = sched.find((x) => x._id.l === b.locationId && x._id.w === b.weekStart);
    const a = actual.filter((x) => x._id.l === b.locationId && fmt(weekStart(x._id.d)) === b.weekStart);
    const out = { ...b };
    if (s) { out.plannedHours = round2(s.h); out.plannedCost = round2(s.c); }
    if (a.length && b.weekStart >= fmt(weekStart().subtract(1, 'week'))) { out.actualHours = round2(a.reduce((x, y) => x + y.h, 0)); out.actualCost = round2(a.reduce((x, y) => x + y.c, 0)); }
    out.hoursVariance = round2(out.budgetHours - (out.actualHours ?? out.plannedHours));
    out.costVariance = round2(out.budgetAmount - (out.actualCost ?? out.plannedCost));
    out.utilization = out.budgetAmount ? Math.round(((out.actualCost ?? out.plannedCost) / out.budgetAmount) * 100) : 0;
    out.isCurrent = b.weekStart === curWs;
    return out;
  });
}
async function updateBudget({ db, user, params, body }) {
  const before = await db.collection('laborbudgets').findOne({ _id: params.id });
  must(before, 404, 'Budget not found');
  const d = {};
  ['budgetHours', 'budgetAmount'].forEach((k) => { if (body[k] !== undefined) { d[k] = Number(body[k]); must(d[k] >= 0, 400, `${k} must be zero or positive`); } });
  if (body.notes !== undefined) d.notes = body.notes;
  const r = await db.collection('laborbudgets').findOneAndUpdate({ _id: params.id }, { $set: d }, { returnDocument: 'after' });
  if (r.weekStart === fmt(weekStart()) && d.budgetAmount !== undefined) await db.collection('locations').updateOne({ _id: r.locationId }, { $set: { weeklyLaborBudget: d.budgetAmount } });
  await audit(db, user, 'UPDATE', 'Labor Budget', `Updated labor budget for ${r.locationName}, week of ${r.weekStart}: ${diff(before, d, ['budgetHours', 'budgetAmount', 'notes']).join('; ') || 'no changes'}`, r._id);
  return r;
}

// ============================== REPORTS ==============================
const REPORTS = {
  roster: { title: 'Employee Roster Report', columns: [['employeeId', 'Employee ID'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['locationName', 'Location'],
    ['department', 'Department'], ['jobTitle', 'Job Title'], ['employmentType', 'Type'], ['hireDate', 'Hire Date'], ['hourlyRate', 'Hourly Rate'], ['managerName', 'Manager'], ['status', 'Status']],
    async rows(db, q) { const f = {}; if (q.locationId) f.locationId = q.locationId; if (q.status) f.status = q.status;
      return (await db.collection('employees').find(f).sort({ lastName: 1 }).toArray()).map((e) => ({ ...e, name: fullName(e) })); } },
  schedule: { title: 'Schedule Report', columns: [['date', 'Date'], ['locationName', 'Location'], ['employeeName', 'Employee'], ['jobTitle', 'Job Title'], ['department', 'Department'],
    ['start', 'Start'], ['end', 'End'], ['hours', 'Hours'], ['cost', 'Cost'], ['status', 'Status']],
    async rows(db, q, locs) { const f = { weekStart: q.weekStart || fmt(weekStart()) }; if (q.locationId) f.locationId = q.locationId;
      return (await db.collection('shifts').find(f).sort({ date: 1, start: 1 }).toArray()).map((s) => ({ ...s, employeeName: s.employeeName || '(Open shift)',
        locationName: locs[s.locationId], status: `${s.published ? 'Published' : 'Draft'}${s.overtime ? ' / Overtime' : ''}` })); } },
  attendance: { title: 'Attendance Report', columns: [['date', 'Date'], ['employeeName', 'Employee'], ['locationName', 'Location'], ['scheduled', 'Scheduled'], ['clockIn', 'Clock In'],
    ['mealStart', 'Meal Start'], ['mealEnd', 'Meal End'], ['clockOut', 'Clock Out'], ['totalHours', 'Hours'], ['exceptionText', 'Exceptions']],
    async rows(db, q, locs) { const f = { date: { $gte: q.from || fmt(weekStart().subtract(1, 'week')), $lte: q.to || today() } }; if (q.locationId) f.locationId = q.locationId;
      return (await db.collection('timecards').find(f).sort({ date: -1 }).toArray()).map((t) => ({ ...t, locationName: locs[t.locationId],
        scheduled: t.scheduledStart ? `${t.scheduledStart}-${t.scheduledEnd}` : 'Unscheduled', exceptionText: [...t.exceptions, t.earlyArrival ? 'Early Arrival' : ''].filter(Boolean).join('; ') + (t.resolved ? ' (resolved)' : '') })); } },
  laborcost: { title: 'Labor Cost Report', columns: [['weekStart', 'Week Of'], ['locationName', 'Location'], ['budgetHours', 'Budget Hrs'], ['plannedHours', 'Scheduled Hrs'],
    ['actualHours', 'Actual Hrs'], ['budgetAmount', 'Budget $'], ['plannedCost', 'Scheduled $'], ['actualCost', 'Actual $'], ['costVariance', 'Variance $'], ['utilization', 'Utilization %']],
    async rows(db, q) { return listBudgets({ db, query: q }); } },
  timeoff: { title: 'Time Off Report', columns: [['employeeName', 'Employee'], ['locationName', 'Location'], ['type', 'Type'], ['startDate', 'Start'], ['endDate', 'End'],
    ['days', 'Days'], ['reason', 'Reason'], ['status', 'Status'], ['decidedBy', 'Decided By'], ['comment', 'Comment']],
    async rows(db, q, locs) { const f = {}; if (q.locationId) f.locationId = q.locationId; if (q.status) f.status = q.status;
      return (await db.collection('timeoffrequests').find(f).sort({ startDate: -1 }).toArray()).map((t) => ({ ...t, locationName: locs[t.locationId] })); } },
};
async function runReport({ db, user, params, query }) {
  const def = REPORTS[params.type];
  must(def, 404, 'Unknown report');
  const locs = Object.fromEntries((await db.collection('locations').find({}).toArray()).map((l) => [l._id, l.name]));
  const rows = await def.rows(db, query, locs);
  await db.collection('reports').insertOne({ _id: newId(), type: params.type, runBy: user.name, rowCount: rows.length, format: query.format === 'csv' ? 'CSV' : 'View', createdAt: new Date().toISOString() });
  if (query.format === 'csv') await audit(db, user, 'EXPORT', 'Report', `Exported ${def.title} (${rows.length} rows) to CSV`);
  return { title: def.title, columns: def.columns.map(([key, label]) => ({ key, label })), rows };
}
async function reportHistory({ db }) { return db.collection('reports').find({}).sort({ createdAt: -1 }).limit(15).toArray(); }

// ============================== ADMINISTRATION ==============================
async function listUsers({ db, query }) {
  const f = {};
  if (query.q) f.$or = [{ name: regex(query.q) }, { email: regex(query.q) }];
  if (query.role) f.role = query.role;
  const r = await paginate(db.collection('users'), f, query, { role: 1, name: 1 });
  r.items = r.items.map(publicUser);
  return r;
}
async function createUser({ db, user, body }) {
  must(body.email && body.password && body.name && body.role, 400, 'Name, email, password and role are required');
  must(['Employee', 'Manager', 'Administrator'].includes(body.role), 400, 'Invalid role');
  must(String(body.password).length >= 6, 400, 'Password must be at least 6 characters');
  const email = body.email.trim().toLowerCase();
  must(!(await db.collection('users').findOne({ email })), 409, 'A user with this email already exists');
  const u = { _id: newId(), email, name: body.name, role: body.role, employeeId: body.employeeId || null, active: true, password: hashPassword(body.password), createdAt: new Date().toISOString(), lastLogin: null };
  await db.collection('users').insertOne(u);
  await audit(db, user, 'CREATE', 'User', `Created user ${email} (${u.role})`, u._id);
  return publicUser(u);
}
async function updateUser({ db, user, params, body }) {
  const d = {};
  ['name', 'role', 'active', 'employeeId'].forEach((k) => body[k] !== undefined && (d[k] = body[k]));
  if (d.role) must(['Employee', 'Manager', 'Administrator'].includes(d.role), 400, 'Invalid role');
  if (body.password) { must(String(body.password).length >= 6, 400, 'Password must be at least 6 characters'); d.password = hashPassword(body.password); }
  must(!(params.id === user.sub && (d.active === false || (d.role && d.role !== 'Administrator'))), 400, 'You cannot disable or demote your own account');
  const r = await db.collection('users').findOneAndUpdate({ _id: params.id }, { $set: d }, { returnDocument: 'after' });
  must(r, 404, 'User not found');
  await audit(db, user, 'UPDATE', 'User', `Updated user ${r.email}${d.role ? ' role=' + d.role : ''}${d.password ? ' (password reset)' : ''}`, r._id);
  return publicUser(r);
}
async function deleteUser({ db, user, params }) {
  must(params.id !== user.sub, 400, 'You cannot delete your own account');
  const r = await db.collection('users').findOneAndDelete({ _id: params.id });
  must(r, 404, 'User not found');
  await audit(db, user, 'DELETE', 'User', `Deleted user ${r.email}`, r._id);
  return { ok: true };
}
async function getSettings({ db }) {
  const docs = await db.collection('settings').find({}).toArray();
  const out = Object.fromEntries(docs.map((d) => [d._id, d]));
  out.system = { ...DEFAULT_RULES, ...(out.system || {}), _id: 'system' }; // new audit rules appear with defaults
  return out;
}
async function updateSettings({ db, user, params, body }) {
  must(['organization', 'system', 'roles'].includes(params.key), 404, 'Unknown settings group');
  const { _id, ...rest } = body;
  if (params.key === 'system') {
    for (const [k, v] of Object.entries(rest)) {
      if (typeof DEFAULT_RULES[k] === 'number') { rest[k] = Number(v); must(Number.isFinite(rest[k]) && rest[k] >= 0, 400, `${k} must be a positive number`); }
      if (typeof DEFAULT_RULES[k] === 'boolean') rest[k] = v === true || v === 'true';
    }
    if (rest.maxDailyHours !== undefined && rest.maxWeeklyHours !== undefined) must(rest.maxDailyHours <= rest.maxWeeklyHours, 400, 'maxDailyHours cannot exceed maxWeeklyHours');
  }
  const before = await db.collection('settings').findOne({ _id: params.key });
  await db.collection('settings').updateOne({ _id: params.key }, { $set: rest }, { upsert: true });
  invalidateRules();
  await audit(db, user, 'UPDATE', 'Settings', `Updated ${params.key} settings: ${diff(before || {}, rest, Object.keys(rest)).join('; ') || 'no changes'}`);
  return { ok: true };
}
async function listAudit({ db, query }) {
  const f = {};
  if (query.q) f.$or = [{ details: regex(query.q) }, { userName: regex(query.q) }];
  ['action', 'entity'].forEach((k) => query[k] && (f[k] = query[k]));
  return paginate(db.collection('auditlogs'), f, query, { timestamp: -1 });
}
async function reseed({ db, user }) { await seedAll(db); invalidateRules(); await audit(db, user, 'RESET', 'Database', 'Demo data reset by administrator'); return { ok: true }; }
async function health({ db }) { await db.command({ ping: 1 }); return { ok: true, time: new Date().toISOString() }; }

/** Route table: [method, path pattern, handler, allowed roles (null = public, [] = any signed-in user)] */
export const routes = [
  ['GET', 'health', health, null],
  ['POST', 'auth/login', login, null],
  ['GET', 'auth/me', me, []],
  ['GET', 'meta', meta, []],
  ['GET', 'dashboard', dashboard, []],
  ['GET', 'employees', listEmployees, MGR], ['POST', 'employees', createEmployee, MGR],
  ['GET', 'employees/:id', getEmployee, []], ['PUT', 'employees/:id', updateEmployee, MGR], ['DELETE', 'employees/:id', deleteEmployee, MGR],
  ['GET', 'locations', listLocations, []], ['POST', 'locations', createLocation, MGR],
  ['PUT', 'locations/:id', updateLocation, MGR], ['DELETE', 'locations/:id', deleteLocation, ADMIN],
  ['GET', 'shifts', listShifts, []], ['POST', 'shifts', createShift, MGR], ['POST', 'shifts/:id/claim', claimShift, []],
  ['POST', 'shifts/:id/assign', assignOpenShift, MGR],
  ['PUT', 'shifts/:id', updateShift, MGR], ['DELETE', 'shifts/:id', deleteShift, MGR],
  ['GET', 'schedules', listSchedules, MGR], ['POST', 'schedules/publish', publishSchedule, MGR], ['POST', 'schedules/copy', copySchedule, MGR],
  ['POST', 'schedules/edit-mode', setEditMode, MGR],
  ['GET', 'timecards', listTimecards, []], ['GET', 'timecards/status', clockStatus, []], ['POST', 'timecards/punch', punch, []],
  ['PUT', 'timecards/:id', updateTimecard, MGR],
  ['GET', 'timeoff', listTimeoff, []], ['POST', 'timeoff', createTimeoff, []], ['PUT', 'timeoff/:id/decision', decideTimeoff, MGR], ['DELETE', 'timeoff/:id', cancelTimeoff, []],
  ['GET', 'forecasts', listForecasts, MGR], ['POST', 'forecasts/generate', generateForecast, MGR],
  ['GET', 'budgets', listBudgets, MGR], ['PUT', 'budgets/:id', updateBudget, MGR],
  ['GET', 'reports', reportHistory, MGR], ['GET', 'reports/:type', runReport, MGR],
  ['GET', 'admin/users', listUsers, ADMIN], ['POST', 'admin/users', createUser, ADMIN], ['PUT', 'admin/users/:id', updateUser, ADMIN], ['DELETE', 'admin/users/:id', deleteUser, ADMIN],
  ['GET', 'admin/settings', getSettings, MGR], ['PUT', 'admin/settings/:key', updateSettings, ADMIN],
  ['GET', 'admin/audit', listAudit, ADMIN], ['POST', 'admin/reseed', reseed, ADMIN],
];
```

---

### MODIFIED: `server/router.js`

**Location:** `kp-wfm/server/router.js`  
**Change:** Registers core + integration + api-docs routes; logs API_REQUEST / API_FAILURE

```javascript
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
```

---

### MODIFIED: `server/http.js`

**Location:** `kp-wfm/server/http.js`  
**Change:** HttpError carries validation details[]; invalid JSON returns 400

```javascript
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
```

---

### MODIFIED: `src/pages/Scheduling.jsx`

**Location:** `kp-wfm/src/pages/Scheduling.jsx`  
**Change:** Same-date drag rule, assign endpoint, Edit Mode toggle/lock banner, budget banner, locked fields, dept-filtered employees, required skills, rule-violation panel

```jsx
/**
 * Scheduling workspace: weekly grid (drag & drop) and daily timeline.
 * - Drag a shift chip to another employee on the SAME day to reassign (or onto "Open Shifts" to unassign).
 *   Shifts never move between days: an open shift belongs to its date (Monday shift → Monday only).
 * - Click an empty cell to create a shift, click a chip to edit
 * - Published schedules are read-only until Edit Mode is enabled
 * - Every create/edit/assign is validated server-side (rules engine); warnings (budget, overtime) show as toasts
 */
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { useForm } from 'react-hook-form';
import { ChevronLeft, ChevronRight, Send, Copy, Plus, CalendarDays, AlertTriangle, Trash2, Lock, Unlock, ShieldCheck } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, PageLoader, ErrorState, ConfirmModal, Spinner, EmptyState } from '../components/ui';
import { weekStart, ymd, time12, money, num } from '../lib/format';

const TEMPLATES = { Morning: ['08:00', '16:00'], Mid: ['10:00', '18:00'], Evening: ['12:00', '20:00'] };
const chipColor = (s) => !s.employeeId ? 'bg-amber-50 border-amber-300 text-amber-800' : s.overtime ? 'bg-red-50 border-red-300 text-red-800'
  : s.start < '10:00' ? 'bg-brand-50 border-brand-300 text-brand-800' : s.start < '12:00' ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-indigo-50 border-indigo-300 text-indigo-800';
const dayIndex = (date) => (dayjs(date).day() + 6) % 7;
const isAvailable = (emp, date) => emp?.availability?.[dayIndex(date)]?.available !== false;
const isActive = (e) => e.status === 'Active' && !['Terminated', 'On Leave'].includes(e.employmentStatus);

export default function Scheduling() {
  const { meta, load } = useMeta();
  const [ws, setWs] = useState(weekStart());
  const [locationId, setLocationId] = useState('');
  const [department, setDepartment] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState('week');
  const [dayIdx, setDayIdx] = useState(dayIndex(dayjs()));
  const [modal, setModal] = useState(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(null);
  useEffect(() => { load().then((m) => m && !locationId && setLocationId(m.locations[0]?._id)); }, [load]); // eslint-disable-line

  const wsStr = ymd(ws);
  const { data: shifts, loading, error, reload } = useFetch('/shifts', { weekStart: wsStr, locationId, department }, { skip: !locationId });
  const { data: schedules, reload: reloadSched } = useFetch('/schedules', { weekStart: wsStr });
  const sched = schedules?.find((s) => s.locationId === locationId);
  const locked = !!sched?.locked;
  const days = Array.from({ length: 7 }, (_, i) => ws.add(i, 'day'));

  const employees = useMemo(() => (meta?.employees || []).filter((e) => e.locationId === locationId && isActive(e)
    && (!department || e.department === department) && (!q || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q.toLowerCase()))), [meta, locationId, department, q]);
  const byCell = useMemo(() => { const m = {}; (shifts || []).forEach((s) => { const k = `${s.employeeId || 'open'}|${s.date}`; (m[k] ||= []).push(s); }); return m; }, [shifts]);
  const assigned = (shifts || []).filter((s) => s.employeeId);
  const totals = { hours: assigned.reduce((a, s) => a + s.hours, 0), cost: assigned.reduce((a, s) => a + s.cost, 0), open: (shifts || []).filter((s) => !s.employeeId).length, draft: (shifts || []).filter((s) => !s.published).length };
  const refresh = () => { reload(); reloadSched(); };
  const blockedByLock = () => { if (locked) { toast.error('This schedule is published. Click "Enable Edit Mode" before making changes.'); return true; } return false; };

  /** Drag & drop handler – enforces "same date" before calling the API. */
  const move = async (shiftId, employeeId, date) => {
    const s = shifts.find((x) => x._id === shiftId);
    if (!s || (s.employeeId === employeeId && s.date === date)) return;
    if (blockedByLock()) return;
    if (s.date !== date) {
      toast.error(`Shifts keep their original date. This ${dayjs(s.date).format('dddd')} shift can only be assigned on ${dayjs(s.date).format('dddd')} (${dayjs(s.date).format('MMM D')}).`);
      return;
    }
    try {
      const r = !s.employeeId && employeeId
        ? await api(`/shifts/${shiftId}/assign`, { method: 'POST', body: { employeeId, date } })
        : await api(`/shifts/${shiftId}`, { method: 'PUT', body: { employeeId } });
      toast.success(!s.employeeId ? 'Open shift assigned' : employeeId ? 'Shift reassigned' : 'Shift moved to open shifts');
      toast.warnings(r.warnings);
      refresh();
    } catch (e) { toast.error(e.message); }
  };
  const publish = async () => {
    setBusy(true);
    try { const r = await api('/schedules/publish', { method: 'POST', body: { locationId, weekStart: wsStr } }); toast.success(`Schedule published (${r.published} shifts, ${r.changed} changed). Employees can now see it.`); refresh(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const toggleEditMode = async (enabled) => {
    setBusy(true);
    try { await api('/schedules/edit-mode', { method: 'POST', body: { locationId, weekStart: wsStr, enabled } }); toast.info(enabled ? 'Edit Mode enabled – changes stay in draft until you re-publish.' : 'Edit Mode closed.'); refresh(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const copyPrev = async (replace) => {
    setBusy(true);
    try {
      const r = await api('/schedules/copy', { method: 'POST', body: { locationId, fromWeek: ymd(ws.subtract(7, 'day')), toWeek: wsStr, replace } });
      toast.success(`Copied ${r.copied} shifts from previous week`);
      if (r.convertedToOpen) toast.warning(`${r.convertedToOpen} copied shift(s) became open shifts because the employee is inactive, unavailable, on approved leave or changed department.`);
      setCopyOpen(false); refresh();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  if (!meta) return <PageLoader />;
  const loc = meta.locations.find((l) => l._id === locationId);

  // Rendered as a plain function (not a component) so drag state updates don't remount the dragged chip
  const renderCell = (emp, d) => {
    const date = ymd(d), key = `${emp?._id || 'open'}|${date}`, list = byCell[key] || [];
    const unavailable = emp && !isAvailable(emp, date);
    return (
      <td key={key} onDragOver={(e) => { e.preventDefault(); setDragOver(key); }} onDragLeave={() => setDragOver(null)}
        onDrop={(e) => { e.preventDefault(); setDragOver(null); move(e.dataTransfer.getData('text/plain'), emp?._id || null, date); }}
        onClick={() => { if (blockedByLock()) return; setModal({ employeeId: emp?._id || '', date, locationId, department: emp?.department || department || 'Retail Sales', jobTitle: emp?.jobTitle || 'Sales Associate' }); }}
        className={`border border-slate-100 p-1 align-top h-16 min-w-[120px] cursor-pointer transition ${dragOver === key ? 'bg-brand-100' : unavailable ? 'bg-[repeating-linear-gradient(45deg,#f8fafc,#f8fafc_6px,#f1f5f9_6px,#f1f5f9_12px)]' : 'hover:bg-brand-50/50'}`}>
        {unavailable && !list.length && <span className="text-[10px] text-slate-400">Unavailable</span>}
        {list.map((s) => (
          <div key={s._id} draggable={!locked} onDragStart={(e) => e.dataTransfer.setData('text/plain', s._id)} onClick={(e) => { e.stopPropagation(); setModal(s); }}
            className={`mb-1 rounded-md border px-2 py-1 text-[11px] leading-tight ${locked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${chipColor(s)} ${!s.published ? 'border-dashed' : ''}`}>
            <p className="font-semibold">{time12(s.start)}–{time12(s.end)}</p>
            <p className="truncate opacity-80">{s.employeeId ? s.jobTitle : `${s.jobTitle}${s.posted ? ' · posted' : ''}`}</p>
            {s.requiredSkills?.length > 0 && <p className="truncate opacity-60">⚑ {s.requiredSkills.join(', ')}</p>}
          </div>))}
      </td>);
  };

  return (
    <>
      <PageHeader title="Scheduling" subtitle={loc ? `${loc.name} · ${loc.region}` : ''}
        actions={<>
          {sched?.status === 'Published' && (sched.editMode
            ? <button className="btn-secondary" onClick={() => toggleEditMode(false)} disabled={busy}><Lock className="h-4 w-4" />Exit Edit Mode</button>
            : <button className="btn-secondary" onClick={() => toggleEditMode(true)} disabled={busy}><Unlock className="h-4 w-4" />Enable Edit Mode</button>)}
          <button className="btn-secondary" onClick={() => !blockedByLock() && setCopyOpen(true)} disabled={busy}><Copy className="h-4 w-4" />Copy previous week</button>
          <button className="btn-secondary" onClick={() => !blockedByLock() && setModal({ locationId, date: ymd(days[view === 'day' ? dayIdx : 0]), employeeId: '', department: department || 'Retail Sales', jobTitle: 'Sales Associate' })}><Plus className="h-4 w-4" />Add shift</button>
          <button className="btn-primary" onClick={publish} disabled={busy || !shifts?.length}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <Send className="h-4 w-4" />}Publish</button>
        </>} />

      <div className="card p-3 mb-4 flex flex-col xl:flex-row gap-3 xl:items-center">
        <div className="flex items-center gap-2">
          <button className="btn-secondary px-2" onClick={() => setWs(ws.subtract(7, 'day'))}><ChevronLeft className="h-4 w-4" /></button>
          <div className="text-sm font-semibold min-w-[170px] text-center">{ws.format('MMM D')} – {ws.add(6, 'day').format('MMM D, YYYY')}</div>
          <button className="btn-secondary px-2" onClick={() => setWs(ws.add(7, 'day'))}><ChevronRight className="h-4 w-4" /></button>
          <button className="btn-ghost btn-sm" onClick={() => setWs(weekStart())}>This week</button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-1">
          <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>{meta.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
          <select className="input" value={department} onChange={(e) => setDepartment(e.target.value)}><option value="">All departments</option>{meta.departments.map((d) => <option key={d}>{d}</option>)}</select>
          <SearchBar value={q} onChange={setQ} placeholder="Filter employees…" />
        </div>
        <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm shrink-0">
          {['week', 'day'].map((v) => <button key={v} onClick={() => setView(v)} className={`px-4 py-2 capitalize ${view === v ? 'bg-brand-600 text-white' : 'bg-white text-slate-600'}`}>{v}</button>)}
        </div>
      </div>

      {locked && (
        <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-800 flex items-center gap-2">
          <Lock className="h-4 w-4" />This schedule is published and read-only. Enable Edit Mode to change shifts; all changes are tracked in the audit log.
        </div>)}
      {sched?.editMode && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
          <Unlock className="h-4 w-4" />Edit Mode is on. Changes are saved as draft and become visible to employees when you re-publish.
        </div>)}
      {sched?.overBudget && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />Labor budget warning: scheduled cost {money(sched.cost)} is {sched.budgetUtilization}% of the weekly budget {money(sched.budgetAmount)}.
        </div>)}

      <div className="flex flex-wrap gap-3 mb-4 text-sm items-center">
        <Badge>{sched?.status || 'Not Started'}</Badge>
        {sched?.editMode && <Badge tone="yellow">Edit mode</Badge>}
        {totals.draft > 0 && sched?.status === 'Published' && <Badge tone="yellow">{totals.draft} unpublished changes</Badge>}
        <span className="text-slate-600">Scheduled: <b>{num(totals.hours)} hrs</b></span>
        <span className="text-slate-600">Labor cost: <b>{money(totals.cost)}</b>{sched?.budgetAmount ? <> / {money(sched.budgetAmount)} (<b className={sched.overBudget ? 'text-red-600' : ''}>{sched.budgetUtilization}%</b>)</> : null}</span>
        <span className="text-slate-600">Open shifts: <b>{totals.open}</b></span>
        <span className="text-slate-400 hidden md:inline">· Drag shifts between employees on the same day · dashed = draft · red = overtime</span>
      </div>

      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !shifts ? <PageLoader /> : view === 'week' ? (
        <div className="card overflow-x-auto relative">
          {loading && <div className="absolute inset-0 bg-white/50 z-10 flex items-center justify-center"><Spinner className="h-7 w-7" /></div>}
          <table className="w-full border-collapse">
            <thead><tr>
              <th className="th sticky left-0 z-[1] min-w-[190px]">Employee</th>
              {days.map((d) => <th key={ymd(d)} className={`th text-center ${ymd(d) === ymd(dayjs()) ? 'text-brand-700 bg-brand-50' : ''}`}>{d.format('ddd')}<br /><span className="font-normal normal-case">{d.format('MMM D')}</span></th>)}
            </tr></thead>
            <tbody>
              <tr className="bg-amber-50/40">
                <td className="td sticky left-0 bg-amber-50 font-semibold text-amber-800 z-[1]">Open Shifts</td>
                {days.map((d) => renderCell(null, d))}
              </tr>
              {employees.map((e) => {
                const hrs = assigned.filter((s) => s.employeeId === e._id).reduce((a, s) => a + s.hours, 0);
                const max = meta.rules?.maxWeeklyHours ?? 48, ot = meta.rules?.overtimeThresholdWeekly ?? 40;
                return (
                  <tr key={e._id}>
                    <td className="td sticky left-0 bg-white z-[1] border-r border-slate-100">
                      <p className="font-medium text-slate-900">{e.firstName} {e.lastName}</p>
                      <p className="text-xs text-slate-500 flex items-center gap-1">{e.jobTitle} · {e.department} · {e.employmentType}</p>
                      <p className={`text-xs font-semibold ${hrs > max ? 'text-red-700' : hrs > ot ? 'text-red-600' : 'text-slate-600'}`}>{hrs} / {max} hrs{hrs > ot && <span className="inline-flex items-center gap-0.5 ml-1"><AlertTriangle className="h-3 w-3" />OT</span>}</p>
                    </td>
                    {days.map((d) => renderCell(e, d))}
                  </tr>);
              })}
            </tbody>
          </table>
          {!employees.length && <EmptyState icon={CalendarDays} title="No employees match the filters" />}
        </div>
      ) : (
        <DayView days={days} dayIdx={dayIdx} setDayIdx={setDayIdx} employees={employees} shifts={shifts || []} onEdit={setModal} />
      )}

      {modal && <ShiftModal shift={modal} meta={meta} locked={locked} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />}
      <Modal open={copyOpen} title="Copy previous week" onClose={() => setCopyOpen(false)}
        footer={<><button className="btn-secondary" onClick={() => setCopyOpen(false)}>Cancel</button>
          <button className="btn-secondary" disabled={busy} onClick={() => copyPrev(true)}>Replace existing</button>
          <button className="btn-primary" disabled={busy} onClick={() => copyPrev(false)}>Copy</button></>}>
        <p className="text-sm text-slate-600">Copy all shifts for <b>{loc?.name}</b> from the week of <b>{ws.subtract(7, 'day').format('MMM D')}</b> into the week of <b>{ws.format('MMM D')}</b>. Each shift keeps its weekday, department and job role. Copied shifts are created as draft until you publish; assignments that break rules (inactive, unavailable, approved leave) become open shifts.</p>
      </Modal>
    </>
  );
}

function DayView({ days, dayIdx, setDayIdx, employees, shifts, onEdit }) {
  const date = ymd(days[dayIdx]);
  const START = 6, END = 22, span = END - START;
  const pos = (t) => { const [h, m] = t.split(':').map(Number); return ((h + m / 60 - START) / span) * 100; };
  const list = shifts.filter((s) => s.date === date);
  const rows = [{ _id: null, label: 'Open Shifts' }, ...employees.map((e) => ({ _id: e._id, label: `${e.firstName} ${e.lastName}`, sub: e.jobTitle }))]
    .map((r) => ({ ...r, shifts: list.filter((s) => (s.employeeId || null) === r._id) })).filter((r) => r._id === null || r.shifts.length);
  return (
    <div className="card p-4">
      <div className="flex gap-1 mb-4 overflow-x-auto">
        {days.map((d, i) => <button key={i} onClick={() => setDayIdx(i)} className={`btn-sm btn ${i === dayIdx ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{d.format('ddd D')}</button>)}
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="flex ml-48 text-[11px] text-slate-400 mb-1">{Array.from({ length: span / 2 + 1 }, (_, i) => <div key={i} style={{ width: `${100 / (span / 2)}%` }} className="-ml-2">{dayjs().hour(START + i * 2).format('ha')}</div>)}</div>
          {rows.map((r) => (
            <div key={r._id || 'open'} className="flex items-center border-t border-slate-100 h-12">
              <div className="w-48 shrink-0 pr-2"><p className={`text-sm font-medium truncate ${!r._id ? 'text-amber-700' : ''}`}>{r.label}</p>{r.sub && <p className="text-[11px] text-slate-500">{r.sub}</p>}</div>
              <div className="relative flex-1 h-8 bg-slate-50 rounded">
                {r.shifts.map((s) => (
                  <button key={s._id} onClick={() => onEdit(s)} style={{ left: `${pos(s.start)}%`, width: `${pos(s.end) - pos(s.start)}%` }}
                    className={`absolute top-0 h-8 rounded border text-[11px] font-semibold px-2 truncate ${chipColor(s)}`}>{time12(s.start)}–{time12(s.end)} {r._id ? '' : `· ${s.jobTitle}`}</button>))}
              </div>
            </div>))}
          {rows.length <= 1 && !rows[0]?.shifts.length && <EmptyState title="No shifts on this day" />}
        </div>
      </div>
    </div>
  );
}

/**
 * Create / edit shift. For existing shifts the date, location, department and job role are locked
 * (schedule integrity) and only times, employee, required skills and notes can change.
 */
function ShiftModal({ shift, meta, locked, onClose, onSaved }) {
  const isNew = !shift._id;
  const [confirmDel, setConfirmDel] = useState(false);
  const [ruleErrors, setRuleErrors] = useState([]);
  const { register, handleSubmit, setValue, watch, formState: { isSubmitting, errors } } = useForm({
    defaultValues: { start: '08:00', end: '16:00', posted: true, notes: '', ...shift, employeeId: shift.employeeId || '', skillsText: (shift.requiredSkills || []).join(', ') } });
  const v = { locationId: watch('locationId') || shift.locationId, department: watch('department') || shift.department, date: watch('date') || shift.date, skillsText: watch('skillsText') || '' };
  const required = v.skillsText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Employee list: only active employees of the shift's location and department (business rule)
  const emps = meta.employees.filter((e) => e.locationId === v.locationId && isActive(e) && (!meta.rules?.enforceDepartmentMatch || e.department === v.department));
  const hint = (e) => {
    const flags = [];
    if (v.date && !isAvailable(e, v.date)) flags.push('unavailable');
    const missing = required.filter((r) => !(e.effectiveSkills || []).map((x) => x.toLowerCase()).includes(r));
    if (missing.length) flags.push(`missing ${missing.join('/')}`);
    return flags.length ? ` (${flags.join(', ')})` : '';
  };
  const submit = async (f) => {
    setRuleErrors([]);
    const requiredSkills = f.skillsText.split(',').map((s) => s.trim()).filter(Boolean);
    const body = isNew
      ? { locationId: f.locationId, date: f.date, start: f.start, end: f.end, employeeId: f.employeeId || null, department: f.department, jobTitle: f.jobTitle, notes: f.notes, posted: !!f.posted, requiredSkills }
      : { start: f.start, end: f.end, employeeId: f.employeeId || null, notes: f.notes, posted: !!f.posted, requiredSkills };
    try {
      let r;
      if (!isNew && !shift.employeeId && f.employeeId && f.start === shift.start && f.end === shift.end) {
        r = await api(`/shifts/${shift._id}/assign`, { method: 'POST', body: { employeeId: f.employeeId } });   // open-shift assignment
        if (f.notes !== shift.notes || requiredSkills.join() !== (shift.requiredSkills || []).join()) r = await api(`/shifts/${shift._id}`, { method: 'PUT', body: { notes: f.notes, requiredSkills } });
      } else r = await api(isNew ? '/shifts' : `/shifts/${shift._id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast.success(isNew ? 'Shift created' : 'Shift updated');
      toast.warnings(r.warnings);
      onSaved();
    } catch (e) { setRuleErrors(e.details?.length ? e.details : [e.message]); }
  };
  const remove = async () => { try { await api(`/shifts/${shift._id}`, { method: 'DELETE' }); toast.success('Shift deleted'); onSaved(); } catch (e) { toast.error(e.message); setConfirmDel(false); } };
  const lockCls = !isNew ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : '';
  return (
    <Modal open title={locked ? 'Shift (read-only – published)' : isNew ? 'New Shift' : 'Edit Shift'} onClose={onClose}
      footer={<>{!isNew && !locked && <button className="btn-ghost text-red-600 mr-auto" onClick={() => setConfirmDel(true)}><Trash2 className="h-4 w-4" />Delete</button>}
        <button className="btn-secondary" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
        {!locked && <button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Save</button>}</>}>
      {locked && <p className="mb-4 rounded-lg bg-brand-50 border border-brand-200 p-3 text-sm text-brand-800 flex gap-2"><Lock className="h-4 w-4 mt-0.5" />Enable Edit Mode on the schedule to change this shift.</p>}
      {ruleErrors.length > 0 && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <p className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle className="h-4 w-4" />WFM rule violation</p>
          <ul className="list-disc pl-5 space-y-0.5">{ruleErrors.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>)}
      <fieldset disabled={locked} className="grid grid-cols-2 gap-4">
        <Field label="Location" className="col-span-2"><select className={`input ${lockCls}`} disabled={!isNew} {...register('locationId', { required: true })}>{meta.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></Field>
        <Field label="Date *" error={errors.date} className="col-span-2"><input type="date" className={`input ${lockCls}`} disabled={!isNew} {...register('date', { required: true })} /></Field>
        <Field label="Department"><select className={`input ${lockCls}`} disabled={!isNew} {...register('department')}>{meta.departments.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <Field label="Job role"><select className={`input ${lockCls}`} disabled={!isNew} {...register('jobTitle')}>{meta.jobTitles.map((d) => <option key={d}>{d}</option>)}</select></Field>
        {!isNew && <p className="col-span-2 -mt-2 text-xs text-slate-500 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Date ({dayjs(shift.date).format('dddd')}), location, department and job role are locked to preserve schedule integrity.</p>}
        <Field label={`Employee (active, same location${meta.rules?.enforceDepartmentMatch ? ' & department' : ''})`} className="col-span-2">
          <select className="input" {...register('employeeId')}>
            <option value="">— Open shift (unassigned) —</option>
            {emps.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName} · {e.jobTitle}{hint(e)}</option>)}
          </select>
        </Field>
        <div className="col-span-2 flex gap-2">{Object.entries(TEMPLATES).map(([k, [s, e]]) => <button type="button" key={k} className="btn-secondary btn-sm flex-1" onClick={() => { setValue('start', s); setValue('end', e); }}>{k} {time12(s)}–{time12(e)}</button>)}</div>
        <Field label="Start"><input type="time" className="input" {...register('start', { required: true })} /></Field>
        <Field label="End"><input type="time" className="input" {...register('end', { required: true })} /></Field>
        <Field label="Required skills (comma separated, optional)" className="col-span-2">
          <input className="input" list="kp-shift-skills" placeholder="e.g. Key Holder" {...register('skillsText')} />
          <datalist id="kp-shift-skills">{meta.skills?.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" {...register('posted')} />Post open shift so employees can pick it up</label>
        <Field label="Notes" className="col-span-2"><input className="input" {...register('notes')} /></Field>
        <p className="col-span-2 text-xs text-slate-400">Rules checked on save: availability & approved leave, overlap/duplicates, max {meta.rules?.maxDailyHours}h/day, {meta.rules?.maxWeeklyHours}h/week, {meta.rules?.minRestHours}h rest between shifts, required skills, labor budget (warning).</p>
      </fieldset>
      <ConfirmModal open={confirmDel} danger title="Delete shift" message="This shift will be permanently removed." confirmLabel="Delete" onClose={() => setConfirmDel(false)} onConfirm={remove} />
    </Modal>
  );
}
```

---

### MODIFIED: `src/pages/Employees.jsx`

**Location:** `kp-wfm/src/pages/Employees.jsx`  
**Change:** Skills field; released-shift warnings

```jsx
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Download, Pencil, UserX } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, ConfirmModal, ErrorState, Spinner } from '../components/ui';
import { money2, date, downloadCsv } from '../lib/format';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Employees() {
  const { meta, load } = useMeta();
  const [f, setF] = useState({ q: '', locationId: '', department: '', status: '', page: 1, limit: 10 });
  const { data, loading, error, reload } = useFetch('/employees', f);
  const [edit, setEdit] = useState(null);
  const [confirm, setConfirm] = useState(null);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v?.target ? v.target.value : v, page: 1 }));

  const exportCsv = async () => {
    const all = await api('/employees', { params: { ...f, page: 1, limit: 500 } });
    downloadCsv('employees.csv', cols.filter((c) => c.key !== 'actions').map((c) => ({ key: c.csv || c.key, label: c.label })), all.items.map((e) => ({ ...e, name: `${e.firstName} ${e.lastName}` })));
  };
  const deactivate = async () => {
    try {
      const r = await api(`/employees/${confirm._id}`, { method: 'DELETE' });
      toast.success('Employee deactivated');
      if (r.releasedShifts) toast.warning(`${r.releasedShifts} future shift(s) were released to open shifts.`);
      setConfirm(null); reload(); load(true);
    } catch (e) { toast.error(e.message); }
  };

  const cols = [
    { key: 'employeeId', label: 'ID' },
    { key: 'name', label: 'Name', csv: 'name', render: (e) => <div><p className="font-medium text-slate-900">{e.firstName} {e.lastName}</p><p className="text-xs text-slate-500">{e.email}</p></div> },
    { key: 'jobTitle', label: 'Job Title' },
    { key: 'department', label: 'Department' },
    { key: 'locationName', label: 'Location' },
    { key: 'employmentType', label: 'Type' },
    { key: 'hourlyRate', label: 'Rate', render: (e) => money2(e.hourlyRate) },
    { key: 'hireDate', label: 'Hire Date', render: (e) => date(e.hireDate) },
    { key: 'managerName', label: 'Manager', render: (e) => e.managerName || '—' },
    { key: 'status', label: 'Status', render: (e) => <div className="flex gap-1"><Badge>{e.status}</Badge>{e.employmentStatus !== e.status && e.employmentStatus !== 'Active' && <Badge>{e.employmentStatus}</Badge>}</div> },
    { key: 'actions', label: '', render: (e) => (
      <div className="flex gap-1 justify-end">
        <button className="btn-ghost btn-sm" onClick={() => setEdit(e)} title="Edit"><Pencil className="h-4 w-4" /></button>
        {e.status === 'Active' && <button className="btn-ghost btn-sm text-red-600" onClick={() => setConfirm(e)} title="Deactivate"><UserX className="h-4 w-4" /></button>}
      </div>) },
  ];

  return (
    <>
      <PageHeader title="Employees" subtitle="Manage employee profiles, assignments and status"
        actions={<><button className="btn-secondary" onClick={exportCsv}><Download className="h-4 w-4" />Export</button><button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Add employee</button></>} />
      <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <SearchBar className="lg:col-span-2" value={f.q} onChange={set('q')} placeholder="Search name, email, ID, job…" />
        <select className="input" value={f.locationId} onChange={set('locationId')}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
        <select className="input" value={f.department} onChange={set('department')}><option value="">All departments</option>{meta?.departments.map((d) => <option key={d}>{d}</option>)}</select>
        <select className="input" value={f.status} onChange={set('status')}><option value="">All statuses</option><option>Active</option><option>Inactive</option></select>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> :
        <DataTable columns={cols} rows={data?.items || []} loading={loading} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF((x) => ({ ...x, page: p }))} />}
      {edit && <EmployeeForm employee={edit} meta={meta} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); load(true); }} />}
      <ConfirmModal open={!!confirm} danger title="Deactivate employee" confirmLabel="Deactivate" onClose={() => setConfirm(null)} onConfirm={deactivate}
        message={`${confirm?.firstName} ${confirm?.lastName} will be marked inactive and can no longer be scheduled. Future shifts are released to open shifts. History is preserved.`} />
    </>
  );
}

function EmployeeForm({ employee, meta, onClose, onSaved }) {
  const isNew = !employee._id;
  const avail = Object.fromEntries((employee.availability || DAYS.map((d) => ({ day: d, available: d !== 'sun' }))).map((a) => [a.day, a.available]));
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    defaultValues: { employmentType: 'Full-Time', employmentStatus: 'Active', status: 'Active', hireDate: new Date().toISOString().slice(0, 10), ...employee, avail,
      skillsText: (employee.skills || []).join(', ') },
  });
  const submit = async (v) => {
    const { avail: a, _id, createdAt, updatedAt, locationName, managerName, skillsText, skills, ...rest } = v;
    const body = { ...rest, availability: DAYS.map((d) => ({ day: d, available: !!a[d] })), skills: skillsText.split(',').map((s) => s.trim()).filter(Boolean) };
    try {
      const r = await api(isNew ? '/employees' : `/employees/${employee._id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast.success(isNew ? 'Employee created' : 'Employee updated');
      if (r.releasedShifts) toast.warning(`${r.releasedShifts} future shift(s) were released to open shifts because the employee is no longer active.`);
      onSaved();
    } catch (e) { toast.error(e.message); }
  };
  const req = { required: 'Required' };
  const defaultSkills = meta?.employees.find((x) => x._id === employee._id)?.effectiveSkills;
  return (
    <Modal open title={isNew ? 'Add Employee' : `Edit ${employee.firstName} ${employee.lastName}`} onClose={onClose} size="max-w-3xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Save</button></>}>
      <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" onSubmit={handleSubmit(submit)}>
        <Field label="Employee ID"><input className="input" placeholder="Auto-generated" {...register('employeeId')} /></Field>
        <Field label="First name *" error={errors.firstName}><input className="input" {...register('firstName', req)} /></Field>
        <Field label="Last name *" error={errors.lastName}><input className="input" {...register('lastName', req)} /></Field>
        <Field label="Email *" error={errors.email}><input className="input" type="email" {...register('email', { ...req, pattern: { value: /\S+@\S+\.\S+/, message: 'Invalid email' } })} /></Field>
        <Field label="Phone"><input className="input" {...register('phone')} /></Field>
        <Field label="Hire date"><input className="input" type="date" {...register('hireDate')} /></Field>
        <Field label="Location *" error={errors.locationId}><select className="input" {...register('locationId', req)}><option value="">Select…</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></Field>
        <Field label="Department *" error={errors.department}><select className="input" {...register('department', req)}><option value="">Select…</option>{meta?.departments.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <Field label="Job title *" error={errors.jobTitle}><select className="input" {...register('jobTitle', req)}><option value="">Select…</option>{meta?.jobTitles.map((d) => <option key={d}>{d}</option>)}</select></Field>
        <Field label="Hourly rate ($) *" error={errors.hourlyRate}><input className="input" type="number" step="0.01" {...register('hourlyRate', { ...req, min: { value: 7.25, message: 'Below minimum wage' } })} /></Field>
        <Field label="Employment type"><select className="input" {...register('employmentType')}><option>Full-Time</option><option>Part-Time</option><option>Weekend-Only</option></select></Field>
        <Field label="Manager"><select className="input" {...register('managerId')}><option value="">None</option>{meta?.managers.filter((m) => m._id !== employee._id).map((m) => <option key={m._id} value={m._id}>{m.firstName} {m.lastName} – {m.jobTitle}</option>)}</select></Field>
        <Field label="Employment status"><select className="input" {...register('employmentStatus')}><option>Active</option><option>On Leave</option><option>Terminated</option></select></Field>
        <Field label="Active / Inactive"><select className="input" {...register('status')}><option>Active</option><option>Inactive</option></select></Field>
        <Field label="Skills (comma separated)">
          <input className="input" list="kp-skills" placeholder={defaultSkills?.length ? `Job defaults: ${defaultSkills.join(', ')}` : 'e.g. Sales, Key Holder'} {...register('skillsText')} />
          <datalist id="kp-skills">{meta?.skills?.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className="label">Availability (checked before every shift assignment)</label>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => <label key={d} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm capitalize"><input type="checkbox" {...register(`avail.${d}`)} />{d}</label>)}
          </div>
        </div>
      </form>
    </Modal>
  );
}
```

---

### MODIFIED: `src/pages/Admin.jsx`

**Location:** `kp-wfm/src/pages/Admin.jsx`  
**Change:** WFM rule settings, new audit filters (action/entity), API Documentation link

```jsx
/** Administration: users, roles & permissions, system settings (incl. WFM scheduling rules), organization, audit logs. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Plus, Pencil, Trash2, RotateCcw, ShieldCheck, Check, BookOpen } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Tabs, Badge, Modal, Field, Card, PageLoader, ErrorState, ConfirmModal, Spinner } from '../components/ui';
import { dateTime } from '../lib/format';

export default function Admin() {
  const [tab, setTab] = useState('users');
  return (
    <>
      <PageHeader title="Administration" subtitle="Users, roles, system settings, organization and audit trail"
        actions={<Link to="/admin/api-docs" className="btn-secondary"><BookOpen className="h-4 w-4" />API Documentation</Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users' }, { value: 'roles', label: 'Roles' }, { value: 'settings', label: 'System Settings' }, { value: 'org', label: 'Organization' }, { value: 'audit', label: 'Audit Logs' }]} />
      {tab === 'users' && <UsersTab />}
      {tab === 'roles' && <RolesTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'org' && <OrgTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

function UsersTab() {
  const [f, setF] = useState({ q: '', role: '', page: 1, limit: 10 });
  const { data, loading, error, reload } = useFetch('/admin/users', f);
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const remove = async () => { try { await api(`/admin/users/${del._id}`, { method: 'DELETE' }); toast.success('User deleted'); setDel(null); reload(); } catch (e) { toast.error(e.message); setDel(null); } };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <SearchBar className="flex-1" value={f.q} onChange={(q) => setF({ ...f, q, page: 1 })} placeholder="Search users…" />
        <select className="input sm:w-48" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })}><option value="">All roles</option><option>Administrator</option><option>Manager</option><option>Employee</option></select>
        <button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Add user</button>
      </div>
      <DataTable loading={loading} rows={data?.items || []} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF({ ...f, page: p })} columns={[
        { key: 'name', label: 'Name', render: (u) => <span className="font-medium">{u.name}</span> },
        { key: 'email', label: 'Email' },
        { key: 'role', label: 'Role', render: (u) => <Badge>{u.role}</Badge> },
        { key: 'active', label: 'Status', render: (u) => <Badge tone={u.active ? 'green' : 'gray'}>{u.active ? 'Active' : 'Disabled'}</Badge> },
        { key: 'lastLogin', label: 'Last Login', render: (u) => dateTime(u.lastLogin) },
        { key: 'a', label: '', render: (u) => <div className="flex gap-1 justify-end"><button className="btn-ghost btn-sm" onClick={() => setEdit(u)}><Pencil className="h-4 w-4" /></button><button className="btn-ghost btn-sm text-red-600" onClick={() => setDel(u)}><Trash2 className="h-4 w-4" /></button></div> },
      ]} />
      {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      <ConfirmModal open={!!del} danger title="Delete user" confirmLabel="Delete" message={`Delete login for ${del?.email}?`} onClose={() => setDel(null)} onConfirm={remove} />
    </>
  );
}

function UserForm({ u, onClose, onSaved }) {
  const isNew = !u._id;
  const meta = useMeta((s) => s.meta);
  const loadMeta = useMeta((s) => s.load);
  useEffect(() => { loadMeta(); }, [loadMeta]);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ defaultValues: { role: 'Employee', active: true, employeeId: '', ...u, password: '' } });
  const save = async (v) => {
    const body = { name: v.name, email: v.email, role: v.role, active: v.active === true || v.active === 'true', employeeId: v.employeeId || null, ...(v.password && { password: v.password }) };
    try { await api(isNew ? '/admin/users' : `/admin/users/${u._id}`, { method: isNew ? 'POST' : 'PUT', body }); toast.success('User saved'); onSaved(); } catch (e) { toast.error(e.message); }
  };
  return (
    <Modal open title={isNew ? 'Add User' : `Edit ${u.name}`} onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button></>}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name *" error={errors.name} className="col-span-2"><input className="input" {...register('name', { required: true })} /></Field>
        <Field label="Email *" error={errors.email} className="col-span-2"><input className="input" type="email" disabled={!isNew} {...register('email', { required: true })} /></Field>
        <Field label="Role"><select className="input" {...register('role')}><option>Employee</option><option>Manager</option><option>Administrator</option></select></Field>
        <Field label="Status"><select className="input" {...register('active')}><option value="true">Active</option><option value="false">Disabled</option></select></Field>
        <Field label="Linked employee record" className="col-span-2"><select className="input" {...register('employeeId')}><option value="">None</option>{meta?.employees.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName} ({e.employeeId})</option>)}</select></Field>
        <Field label={isNew ? 'Password *' : 'Reset password (optional)'} error={errors.password} className="col-span-2"><input className="input" type="password" {...register('password', { required: isNew, minLength: { value: 6, message: 'Min 6 characters' } })} /></Field>
      </div>
    </Modal>
  );
}

const ALL_PERMS = [['dashboard', 'Workforce dashboard'], ['dashboard.self', 'Personal dashboard'], ['employees', 'Employee management'], ['locations', 'Location management'], ['scheduling', 'Scheduling'],
  ['schedule.self', 'Own schedule'], ['timeclock', 'Time clock'], ['attendance', 'Time & attendance'], ['timeoff.request', 'Request time off'], ['timeoff.approve', 'Approve time off'],
  ['budget', 'Labor budget'], ['forecast', 'Forecasting'], ['reports', 'Reports'], ['admin', 'Administration']];

function RolesTab() {
  const { data, loading, error, reload } = useFetch('/admin/settings');
  const [roles, setRoles] = useState(null);
  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const list = roles || data.roles?.roles || [];
  const toggle = (ri, p) => setRoles(list.map((r, i) => i !== ri ? r : { ...r, permissions: r.permissions.includes(p) ? r.permissions.filter((x) => x !== p) : [...r.permissions, p] }));
  const save = async () => { try { await api('/admin/settings/roles', { method: 'PUT', body: { roles: list } }); toast.success('Role permissions saved'); setRoles(null); reload(); } catch (e) { toast.error(e.message); } };
  return (
    <Card title="Role Permission Matrix" actions={<button className="btn-primary btn-sm" disabled={!roles} onClick={save}>Save changes</button>} bodyClass="overflow-x-auto">
      <table className="min-w-full">
        <thead><tr><th className="th">Permission</th>{list.map((r) => <th key={r.name} className="th text-center">{r.name}</th>)}</tr></thead>
        <tbody>{ALL_PERMS.map(([k, label]) => (
          <tr key={k} className="border-t border-slate-100"><td className="td">{label}<span className="text-xs text-slate-400 ml-2">{k}</span></td>
            {list.map((r, ri) => <td key={r.name} className="td text-center"><button onClick={() => r.name !== 'Administrator' && toggle(ri, k)}
              className={`h-6 w-6 rounded border inline-flex items-center justify-center ${r.permissions.includes(k) ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300'} ${r.name === 'Administrator' ? 'opacity-60 cursor-not-allowed' : ''}`}>
              {r.permissions.includes(k) && <Check className="h-4 w-4" />}</button></td>)}</tr>))}
        </tbody>
      </table>
      <div className="grid sm:grid-cols-3 gap-3 mt-4">{list.map((r) => <div key={r.name} className="rounded-lg bg-slate-50 p-3 text-sm"><p className="font-semibold flex items-center gap-1"><ShieldCheck className="h-4 w-4 text-brand-600" />{r.name}</p><p className="text-slate-500 text-xs mt-1">{r.description}</p></div>)}</div>
    </Card>
  );
}

function SettingsTab() {
  const { data, loading, error, reload } = useFetch('/admin/settings');
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const reseed = async () => { setBusy(true); try { await api('/admin/reseed', { method: 'POST' }); toast.success('Demo data has been reset'); setReset(false); useMeta.getState().load(true); reload(); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <SettingsForm s={data.system} onSaved={() => { reload(); useMeta.getState().load(true); }} />
      <div className="space-y-4">
        <Card title="Demo Data">
          <p className="text-sm text-slate-600 mb-4">Reset the database to the original KP Retail Group demo data set (50 employees, 5 locations, current-week schedules, timecards, forecasts and budgets). All changes will be lost.</p>
          <button className="btn-danger" onClick={() => setReset(true)} disabled={busy}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <RotateCcw className="h-4 w-4" />}Reset demo data</button>
        </Card>
        <Card title="How scheduling rules are applied">
          <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
            <li>Rules run on every shift create, edit, open-shift assignment, employee pickup and inbound API import.</li>
            <li>Hard rules block the change (HTTP 422) and list every violation.</li>
            <li>Labor budget and overtime are warnings – the change is saved and the user is alerted.</li>
            <li>Existing seeded shifts are not modified; rules apply to new changes.</li>
          </ul>
        </Card>
      </div>
      <ConfirmModal open={reset} danger title="Reset demo data?" confirmLabel="Reset" message="This will delete all data and re-seed the demo company. Continue?" onClose={() => setReset(false)} onConfirm={reseed} />
    </div>
  );
}

const NUM_FIELDS = [
  ['overtimeThresholdWeekly', 'Weekly overtime threshold (hrs)'], ['overtimeThresholdDaily', 'Daily overtime threshold (hrs)'],
  ['maxDailyHours', 'Max scheduled hours / day'], ['maxWeeklyHours', 'Max scheduled hours / week'],
  ['minRestHours', 'Minimum rest between shifts (hrs)'], ['maxShiftHours', 'Max single shift length (hrs)'],
  ['budgetWarningPct', 'Labor budget warning at (%)'], ['lateGraceMinutes', 'Late grace period (min)'],
  ['mealBreakAfterHours', 'Meal break required after (hrs)'], ['minMealMinutes', 'Minimum meal (min)'],
  ['schedulePublishLeadDays', 'Publish lead time (days)'], ['sessionHours', 'Session length (hrs)'],
];
const BOOL_FIELDS = [
  ['enforceAvailability', 'Block assignments on unavailable days / approved time off'], ['enforceDepartmentMatch', 'Employee department must match shift department'],
  ['enforceSkills', 'Employee must have the shift\'s required skills'], ['requireEditModeForPublished', 'Published schedules require Edit Mode'],
  ['preventDuplicateOpenShifts', 'Prevent duplicate open shifts'], ['allowShiftPickup', 'Allow employees to pick up open shifts'],
  ['logReadRequests', 'Log read-only (GET) API requests in the audit log'],
];

function SettingsForm({ s, onSaved }) {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: s });
  const save = async (v) => {
    const body = Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_id').map(([k, x]) => [k, typeof s[k] === 'number' ? Number(x) : typeof s[k] === 'boolean' ? !!x : x]));
    try { await api('/admin/settings/system', { method: 'PUT', body }); toast.success('System settings saved'); onSaved(); } catch (e) { toast.error(e.message); }
  };
  return (
    <Card title="System Settings & WFM Rules" actions={<button className="btn-primary btn-sm" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button>}>
      <div className="grid grid-cols-2 gap-4">
        {NUM_FIELDS.map(([k, label]) => <Field key={k} label={label}><input type="number" min={0} className="input" {...register(k)} /></Field>)}
        <div className="col-span-2 space-y-2 pt-2 border-t">
          {BOOL_FIELDS.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" {...register(k)} />{label}</label>)}
        </div>
      </div>
    </Card>
  );
}

function OrgTab() {
  const { data, loading, error, reload } = useFetch('/admin/settings');
  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return <OrgForm o={data.organization} onSaved={() => { reload(); useMeta.getState().load(true); }} />;
}
function OrgForm({ o, onSaved }) {
  const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: { ...o, regions: o.regions.join('\n'), departments: o.departments.join('\n'), jobTitles: o.jobTitles.join('\n') } });
  const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const save = async (v) => { try { await api('/admin/settings/organization', { method: 'PUT', body: { ...v, regions: lines(v.regions), departments: lines(v.departments), jobTitles: lines(v.jobTitles) } }); toast.success('Organization saved'); onSaved(); } catch (e) { toast.error(e.message); } };
  return (
    <Card title="Organization Configuration" actions={<button className="btn-primary btn-sm" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button>}>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Field label="Company name"><input className="input" {...register('companyName')} /></Field>
        <Field label="Currency"><input className="input" {...register('currency')} /></Field>
        <Field label="Timezone"><input className="input" {...register('timezone')} /></Field>
        <Field label="Week starts on"><select className="input" {...register('weekStartDay')}><option>Monday</option><option>Sunday</option></select></Field>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Regions (one per line)"><textarea rows={6} className="input" {...register('regions')} /></Field>
        <Field label="Departments (one per line)"><textarea rows={6} className="input" {...register('departments')} /></Field>
        <Field label="Job roles (one per line)"><textarea rows={6} className="input" {...register('jobTitles')} /></Field>
      </div>
    </Card>
  );
}

const ACTIONS = ['LOGIN', 'CREATE', 'UPDATE', 'DELETE', 'ASSIGN', 'UNASSIGN', 'RELEASE', 'EDIT_MODE', 'PUBLISH', 'COPY', 'APPROVE', 'REJECT', 'PUNCH', 'EXPORT', 'GENERATE',
  'INBOUND', 'INBOUND_PARTIAL', 'API_REQUEST', 'API_FAILURE', 'SEED', 'RESET'];
function AuditTab() {
  const [f, setF] = useState({ q: '', action: '', entity: '', page: 1, limit: 15 });
  const { data, loading, error, reload } = useFetch('/admin/audit', f);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const tone = { CREATE: 'green', DELETE: 'red', LOGIN: 'gray', PUBLISH: 'blue', APPROVE: 'green', REJECT: 'red', UPDATE: 'yellow', ASSIGN: 'green', UNASSIGN: 'yellow',
    API_FAILURE: 'red', API_REQUEST: 'gray', EDIT_MODE: 'purple', RELEASE: 'yellow', INBOUND: 'blue', INBOUND_PARTIAL: 'yellow' };
  return (
    <>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <SearchBar className="flex-1" value={f.q} onChange={(q) => setF({ ...f, q, page: 1 })} placeholder="Search details or user…" />
        <select className="input sm:w-48" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })}><option value="">All actions</option>
          {ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
        <select className="input sm:w-48" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value, page: 1 })}><option value="">All entities</option>
          {['Shift', 'Open Shift', 'Schedule', 'Employee', 'Location', 'Time Off', 'Timecard', 'Labor Budget', 'Settings', 'Integration', 'API', 'Auth', 'User'].map((a) => <option key={a}>{a}</option>)}</select>
      </div>
      <DataTable loading={loading} rows={data?.items || []} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF({ ...f, page: p })} columns={[
        { key: 'timestamp', label: 'Timestamp', render: (l) => dateTime(l.timestamp) },
        { key: 'userName', label: 'User', render: (l) => <div><p className="font-medium">{l.userName}</p><p className="text-xs text-slate-500">{l.role}</p></div> },
        { key: 'action', label: 'Action', render: (l) => <Badge tone={tone[l.action] || 'blue'}>{l.action}</Badge> },
        { key: 'entity', label: 'Entity' },
        { key: 'details', label: 'Details', className: 'max-w-[520px] whitespace-normal text-xs', render: (l) => l.details },
      ]} />
    </>
  );
}
```

---

### MODIFIED: `src/pages/MySchedule.jsx`

**Location:** `kp-wfm/src/pages/MySchedule.jsx`  
**Change:** Shows rule warnings after pickup

```jsx
/** Employee self-service schedule: own published shifts + posted open shifts available for pickup. */
import { useState } from 'react';
import dayjs from 'dayjs';
import { ChevronLeft, ChevronRight, HandHelping } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../store/authStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import { PageHeader, Card, PageLoader, ErrorState, EmptyState, Badge } from '../components/ui';
import { weekStart, ymd, time12, num } from '../lib/format';

export default function MySchedule() {
  const user = useAuth((s) => s.user);
  const [ws, setWs] = useState(weekStart());
  const { data, loading, error, reload } = useFetch('/shifts', { weekStart: ymd(ws) });
  const mine = (data || []).filter((s) => s.employeeId === user.employeeId);
  const open = (data || []).filter((s) => !s.employeeId);
  const claim = async (s) => {
    try { const r = await api(`/shifts/${s._id}/claim`, { method: 'POST' }); toast.success('Shift picked up!'); toast.warnings(r.warnings); reload(); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <>
      <PageHeader title="My Schedule" subtitle="Your published shifts and open shifts you can pick up" actions={
        <div className="flex items-center gap-2">
          <button className="btn-secondary px-2" onClick={() => setWs(ws.subtract(7, 'day'))}><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-sm font-semibold">{ws.format('MMM D')} – {ws.add(6, 'day').format('MMM D')}</span>
          <button className="btn-secondary px-2" onClick={() => setWs(ws.add(7, 'day'))}><ChevronRight className="h-4 w-4" /></button>
        </div>} />
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <PageLoader /> : (
        <>
          <p className="text-sm text-slate-600 mb-3">Total scheduled: <b>{num(mine.reduce((a, s) => a + s.hours, 0))} hrs</b></p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 mb-6">
            {Array.from({ length: 7 }, (_, i) => ws.add(i, 'day')).map((d) => {
              const s = mine.filter((x) => x.date === ymd(d));
              return (
                <div key={ymd(d)} className={`card p-3 min-h-[110px] ${ymd(d) === ymd(dayjs()) ? 'ring-2 ring-brand-400' : ''}`}>
                  <p className="text-xs font-semibold text-slate-500 uppercase">{d.format('ddd MMM D')}</p>
                  {s.length ? s.map((x) => (
                    <div key={x._id} className="mt-2 rounded-lg bg-brand-50 border border-brand-200 p-2">
                      <p className="text-sm font-semibold text-brand-800">{time12(x.start)} – {time12(x.end)}</p>
                      <p className="text-xs text-brand-700">{x.jobTitle}</p>
                    </div>)) : <p className="text-sm text-slate-400 mt-3">Off</p>}
                </div>);
            })}
          </div>
          <Card title="Open Shifts Available" bodyClass="divide-y">
            {open.length ? open.map((s) => (
              <div key={s._id} className="flex items-center justify-between px-5 py-3 gap-3">
                <div><p className="text-sm font-medium">{dayjs(s.date).format('ddd, MMM D')} · {time12(s.start)} – {time12(s.end)}</p><p className="text-xs text-slate-500">{s.jobTitle} · {s.department} · {s.hours} hrs</p></div>
                <div className="flex items-center gap-2"><Badge tone="yellow">Open</Badge><button className="btn-primary btn-sm" onClick={() => claim(s)}><HandHelping className="h-4 w-4" />Pick up</button></div>
              </div>)) : <EmptyState title="No open shifts this week" />}
          </Card>
        </>)}
    </>
  );
}
```

---

### MODIFIED: `src/pages/TimeOff.jsx`

**Location:** `kp-wfm/src/pages/TimeOff.jsx`  
**Change:** Shows conflicting-shift warning after approval

```jsx
/** Time off: employees request & track; managers approve/reject (approval workflow). */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Check, X, Ban } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useAuth, isManager } from '../store/authStore';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, Tabs, ErrorState, EmptyState } from '../components/ui';
import { date, dateTime } from '../lib/format';
import { Plane } from 'lucide-react';

export default function TimeOff() {
  const user = useAuth((s) => s.user);
  const mgr = isManager(user);
  const [tab, setTab] = useState(mgr ? 'Pending' : '');
  const [f, setF] = useState({ q: '', type: '', page: 1, limit: 10 });
  const { data, loading, error, reload } = useFetch('/timeoff', { ...f, status: tab });
  const pending = useFetch('/timeoff', { status: 'Pending', limit: 1 });
  const [form, setForm] = useState(false);
  const [decide, setDecide] = useState(null);
  const refresh = () => { reload(); pending.reload(); };
  const cancel = async (t) => { try { await api(`/timeoff/${t._id}`, { method: 'DELETE' }); toast.success('Request cancelled'); refresh(); } catch (e) { toast.error(e.message); } };

  const cols = [
    ...(mgr ? [{ key: 'employeeName', label: 'Employee', render: (t) => <div><p className="font-medium">{t.employeeName}</p><p className="text-xs text-slate-500">{t.department}</p></div> }] : []),
    { key: 'type', label: 'Type', render: (t) => <Badge tone={t.type === 'Sick' ? 'red' : t.type === 'Personal' ? 'purple' : 'blue'}>{t.type}</Badge> },
    { key: 'dates', label: 'Dates', render: (t) => `${date(t.startDate)} – ${date(t.endDate)}` },
    { key: 'days', label: 'Days' },
    { key: 'reason', label: 'Reason', className: 'max-w-[220px] truncate' },
    { key: 'submittedAt', label: 'Submitted', render: (t) => date(t.submittedAt) },
    { key: 'status', label: 'Status', render: (t) => <div><Badge>{t.status}</Badge>{t.decidedBy && <p className="text-[11px] text-slate-500 mt-0.5">by {t.decidedBy}</p>}</div> },
    { key: 'a', label: '', render: (t) => t.status !== 'Pending' ? null : mgr ? (
      <div className="flex gap-1 justify-end">
        <button className="btn-sm btn bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setDecide({ t, decision: 'Approved' })}><Check className="h-3.5 w-3.5" />Approve</button>
        <button className="btn-sm btn-danger" onClick={() => setDecide({ t, decision: 'Rejected' })}><X className="h-3.5 w-3.5" />Reject</button>
      </div>) : <button className="btn-ghost btn-sm" onClick={() => cancel(t)}><Ban className="h-3.5 w-3.5" />Cancel</button> },
  ];
  const tabs = [{ value: 'Pending', label: 'Pending', count: pending.data?.total }, { value: 'Approved', label: 'Approved' }, { value: 'Rejected', label: 'Rejected' }, { value: '', label: 'All' }];

  return (
    <>
      <PageHeader title={mgr ? 'Time Off Management' : 'My Time Off'} subtitle={mgr ? 'Review and approve vacation, sick and personal leave' : 'Request vacation, sick or personal leave and track status'}
        actions={<button className="btn-primary" onClick={() => setForm(true)}><Plus className="h-4 w-4" />New request</button>} />
      <Tabs tabs={mgr ? tabs : [tabs[3], ...tabs.slice(0, 3)]} value={tab} onChange={(v) => { setTab(v); setF((p) => ({ ...p, page: 1 })); }} />
      <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
        {mgr && <SearchBar className="sm:col-span-2" value={f.q} onChange={(q) => setF((p) => ({ ...p, q, page: 1 }))} placeholder="Search employee…" />}
        <select className="input" value={f.type} onChange={(e) => setF((p) => ({ ...p, type: e.target.value, page: 1 }))}><option value="">All types</option><option>Vacation</option><option>Sick</option><option>Personal</option></select>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> :
        <DataTable columns={cols} rows={data?.items || []} loading={loading} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF((x) => ({ ...x, page: p }))}
          empty={<EmptyState icon={Plane} title="No time off requests" message={tab === 'Pending' ? 'All caught up – nothing awaiting approval.' : ''} />} />}
      {form && <RequestForm mgr={mgr} onClose={() => setForm(false)} onSaved={() => { setForm(false); refresh(); }} />}
      {decide && <DecisionModal {...decide} onClose={() => setDecide(null)} onSaved={() => { setDecide(null); refresh(); }} />}
    </>
  );
}

function RequestForm({ mgr, onClose, onSaved }) {
  const meta = useMeta((s) => s.meta);
  const load = useMeta((s) => s.load);
  useEffect(() => { if (mgr) load(); }, [mgr, load]);
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm({ defaultValues: { type: 'Vacation' } });
  const submit = async (v) => { try { await api('/timeoff', { method: 'POST', body: v }); toast.success('Request submitted for approval'); onSaved(); } catch (e) { toast.error(e.message); } };
  return (
    <Modal open title="New Time Off Request" onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>Submit</button></>}>
      <div className="grid grid-cols-2 gap-4">
        {mgr && <Field label="Employee (blank = myself)" className="col-span-2"><select className="input" {...register('employeeId')}><option value="">Myself</option>{meta?.employees.filter((e) => e.status === 'Active').map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName}</option>)}</select></Field>}
        <Field label="Type" className="col-span-2"><select className="input" {...register('type')}><option>Vacation</option><option value="Sick">Sick leave</option><option value="Personal">Personal leave</option></select></Field>
        <Field label="Start date *" error={errors.startDate}><input type="date" className="input" {...register('startDate', { required: true })} /></Field>
        <Field label="End date *" error={errors.endDate}><input type="date" className="input" {...register('endDate', { required: true, validate: (v) => v >= watch('startDate') || 'End must be after start' })} /></Field>
        <Field label="Reason" className="col-span-2"><textarea className="input" rows={3} {...register('reason')} /></Field>
      </div>
    </Modal>
  );
}

function DecisionModal({ t, decision, onClose, onSaved }) {
  const [comment, setComment] = useState('');
  const submit = async () => {
    try { const r = await api(`/timeoff/${t._id}/decision`, { method: 'PUT', body: { decision, comment } }); toast.success(`Request ${decision.toLowerCase()}`); toast.warnings(r.warnings); onSaved(); }
    catch (e) { toast.error(e.message); }
  };
  return (
    <Modal open title={`${decision === 'Approved' ? 'Approve' : 'Reject'} request`} onClose={onClose}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className={decision === 'Approved' ? 'btn-primary' : 'btn-danger'} onClick={submit}>{decision === 'Approved' ? 'Approve' : 'Reject'}</button></>}>
      <p className="text-sm text-slate-600 mb-3"><b>{t.employeeName}</b> · {t.type} · {date(t.startDate)} – {date(t.endDate)} ({t.days} day{t.days > 1 ? 's' : ''})<br />Submitted {dateTime(t.submittedAt)}</p>
      <Field label="Comment (optional)"><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
    </Modal>
  );
}
```

---

### MODIFIED: `src/components/Layout.jsx`

**Location:** `kp-wfm/src/components/Layout.jsx`  
**Change:** New “API Documentation” menu item under Administration

```jsx
/** App shell: role-based sidebar navigation + top bar. */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, MapPin, CalendarDays, Clock, Timer, Plane, Wallet, TrendingUp, FileBarChart, Settings, LogOut, Menu, X, CalendarCheck, BookOpen } from 'lucide-react';
import { useAuth } from '../store/authStore';
import { Badge } from './ui';

export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['Employee', 'Manager', 'Administrator'] },
  { to: '/my-schedule', label: 'My Schedule', icon: CalendarCheck, roles: ['Employee'] },
  { to: '/time-clock', label: 'Time Clock', icon: Timer, roles: ['Employee', 'Manager'] },
  { to: '/employees', label: 'Employees', icon: Users, roles: ['Manager', 'Administrator'] },
  { to: '/locations', label: 'Locations', icon: MapPin, roles: ['Manager', 'Administrator'] },
  { to: '/scheduling', label: 'Scheduling', icon: CalendarDays, roles: ['Manager', 'Administrator'] },
  { to: '/timesheets', label: 'Time & Attendance', icon: Clock, roles: ['Manager', 'Administrator'] },
  { to: '/time-off', label: 'Time Off', icon: Plane, roles: ['Employee', 'Manager', 'Administrator'] },
  { to: '/budget', label: 'Labor Budget', icon: Wallet, roles: ['Manager', 'Administrator'] },
  { to: '/forecast', label: 'Forecasting', icon: TrendingUp, roles: ['Manager', 'Administrator'] },
  { to: '/reports', label: 'Reports', icon: FileBarChart, roles: ['Manager', 'Administrator'] },
  { to: '/admin', label: 'Administration', icon: Settings, roles: ['Administrator'] },
  { to: '/admin/api-docs', label: 'API Documentation', icon: BookOpen, roles: ['Administrator'], child: true },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const items = NAV.filter((n) => n.roles.includes(user.role));

  const sidebar = (
    <div className="flex h-full flex-col bg-white border-r border-slate-200">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-slate-100">
        <div className="h-9 w-9 rounded-lg bg-brand-600 text-white flex items-center justify-center font-bold">KP</div>
        <div><p className="font-bold text-slate-900 leading-tight">KP Workforce</p><p className="text-[11px] text-slate-500">KP Retail Group</p></div>
      </div>
      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {items.map(({ to, label, icon: Icon, child }) => (
          <NavLink key={to} to={to} end={to === '/' || to === '/admin'} onClick={() => setOpen(false)}
            className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${child ? 'ml-4' : ''} ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
            <Icon className="h-[18px] w-[18px]" />{label}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-slate-100">
        <button onClick={() => { logout(); nav('/login'); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700">
          <LogOut className="h-[18px] w-[18px]" />Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-64 z-30">{sidebar}</aside>
      {open && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72">{sidebar}<button className="absolute top-4 right-3 text-slate-500" onClick={() => setOpen(false)}><X /></button></div>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 h-16 bg-white/90 backdrop-blur border-b border-slate-200 flex items-center justify-between px-4 sm:px-6">
          <button className="lg:hidden btn-ghost p-2" onClick={() => setOpen(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
          <div className="hidden sm:block text-sm text-slate-500">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block"><p className="text-sm font-semibold text-slate-800">{user.name}</p><p className="text-xs text-slate-500">{user.email}</p></div>
            <Badge>{user.role}</Badge>
            <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-sm">
              {user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
            </div>
          </div>
        </header>
        <main className="p-4 sm:p-6 max-w-[1600px] mx-auto"><Outlet /></main>
      </div>
    </div>
  );
}
```

---

### MODIFIED: `src/App.jsx`

**Location:** `kp-wfm/src/App.jsx`  
**Change:** Route /admin/api-docs

```jsx
/** Routes with authentication + role guards. */
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './store/authStore';
import Layout from './components/Layout';
import Toasts from './components/Toasts';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Employees from './pages/Employees';
import Locations from './pages/Locations';
import Scheduling from './pages/Scheduling';
import MySchedule from './pages/MySchedule';
import TimeClock from './pages/TimeClock';
import Timesheets from './pages/Timesheets';
import TimeOff from './pages/TimeOff';
import Budget from './pages/Budget';
import Forecast from './pages/Forecast';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import ApiDocs from './pages/ApiDocs';
import { EmptyState } from './components/ui';
import { ShieldAlert } from 'lucide-react';

const M = ['Manager', 'Administrator'];

function Guard({ roles, children }) {
  const user = useAuth((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <EmptyState icon={ShieldAlert} title="Access denied" message="Your role does not have access to this page." />;
  return children;
}

export default function App() {
  const user = useAuth((s) => s.user);
  return (
    <>
      <Toasts />
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route element={<Guard><Layout /></Guard>}>
          <Route index element={<Dashboard />} />
          <Route path="my-schedule" element={<MySchedule />} />
          <Route path="time-clock" element={<Guard roles={['Employee', 'Manager']}><TimeClock /></Guard>} />
          <Route path="employees" element={<Guard roles={M}><Employees /></Guard>} />
          <Route path="locations" element={<Guard roles={M}><Locations /></Guard>} />
          <Route path="scheduling" element={<Guard roles={M}><Scheduling /></Guard>} />
          <Route path="timesheets" element={<Guard roles={M}><Timesheets /></Guard>} />
          <Route path="time-off" element={<TimeOff />} />
          <Route path="budget" element={<Guard roles={M}><Budget /></Guard>} />
          <Route path="forecast" element={<Guard roles={M}><Forecast /></Guard>} />
          <Route path="reports" element={<Guard roles={M}><Reports /></Guard>} />
          <Route path="admin" element={<Guard roles={['Administrator']}><Admin /></Guard>} />
          <Route path="admin/api-docs" element={<Guard roles={['Administrator']}><ApiDocs /></Guard>} />
          <Route path="*" element={<EmptyState title="Page not found" message="The page you are looking for does not exist." />} />
        </Route>
      </Routes>
    </>
  );
}
```

---

### MODIFIED: `src/lib/api.js`

**Location:** `kp-wfm/src/lib/api.js`  
**Change:** Errors include details[]; new apiRaw() for the explorer

```javascript
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
```

---

### MODIFIED: `src/store/toastStore.js`

**Location:** `kp-wfm/src/store/toastStore.js`  
**Change:** warning / warnings() toasts

```javascript
/** Global toast notifications: toast.success('Saved'), toast.error('Oops'), toast.warning('Over budget'). */
import { create } from 'zustand';

export const useToasts = create((set) => ({
  toasts: [],
  push: (type, message, ms = 4000) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (m) => useToasts.getState().push('success', m),
  error: (m) => useToasts.getState().push('error', m, 7000),
  info: (m) => useToasts.getState().push('info', m),
  warning: (m) => useToasts.getState().push('warning', m, 7000),
  /** Show every non-blocking rule warning returned by the API (e.g. labor budget, overtime). */
  warnings: (list = []) => list.forEach((w) => useToasts.getState().push('warning', w, 7000)),
};
```

---

### MODIFIED: `src/components/Toasts.jsx`

**Location:** `kp-wfm/src/components/Toasts.jsx`  
**Change:** Warning toast style

```jsx
import { CheckCircle2, XCircle, Info, X, AlertTriangle } from 'lucide-react';
import { useToasts } from '../store/toastStore';

export default function Toasts() {
  const { toasts, dismiss } = useToasts();
  const icon = {
    success: <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />, error: <XCircle className="h-5 w-5 text-red-500 shrink-0" />,
    info: <Info className="h-5 w-5 text-brand-500 shrink-0" />, warning: <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />,
  };
  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100%-2rem)] sm:w-96">
      {toasts.map((t) => (
        <div key={t.id} className={`card flex items-start gap-3 p-3.5 shadow-lg ${t.type === 'warning' ? 'border-amber-300 bg-amber-50' : ''}`}>
          {icon[t.type]}<p className="text-sm text-slate-700 flex-1 whitespace-pre-line">{t.message}</p>
          <button onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
      ))}
    </div>
  );
}
```

---

### MODIFIED: `package.json`

**Location:** `kp-wfm/package.json`  
**Change:** Version 1.1.0

```json
{
  "name": "kp-wfm",
  "private": true,
  "version": "1.1.0",
  "description": "KP Retail Group - Workforce Management (WFM) web application",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "vite",
    "dev:api": "node --env-file=.env server/dev.js",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "dayjs": "^1.11.13",
    "jsonwebtoken": "^9.0.2",
    "lucide-react": "^0.468.0",
    "mongodb": "^6.12.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.54.2",
    "react-router-dom": "^7.1.1",
    "recharts": "^2.15.0",
    "zustand": "^5.0.2"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "vite": "^6.0.7"
  }
}
```

---

### MODIFIED: `README.md`

**Location:** `kp-wfm/README.md`  
**Change:** v1.1 notes, new files, API docs, upgrade notes

````markdown
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
````
