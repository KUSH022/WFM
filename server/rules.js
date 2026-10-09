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
