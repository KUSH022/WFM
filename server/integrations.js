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
            const body = strip({
                employeeId: r.employeeId, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, locationId: ctx.loc[r.locationCode]._id,
                department: r.department, jobTitle: r.jobTitle, hireDate: r.hireDate, hourlyRate: r.hourlyRate, employmentType: r.employmentType,
                employmentStatus: r.employmentStatus, status: r.status, skills: r.skills, managerId: r.managerEmployeeId ? ctx.emp[r.managerEmployeeId]._id : undefined
            });
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
            const e = {
                _id: newId(), status: 'Active', employmentStatus: 'Active', employmentType: 'Full-Time', hireDate: fmt(dayjs()),
                availability: DAY_KEYS.map((d) => ({ day: d, available: d !== 'sun' })), managerId: null, managerName: '', ...doc, createdAt: new Date().toISOString()
            };
            await db.collection('employees').insertOne(e);
            ctx.emp[e.employeeId] = e; ctx.empById[e._id] = e;
            await audit(db, user, 'CREATE', 'Employee', `[Inbound API] Created employee ${e.firstName} ${e.lastName} (${e.employeeId})`, e._id);
            return 'inserted';
        },
        async outbound(db, q, ctx) {
            return Object.values(ctx.emp)
                .filter((e) => (!q.locationCode || ctx.locById[e.locationId]?.code === q.locationCode) && (!q.status || e.status === q.status) && (!q.department || e.department === q.department))
                .map((e) => ({
                    employeeId: e.employeeId, firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone, locationCode: ctx.locById[e.locationId]?.code,
                    locationName: e.locationName, department: e.department, jobTitle: e.jobTitle, hireDate: e.hireDate, hourlyRate: e.hourlyRate, employmentType: e.employmentType,
                    employmentStatus: e.employmentStatus, status: e.status, managerEmployeeId: ctx.empById[e.managerId]?.employeeId || null, skills: employeeSkills(e, ctx.org.jobProfiles)
                }))
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
            const l = {
                _id: newId(), status: 'Active', baseTraffic: 450, weeklyLaborBudget: 0, departments: ctx.org.departments.map((n) => ({ name: n, parent: null })),
                operatingHours: Object.fromEntries(DAY_KEYS.map((k) => [k, { open: '08:00', close: '20:00', closed: false }])), ...d, createdAt: new Date().toISOString()
            };
            await db.collection('locations').insertOne(l);
            ctx.loc[l.code] = l; ctx.locById[l._id] = l;
            await audit(db, user, 'CREATE', 'Location', `[Inbound API] Created location ${l.name} (${l.code})`, l._id);
            return 'inserted';
        },
        async outbound(db, q, ctx) {
            return Object.values(ctx.locById).filter((l) => !q.region || l.region === q.region).map((l) => ({
                code: l.code, name: l.name, region: l.region, address: l.address, city: l.city,
                phone: l.phone, costCenter: l.costCenter, status: l.status, weeklyLaborBudget: l.weeklyLaborBudget, operatingHours: l.operatingHours, departments: l.departments
            }));
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
            const body = strip({
                locationId: ctx.loc[r.locationCode]._id, date: r.date, start: r.start, end: r.end, department: r.department, jobTitle: r.jobTitle,
                employeeId: r.employeeId ? ctx.emp[r.employeeId]._id : null, requiredSkills: r.requiredSkills, notes: r.notes, posted: r.posted, externalId: r.externalId
            });
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
            return shifts.map((s) => ({
                shiftId: s._id, externalId: s.externalId || null, locationCode: ctx.locById[s.locationId]?.code, date: s.date, weekday: weekdayName(s.date),
                start: s.start, end: s.end, hours: s.hours, department: s.department, jobTitle: s.jobTitle, employeeId: ctx.empById[s.employeeId]?.employeeId || null,
                employeeName: s.employeeName || null, openShift: !s.employeeId, posted: !!s.posted, published: !!s.published, overtime: !!s.overtime,
                requiredSkills: s.requiredSkills || [], cost: s.cost, scheduleStatus: scheds.find((x) => x.locationId === s.locationId)?.status || 'Draft'
            }));
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
            let card = {
                ...(ex || { _id: newId(), employeeId: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, locationId: emp.locationId, date: r.date, rate: emp.hourlyRate, exceptions: [], resolved: false }),
                shiftId: shift?._id || null, scheduledStart: shift?.start || null, scheduledEnd: shift?.end || null,
                clockIn: r.clockIn, mealStart: r.mealStart || null, mealEnd: r.mealEnd || null, clockOut: r.clockOut || null, notes: r.notes || ex?.notes || ''
            };
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
            return (await db.collection('timecards').find(f).sort({ date: -1 }).toArray()).map((t) => ({
                employeeId: ctx.empById[t.employeeId]?.employeeId, employeeName: t.employeeName,
                locationCode: ctx.locById[t.locationId]?.code, date: t.date, scheduledStart: t.scheduledStart, scheduledEnd: t.scheduledEnd, clockIn: t.clockIn, mealStart: t.mealStart,
                mealEnd: t.mealEnd, clockOut: t.clockOut, totalHours: t.totalHours, cost: t.cost, exceptions: t.exceptions, earlyArrival: !!t.earlyArrival, resolved: !!t.resolved
            }));
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
            const doc = {
                locationId: loc._id, date: r.date, weekStart: fmt(weekStart(r.date)), dayOfWeek: dayjs(r.date).format('ddd').toLowerCase(), customerTraffic: traffic,
                salesProjection: r.salesProjection !== undefined ? Number(r.salesProjection) : Math.round(traffic * 0.32 * 58), laborDemandHours: labor,
                recommendedStaff: Math.ceil(labor / 8), method: 'Inbound API', createdAt: new Date().toISOString()
            };
            const res = await db.collection('forecasts').updateOne({ locationId: loc._id, date: r.date }, { $set: doc, $setOnInsert: { _id: newId() } }, { upsert: true });
            return res.upsertedCount ? 'inserted' : 'updated';
        },
        async outbound(db, q, ctx) {
            const f = { date: { $gte: q.from || fmt(weekStart()), $lte: q.to || fmt(weekStart().add(6, 'day')) } };
            if (q.locationCode) f.locationId = ctx.loc[q.locationCode]?._id || '__none__';
            return (await db.collection('forecasts').find(f).sort({ date: 1 }).toArray()).map((x) => ({
                locationCode: ctx.locById[x.locationId]?.code, date: x.date, weekStart: x.weekStart,
                customerTraffic: x.customerTraffic, salesProjection: x.salesProjection, laborDemandHours: x.laborDemandHours, recommendedStaff: x.recommendedStaff, method: x.method
            }));
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
            const res = await db.collection('laborbudgets').updateOne({ locationId: loc._id, weekStart: r.weekStart }, {
                $set: set,
                $setOnInsert: { _id: newId(), plannedHours: 0, plannedCost: 0, actualHours: null, actualCost: null }
            }, { upsert: true });
            if (r.weekStart === fmt(weekStart())) await db.collection('locations').updateOne({ _id: loc._id }, { $set: { weeklyLaborBudget: set.budgetAmount } });
            await audit(db, user, 'UPDATE', 'Labor Budget', `[Inbound API] ${res.upsertedCount ? 'Created' : 'Updated'} budget ${r.locationCode} week ${r.weekStart}: ${set.budgetHours}h / $${set.budgetAmount}`);
            return res.upsertedCount ? 'inserted' : 'updated';
        },
        async outbound(db, q, ctx) {
            const rows = await listBudgets({ db, query: q.locationCode ? { locationId: ctx.loc[q.locationCode]?._id || '__none__' } : {} });
            return rows.filter((b) => (!q.from || b.weekStart >= q.from) && (!q.to || b.weekStart <= q.to)).map((b) => ({
                locationCode: ctx.locById[b.locationId]?.code, weekStart: b.weekStart,
                budgetHours: b.budgetHours, budgetAmount: b.budgetAmount, plannedHours: b.plannedHours, plannedCost: b.plannedCost, actualHours: b.actualHours, actualCost: b.actualCost,
                hoursVariance: b.hoursVariance, costVariance: b.costVariance, utilization: b.utilization
            }));
        },
        filters: { locationCode: 'Location code', from: 'weekStart from', to: 'weekStart to' },
    },

    'time-off-requests': {
        label: 'Time Off Requests', key: 'externalId',
        fields: {
            externalId: ['string', false, 'Your system\'s request id'], employeeId: ['employeeRef', true], type: ['enum:Vacation|Sick|Personal', true],
            startDate: ['date', true], endDate: ['date', true], reason: ['string', false], status: ['enum:Pending|Approved|Rejected', false, 'Default Pending']
        },
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
            return (await db.collection('timeoffrequests').find(f).sort({ startDate: -1 }).toArray()).map((t) => ({
                requestId: t._id, externalId: t.externalId || null,
                employeeId: ctx.empById[t.employeeId]?.employeeId, employeeName: t.employeeName, locationCode: ctx.locById[t.locationId]?.code, type: t.type, startDate: t.startDate,
                endDate: t.endDate, days: t.days, hours: t.hours, reason: t.reason, status: t.status, submittedAt: t.submittedAt, decidedAt: t.decidedAt, decidedBy: t.decidedBy
            }));
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
            return ctx.org.departments.map((name) => ({
                name, activeHeadcount: emps.filter((e) => e.department === name && e.status === 'Active').length,
                locations: Object.values(ctx.locById).filter((l) => (l.departments || []).some((d) => d.name === name)).map((l) => ({ code: l.code, parent: l.departments.find((d) => d.name === name).parent }))
            }));
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
            return ctx.org.jobTitles.map((title) => ({
                title, ...(ctx.org.jobProfiles?.[title] || {}), skills: employeeSkills({ jobTitle: title }, ctx.org.jobProfiles),
                activeHeadcount: emps.filter((e) => e.jobTitle === title && e.status === 'Active').length
            }));
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
                .map((e) => ({
                    employeeId: e.employeeId, employeeName: `${e.firstName} ${e.lastName}`, locationCode: ctx.locById[e.locationId]?.code, employmentType: e.employmentType,
                    availability: e.availability, availableDays: (e.availability || []).filter((a) => a.available).map((a) => a.day)
                }));
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
