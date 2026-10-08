/**
 * All API route handlers. Each handler receives ({ db, user, params, query, body }) and returns JSON.
 * Kept in a single serverless function (api/index.js) so the project stays within the
 * Vercel Hobby plan function limit and shares one warm MongoDB connection.
 */
import dayjs from 'dayjs';
import { newId } from './db.js';
import { HttpError } from './http.js';
import { checkPassword, hashPassword, signToken, publicUser } from './auth.js';
import { audit } from './audit.js';
import { seedAll, DEPARTMENTS, JOB_TITLES } from './seed.js';
import { fmt, weekStart, hoursBetween, paginate, regex, round2, calcTimecard, toMin } from './utils.js';

const MGR = ['Manager', 'Administrator'];
const ADMIN = ['Administrator'];
const today = () => fmt(dayjs());
const fullName = (e) => `${e.firstName} ${e.lastName}`;
const must = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

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
    const [locations, employees, org] = await Promise.all([
        db.collection('locations').find({}, { projection: { name: 1, code: 1, region: 1, departments: 1, operatingHours: 1 } }).sort({ name: 1 }).toArray(),
        db.collection('employees').find({}, { projection: { firstName: 1, lastName: 1, employeeId: 1, locationId: 1, department: 1, jobTitle: 1, hourlyRate: 1, status: 1, availability: 1, employmentType: 1 } }).sort({ firstName: 1 }).toArray(),
        db.collection('settings').findOne({ _id: 'organization' }),
    ]);
    return {
        locations, employees, departments: org?.departments || DEPARTMENTS, jobTitles: org?.jobTitles || JOB_TITLES,
        regions: org?.regions || [], managers: employees.filter((e) => ['Store Manager', 'Assistant Manager', 'Supervisor'].includes(e.jobTitle) && e.status === 'Active')
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
    'employmentType', 'employmentStatus', 'status', 'managerId', 'availability'];
async function normalizeEmployee(db, body) {
    const doc = {};
    EMP_FIELDS.forEach((f) => body[f] !== undefined && (doc[f] = body[f]));
    if (doc.hourlyRate !== undefined) doc.hourlyRate = round2(Number(doc.hourlyRate));
    if (doc.locationId) doc.locationName = (await db.collection('locations').findOne({ _id: doc.locationId }))?.name || '';
    if (doc.managerId !== undefined) {
        const m = doc.managerId ? await db.collection('employees').findOne({ _id: doc.managerId }) : null;
        doc.managerName = m ? fullName(m) : ''; doc.managerId = m ? m._id : null;
    }
    return doc;
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
    await audit(db, user, 'CREATE', 'Employee', `Created employee ${fullName(e)} (${e.employeeId})`, e._id);
    return e;
}
async function updateEmployee({ db, user, params, body }) {
    const doc = await normalizeEmployee(db, body);
    if (doc.status === 'Inactive' && !doc.employmentStatus) doc.employmentStatus = 'Terminated';
    const r = await db.collection('employees').findOneAndUpdate({ _id: params.id }, { $set: doc }, { returnDocument: 'after' });
    must(r, 404, 'Employee not found');
    if (doc.firstName || doc.lastName) await db.collection('shifts').updateMany({ employeeId: r._id }, { $set: { employeeName: fullName(r) } });
    await audit(db, user, 'UPDATE', 'Employee', `Updated employee ${fullName(r)}`, r._id);
    return r;
}
async function deleteEmployee({ db, user, params }) {
    // Soft delete keeps history (timecards / shifts) intact
    const r = await db.collection('employees').findOneAndUpdate({ _id: params.id }, { $set: { status: 'Inactive', employmentStatus: 'Terminated' } }, { returnDocument: 'after' });
    must(r, 404, 'Employee not found');
    await audit(db, user, 'DEACTIVATE', 'Employee', `Deactivated employee ${fullName(r)}`, r._id);
    return { ok: true };
}

