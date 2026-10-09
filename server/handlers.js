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
    return {
        locations, employees, departments: org?.departments || DEPARTMENTS, jobTitles: org?.jobTitles || JOB_TITLES, skills,
        regions: org?.regions || [], rules, managers: employees.filter((e) => ['Store Manager', 'Assistant Manager', 'Supervisor'].includes(e.jobTitle) && e.status === 'Active')
    };
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
        return {
            role: 'Employee', weekStart: ws, shifts, timeoff, timecards: cards, openShifts: open,
            scheduledHours: shifts.reduce((a, s) => a + s.hours, 0), workedHours: round2(cards.reduce((a, c) => a + (c.totalHours || 0), 0)),
            vacationBalance: Math.max(0, 15 - approvedDays)
        };
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
        db.collection('laborbudgets').aggregate([{
            $group: {
                _id: '$weekStart', budgetHours: { $sum: '$budgetHours' }, plannedHours: { $sum: '$plannedHours' },
                actualHours: { $sum: '$actualHours' }, budgetAmount: { $sum: '$budgetAmount' }, actualCost: { $sum: '$actualCost' }, plannedCost: { $sum: '$plannedCost' }
            }
        }, { $sort: { _id: 1 } }]).toArray(),
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
        return {
            date, day: dayjs(date).format('ddd'), scheduled: day.length, scheduledHours: day.reduce((a, s) => a + s.hours, 0),
            requiredHours: Math.round(fc.reduce((a, f) => a + f.laborDemandHours, 0)), required: fc.reduce((a, f) => a + f.recommendedStaff, 0),
            open: weekShifts.filter((s) => s.date === date && !s.employeeId).length
        };
    });
    const byDept = {};
    assigned.forEach((s) => { byDept[s.department] = (byDept[s.department] || 0) + s.hours; });
    return {
        role: user.role, weekStart: ws,
        cards: {
            totalEmployees: total, activeEmployees: active, locations, openShifts, pendingTimeOff: pending, attendanceExceptions: exceptions,
            scheduledHours, laborCost, laborBudget: budgetAmount, budgetUtilization: budgetAmount ? Math.round((laborCost / budgetAmount) * 100) : 0
        },
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
    const e = {
        _id: newId(), employeeId: doc.employeeId || `KP${1001 + count}`, status: 'Active', employmentStatus: 'Active', employmentType: 'Full-Time',
        availability: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => ({ day: d, available: d !== 'sun' })),
        hireDate: today(), ...doc, createdAt: new Date().toISOString()
    };
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
    const s = {
        _id: newId(), shiftType: body.shiftType || 'Custom', locationId: body.locationId, date: body.date, start: body.start, end: body.end,
        department: body.department, jobTitle: body.jobTitle, requiredSkills: body.requiredSkills, notes: body.notes || '', posted: !!body.posted,
        employeeId: body.employeeId || null, externalId: body.externalId || null, published: false,
        createdAt: new Date().toISOString(), createdBy: user?.name || 'System', source
    };
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
        db.collection('shifts').aggregate([{ $match: { weekStart: ws } }, {
            $group: {
                _id: '$locationId', shifts: { $sum: 1 },
                hours: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, '$hours', 0] } }, open: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, 0, 1] } },
                cost: { $sum: '$cost' }, unpublished: { $sum: { $cond: ['$published', 0, 1] } }
            }
        }]).toArray(),
        db.collection('laborbudgets').find({ weekStart: ws }).toArray(),
    ]);
    return locs.map((l) => {
        const s = scheds.find((x) => x.locationId === l._id) || {}; const a = agg.find((x) => x._id === l._id) || {};
        const b = budgets.find((x) => x.locationId === l._id);
        const cost = round2(a.cost);
        return {
            locationId: l._id, locationName: l.name, weekStart: ws, status: s.status || 'Not Started', publishedAt: s.publishedAt || null,
            editMode: !!s.editMode, locked: rules.requireEditModeForPublished && s.status === 'Published' && !s.editMode,
            shifts: a.shifts || 0, hours: a.hours || 0, open: a.open || 0, cost, unpublished: a.unpublished || 0,
            budgetAmount: b?.budgetAmount || null, budgetUtilization: b?.budgetAmount ? Math.round((cost / b.budgetAmount) * 100) : null,
            overBudget: !!(b?.budgetAmount && cost > b.budgetAmount * (rules.budgetWarningPct / 100))
        };
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
    else['employeeId', 'locationId'].forEach((k) => query[k] && (f[k] = query[k]));
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
        card = {
            _id: newId(), employeeId: emp._id, employeeName: fullName(emp), locationId: emp.locationId, shiftId: shift?._id || null, date,
            scheduledStart: shift?.start || null, scheduledEnd: shift?.end || null, clockIn: time, mealStart: null, mealEnd: null, clockOut: null,
            rate: emp.hourlyRate, resolved: false, notes: shift ? '' : 'Unscheduled punch', exceptions: []
        };
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
    else['employeeId', 'locationId'].forEach((k) => query[k] && (f[k] = query[k]));
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
    const t = {
        _id: newId(), employeeId: e._id, employeeName: fullName(e), locationId: e.locationId, department: e.department, type: body.type,
        startDate: body.startDate, endDate: body.endDate, days, hours: Number(body.hours) || days * 8, reason: body.reason || '', status: 'Pending',
        submittedAt: new Date().toISOString(), decidedAt: null, decidedBy: null, comment: '', externalId: body.externalId || null
    };
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
            const doc = {
                locationId, date: fmt(date), weekStart: fmt(weekStart(date)), dayOfWeek: date.format('ddd').toLowerCase(), customerTraffic: traffic,
                salesProjection: Math.round(traffic * 0.32 * 58), laborDemandHours, recommendedStaff: Math.ceil(laborDemandHours / 8),
                method: `Weighted 4-week moving average, growth ${Math.round((growth - 1) * 100)}%, promo ${Math.round((uplift - 1) * 100)}%`, createdAt: new Date().toISOString()
            };
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
    roster: {
        title: 'Employee Roster Report', columns: [['employeeId', 'Employee ID'], ['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['locationName', 'Location'],
        ['department', 'Department'], ['jobTitle', 'Job Title'], ['employmentType', 'Type'], ['hireDate', 'Hire Date'], ['hourlyRate', 'Hourly Rate'], ['managerName', 'Manager'], ['status', 'Status']],
        async rows(db, q) {
            const f = {}; if (q.locationId) f.locationId = q.locationId; if (q.status) f.status = q.status;
            return (await db.collection('employees').find(f).sort({ lastName: 1 }).toArray()).map((e) => ({ ...e, name: fullName(e) }));
        }
    },
    schedule: {
        title: 'Schedule Report', columns: [['date', 'Date'], ['locationName', 'Location'], ['employeeName', 'Employee'], ['jobTitle', 'Job Title'], ['department', 'Department'],
        ['start', 'Start'], ['end', 'End'], ['hours', 'Hours'], ['cost', 'Cost'], ['status', 'Status']],
        async rows(db, q, locs) {
            const f = { weekStart: q.weekStart || fmt(weekStart()) }; if (q.locationId) f.locationId = q.locationId;
            return (await db.collection('shifts').find(f).sort({ date: 1, start: 1 }).toArray()).map((s) => ({
                ...s, employeeName: s.employeeName || '(Open shift)',
                locationName: locs[s.locationId], status: `${s.published ? 'Published' : 'Draft'}${s.overtime ? ' / Overtime' : ''}`
            }));
        }
    },
    attendance: {
        title: 'Attendance Report', columns: [['date', 'Date'], ['employeeName', 'Employee'], ['locationName', 'Location'], ['scheduled', 'Scheduled'], ['clockIn', 'Clock In'],
        ['mealStart', 'Meal Start'], ['mealEnd', 'Meal End'], ['clockOut', 'Clock Out'], ['totalHours', 'Hours'], ['exceptionText', 'Exceptions']],
        async rows(db, q, locs) {
            const f = { date: { $gte: q.from || fmt(weekStart().subtract(1, 'week')), $lte: q.to || today() } }; if (q.locationId) f.locationId = q.locationId;
            return (await db.collection('timecards').find(f).sort({ date: -1 }).toArray()).map((t) => ({
                ...t, locationName: locs[t.locationId],
                scheduled: t.scheduledStart ? `${t.scheduledStart}-${t.scheduledEnd}` : 'Unscheduled', exceptionText: [...t.exceptions, t.earlyArrival ? 'Early Arrival' : ''].filter(Boolean).join('; ') + (t.resolved ? ' (resolved)' : '')
            }));
        }
    },
    laborcost: {
        title: 'Labor Cost Report', columns: [['weekStart', 'Week Of'], ['locationName', 'Location'], ['budgetHours', 'Budget Hrs'], ['plannedHours', 'Scheduled Hrs'],
        ['actualHours', 'Actual Hrs'], ['budgetAmount', 'Budget $'], ['plannedCost', 'Scheduled $'], ['actualCost', 'Actual $'], ['costVariance', 'Variance $'], ['utilization', 'Utilization %']],
        async rows(db, q) { return listBudgets({ db, query: q }); }
    },
    timeoff: {
        title: 'Time Off Report', columns: [['employeeName', 'Employee'], ['locationName', 'Location'], ['type', 'Type'], ['startDate', 'Start'], ['endDate', 'End'],
        ['days', 'Days'], ['reason', 'Reason'], ['status', 'Status'], ['decidedBy', 'Decided By'], ['comment', 'Comment']],
        async rows(db, q, locs) {
            const f = {}; if (q.locationId) f.locationId = q.locationId; if (q.status) f.status = q.status;
            return (await db.collection('timeoffrequests').find(f).sort({ startDate: -1 }).toArray()).map((t) => ({ ...t, locationName: locs[t.locationId] }));
        }
    },
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