// ============================== LOCATIONS ==============================
async function listLocations({ db }) {
    const [locs, counts] = await Promise.all([
        db.collection('locations').find({}).sort({ name: 1 }).toArray(),
        db.collection('employees').aggregate([{ $match: { status: 'Active' } }, { $group: { _id: '$locationId', n: { $sum: 1 } } }]).toArray(),
    ]);
    return locs.map((l) => ({ ...l, employeeCount: counts.find((c) => c._id === l._id)?.n || 0 }));
}
const LOC_FIELDS = ['name', 'code', 'region', 'address', 'city', 'phone', 'costCenter', 'status', 'operatingHours', 'departments', 'weeklyLaborBudget', 'baseTraffic'];
const pickLoc = (b) => { const d = {}; LOC_FIELDS.forEach((f) => b[f] !== undefined && (d[f] = b[f])); if (d.weeklyLaborBudget !== undefined) d.weeklyLaborBudget = Number(d.weeklyLaborBudget) || 0; return d; };
async function createLocation({ db, user, body }) {
    must(body.name && body.costCenter, 400, 'Name and cost center are required');
    const l = { _id: newId(), status: 'Active', baseTraffic: 450, departments: DEPARTMENTS.map((n) => ({ name: n, parent: null })), ...pickLoc(body), createdAt: new Date().toISOString() };
    await db.collection('locations').insertOne(l);
    await audit(db, user, 'CREATE', 'Location', `Created location ${l.name}`, l._id);
    return l;
}
async function updateLocation({ db, user, params, body }) {
    const r = await db.collection('locations').findOneAndUpdate({ _id: params.id }, { $set: pickLoc(body) }, { returnDocument: 'after' });
    must(r, 404, 'Location not found');
    if (body.name) await db.collection('employees').updateMany({ locationId: r._id }, { $set: { locationName: r.name } });
    if (body.weeklyLaborBudget !== undefined)
        await db.collection('laborbudgets').updateOne({ locationId: r._id, weekStart: fmt(weekStart()) }, { $set: { budgetAmount: Number(body.weeklyLaborBudget) } });
    await audit(db, user, 'UPDATE', 'Location', `Updated location ${r.name}`, r._id);
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
async function buildShift(db, body, existing = {}) {
    const s = { ...existing };
    ['locationId', 'date', 'start', 'end', 'department', 'jobTitle', 'notes', 'shiftType', 'posted'].forEach((k) => body[k] !== undefined && (s[k] = body[k]));
    if (body.employeeId !== undefined) s.employeeId = body.employeeId || null;
    must(s.locationId && s.date && s.start && s.end, 400, 'Location, date, start and end are required');
    s.weekStart = fmt(weekStart(s.date));
    s.hours = hoursBetween(s.start, s.end);
    if (s.employeeId) {
        const e = await db.collection('employees').findOne({ _id: s.employeeId });
        must(e, 404, 'Employee not found');
        must(e.status === 'Active', 400, `${fullName(e)} is inactive`);
        const clash = await db.collection('shifts').find({ employeeId: e._id, date: s.date, _id: { $ne: s._id || '' } }).toArray();
        must(!clash.some((c) => toMin(c.start) < toMin(s.end) && toMin(s.start) < toMin(c.end)), 409, `${fullName(e)} already has an overlapping shift on ${s.date}`);
        s.employeeName = fullName(e); s.rate = e.hourlyRate; s.department = body.department || e.department; s.jobTitle = body.jobTitle || e.jobTitle;
        s.posted = false;
    } else { s.employeeName = ''; s.rate = s.rate || 16; }
    s.cost = s.employeeId ? round2(s.hours * s.rate) : 0;
    s.overtime = s.hours > 8;
    s.published = false; // any change returns the shift to draft until re-published
    return s;
}
async function markDraft(db, s) {
    await db.collection('schedules').updateOne({ locationId: s.locationId, weekStart: s.weekStart },
        { $set: { hasUnpublishedChanges: true }, $setOnInsert: { _id: newId(), status: 'Draft' } }, { upsert: true });
}
async function createShift({ db, user, body }) {
    const s = await buildShift(db, body, { _id: newId(), shiftType: 'Custom' });
    await db.collection('shifts').insertOne(s);
    await markDraft(db, s);
    await audit(db, user, 'CREATE', 'Shift', `Created ${s.employeeName ? 'shift for ' + s.employeeName : 'open shift'} on ${s.date} ${s.start}-${s.end}`, s._id);
    return s;
}
async function updateShift({ db, user, params, body }) {
    const ex = await db.collection('shifts').findOne({ _id: params.id });
    must(ex, 404, 'Shift not found');
    const s = await buildShift(db, body, ex);
    await db.collection('shifts').replaceOne({ _id: s._id }, s);
    await markDraft(db, s);
    await audit(db, user, 'UPDATE', 'Shift', `Edited shift ${ex.employeeName || 'open'} ${ex.date} ${ex.start}-${ex.end} -> ${s.employeeName || 'open'} ${s.date} ${s.start}-${s.end}`, s._id);
    return s;
}
async function deleteShift({ db, user, params }) {
    const s = await db.collection('shifts').findOne({ _id: params.id });
    must(s, 404, 'Shift not found');
    await db.collection('shifts').deleteOne({ _id: s._id });
    await markDraft(db, s);
    await audit(db, user, 'DELETE', 'Shift', `Deleted shift ${s.employeeName || 'open'} on ${s.date}`, s._id);
    return { ok: true };
}
async function claimShift({ db, user, params }) {
    must(user.employeeId, 400, 'Your login is not linked to an employee record');
    const s = await db.collection('shifts').findOne({ _id: params.id, employeeId: null, posted: true });
    must(s, 404, 'This open shift is no longer available');
    const upd = await buildShift(db, { employeeId: user.employeeId }, s);
    upd.published = true; // pickup of a published open shift stays published
    await db.collection('shifts').replaceOne({ _id: s._id }, upd);
    await audit(db, user, 'CLAIM', 'Shift', `Picked up open shift on ${s.date} ${s.start}-${s.end}`, s._id);
    return upd;
}
async function listSchedules({ db, query }) {
    const ws = query.weekStart || fmt(weekStart());
    const [locs, scheds, agg] = await Promise.all([
        db.collection('locations').find({}).sort({ name: 1 }).toArray(),
        db.collection('schedules').find({ weekStart: ws }).toArray(),
        db.collection('shifts').aggregate([{ $match: { weekStart: ws } }, {
            $group: {
                _id: '$locationId', shifts: { $sum: 1 },
                hours: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, '$hours', 0] } }, open: { $sum: { $cond: [{ $ifNull: ['$employeeId', false] }, 0, 1] } },
                cost: { $sum: '$cost' }, unpublished: { $sum: { $cond: ['$published', 0, 1] } }
            }
        }]).toArray(),
    ]);
    return locs.map((l) => {
        const s = scheds.find((x) => x.locationId === l._id) || {}; const a = agg.find((x) => x._id === l._id) || {};
        return {
            locationId: l._id, locationName: l.name, weekStart: ws, status: s.status || 'Not Started', publishedAt: s.publishedAt || null,
            shifts: a.shifts || 0, hours: a.hours || 0, open: a.open || 0, cost: round2(a.cost), unpublished: a.unpublished || 0
        };
    });
}
async function publishSchedule({ db, user, body }) {
    must(body.locationId && body.weekStart, 400, 'locationId and weekStart are required');
    const loc = await db.collection('locations').findOne({ _id: body.locationId });
    must(loc, 404, 'Location not found');
    const r = await db.collection('shifts').updateMany({ locationId: loc._id, weekStart: body.weekStart }, { $set: { published: true } });
    await db.collection('schedules').updateOne({ locationId: loc._id, weekStart: body.weekStart },
        { $set: { status: 'Published', locationName: loc.name, publishedAt: new Date().toISOString(), publishedBy: user.name, hasUnpublishedChanges: false }, $setOnInsert: { _id: newId() } }, { upsert: true });
    await audit(db, user, 'PUBLISH', 'Schedule', `Published schedule for ${loc.name}, week of ${body.weekStart} (${r.matchedCount} shifts)`);
    return { ok: true, published: r.matchedCount };
}
async function copySchedule({ db, user, body }) {
    const { locationId, fromWeek, toWeek, replace } = body;
    must(locationId && fromWeek && toWeek && fromWeek !== toWeek, 400, 'locationId, fromWeek and a different toWeek are required');
    const src = await db.collection('shifts').find({ locationId, weekStart: fromWeek }).toArray();
    must(src.length, 404, 'Source week has no shifts to copy');
    const existing = await db.collection('shifts').countDocuments({ locationId, weekStart: toWeek });
    must(!existing || replace, 409, `Target week already has ${existing} shifts. Enable "replace" to overwrite.`);
    if (existing) await db.collection('shifts').deleteMany({ locationId, weekStart: toWeek });
    const diff = dayjs(toWeek).diff(dayjs(fromWeek), 'day');
    const copies = src.map((s) => ({ ...s, _id: newId(), date: fmt(dayjs(s.date).add(diff, 'day')), weekStart: toWeek, published: false }));
    await db.collection('shifts').insertMany(copies);
    await db.collection('schedules').updateOne({ locationId, weekStart: toWeek }, { $set: { status: 'Draft', hasUnpublishedChanges: true }, $setOnInsert: { _id: newId() } }, { upsert: true });
    await audit(db, user, 'COPY', 'Schedule', `Copied ${copies.length} shifts from week ${fromWeek} to ${toWeek}`);
    return { ok: true, copied: copies.length };
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
    await audit(db, user, 'UPDATE', 'Timecard', `Edited timecard for ${card.employeeName} on ${card.date}${card.resolved ? ' (exception resolved)' : ''}`, card._id);
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
async function createTimeoff({ db, user, body }) {
    const eid = user.role === 'Employee' ? user.employeeId : body.employeeId || user.employeeId;
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
        submittedAt: new Date().toISOString(), decidedAt: null, decidedBy: null, comment: ''
    };
    await db.collection('timeoffrequests').insertOne(t);
    await audit(db, user, 'CREATE', 'Time Off', `${t.type} request ${t.startDate} to ${t.endDate} for ${t.employeeName}`, t._id);
    return t;
}
async function decideTimeoff({ db, user, params, body }) {
    must(['Approved', 'Rejected'].includes(body.decision), 400, 'Decision must be Approved or Rejected');
    const t = await db.collection('timeoffrequests').findOne({ _id: params.id });
    must(t, 404, 'Request not found');
    must(t.status === 'Pending', 400, `Request is already ${t.status}`);
    const upd = { status: body.decision, decidedAt: new Date().toISOString(), decidedBy: user.name, comment: body.comment || '' };
    await db.collection('timeoffrequests').updateOne({ _id: t._id }, { $set: upd });
    await audit(db, user, body.decision === 'Approved' ? 'APPROVE' : 'REJECT', 'Time Off', `${body.decision} ${t.type} request for ${t.employeeName} (${t.startDate} to ${t.endDate})`, t._id);
    return { ...t, ...upd };
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
async function listBudgets({ db, query }) {
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
    const d = {};
    ['budgetHours', 'budgetAmount'].forEach((k) => body[k] !== undefined && (d[k] = Number(body[k])));
    if (body.notes !== undefined) d.notes = body.notes;
    const r = await db.collection('laborbudgets').findOneAndUpdate({ _id: params.id }, { $set: d }, { returnDocument: 'after' });
    must(r, 404, 'Budget not found');
    if (r.weekStart === fmt(weekStart()) && d.budgetAmount !== undefined) await db.collection('locations').updateOne({ _id: r.locationId }, { $set: { weeklyLaborBudget: d.budgetAmount } });
    await audit(db, user, 'UPDATE', 'Labor Budget', `Updated labor budget for ${r.locationName}, week of ${r.weekStart}`, r._id);
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
    return Object.fromEntries(docs.map((d) => [d._id, d]));
}
async function updateSettings({ db, user, params, body }) {
    must(['organization', 'system', 'roles'].includes(params.key), 404, 'Unknown settings group');
    const { _id, ...rest } = body;
    await db.collection('settings').updateOne({ _id: params.key }, { $set: rest }, { upsert: true });
    await audit(db, user, 'UPDATE', 'Settings', `Updated ${params.key} settings`);
    return { ok: true };
}
async function listAudit({ db, query }) {
    const f = {};
    if (query.q) f.$or = [{ details: regex(query.q) }, { userName: regex(query.q) }];
    ['action', 'entity'].forEach((k) => query[k] && (f[k] = query[k]));
    return paginate(db.collection('auditlogs'), f, query, { timestamp: -1 });
}
async function reseed({ db, user }) { await seedAll(db); await audit(db, user, 'RESET', 'Database', 'Demo data reset by administrator'); return { ok: true }; }
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
    ['PUT', 'shifts/:id', updateShift, MGR], ['DELETE', 'shifts/:id', deleteShift, MGR],
    ['GET', 'schedules', listSchedules, MGR], ['POST', 'schedules/publish', publishSchedule, MGR], ['POST', 'schedules/copy', copySchedule, MGR],
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
