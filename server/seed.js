/**
 * Demo data seeder for "KP Retail Group".
 * Runs automatically on the first API request when the users collection is empty
 * and can be re-run by an Administrator (Admin > System Settings > Reset demo data).
 *
 * Seed targets (shown on the dashboard immediately after first launch):
 *   50 employees / 47 active / 5 locations / 12 open shifts / 8 pending time off
 *   1,850 weekly scheduled hours / 92% labor budget utilization / 6 attendance exceptions
 */
import dayjs from 'dayjs';
import { newId, COLLECTIONS } from './db.js';
import { hashPassword } from './auth.js';
import { fmt, weekStart, hoursBetween, calcTimecard, fromMin, toMin, round2, SHIFT_TYPES } from './utils.js';

// Deterministic pseudo-random generator so every seed produces the same demo story.
function rng(seed) {
    return () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const FIRST = ['James', 'Maria', 'Robert', 'Priya', 'Michael', 'Aisha', 'David', 'Sofia', 'Daniel', 'Emily', 'Carlos', 'Olivia', 'Anthony', 'Grace', 'Kevin',
    'Hannah', 'Brian', 'Mei', 'Jason', 'Chloe', 'Marcus', 'Fatima', 'Ryan', 'Isabella', 'Ethan', 'Nora', 'Tyler', 'Leah', 'Jordan', 'Zoe', 'Samuel', 'Ava',
    'Nathan', 'Lily', 'Victor', 'Rachel', 'Andre', 'Megan', 'Lucas', 'Elena', 'Omar', 'Natalie', 'Derek', 'Julia', 'Raj', 'Brooke', 'Patrick', 'Camila', 'Trevor', 'Diana'];
const LAST = ['Anderson', 'Garcia', 'Thompson', 'Patel', 'Johnson', 'Khan', 'Miller', 'Rossi', 'Martinez', 'Clark', 'Rodriguez', 'Nguyen', 'Wilson', 'Kim', 'Brown',
    'Lee', 'Davis', 'Chen', 'Taylor', 'Walker', 'Harris', 'Ali', 'Lewis', 'Lopez', 'Young', 'Hall', 'Allen', 'Wright', 'Scott', 'King', 'Green', 'Adams',
    'Baker', 'Nelson', 'Hill', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner', 'Torres', 'Parker', 'Sharma', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris'];

export const DEPARTMENTS = ['Retail Sales', 'Optical Services', 'Customer Service', 'Inventory', 'Administration'];
export const JOB_TITLES = ['Store Manager', 'Assistant Manager', 'Supervisor', 'Sales Associate', 'Optician', 'Inventory Specialist', 'Customer Service Representative'];

// Position template for the 10 employees in each store
const POSITIONS = ['Store Manager', 'Assistant Manager', 'Supervisor', 'Sales Associate', 'Sales Associate', 'Optician',
    'Inventory Specialist', 'Customer Service Representative', 'Sales Associate', 'Customer Service Representative'];
const DEPT_OF = {
    'Store Manager': 'Administration', 'Assistant Manager': 'Administration', Supervisor: 'Retail Sales', 'Sales Associate': 'Retail Sales',
    Optician: 'Optical Services', 'Inventory Specialist': 'Inventory', 'Customer Service Representative': 'Customer Service'
};
const RATE = {
    'Store Manager': [32, 38], 'Assistant Manager': [26, 30], Supervisor: [22, 25], 'Sales Associate': [15, 18], Optician: [24, 28],
    'Inventory Specialist': [16, 19], 'Customer Service Representative': [15, 17]
};

const LOCATIONS = [
    { code: 'DTN', name: 'KP Downtown Store', region: 'North Region', city: 'Chicago, IL', address: '120 W Madison St', costCenter: 'CC-1001', traffic: 560 },
    { code: 'UPT', name: 'KP Uptown Store', region: 'North Region', city: 'Chicago, IL', address: '4600 N Broadway', costCenter: 'CC-1002', traffic: 470 },
    { code: 'EST', name: 'KP East Store', region: 'South Region', city: 'Atlanta, GA', address: '875 Ponce De Leon Ave', costCenter: 'CC-2001', traffic: 430 },
    { code: 'WST', name: 'KP West Store', region: 'South Region', city: 'Dallas, TX', address: '2300 Cedar Springs Rd', costCenter: 'CC-2002', traffic: 450 },
    { code: 'CTR', name: 'KP Central Store', region: 'North Region', city: 'Indianapolis, IN', address: '50 Monument Cir', costCenter: 'CC-1003', traffic: 510 },
];
const DOW_FACTOR = [0.85, 0.8, 0.9, 1.0, 1.2, 1.45, 1.1]; // Mon..Sun
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let seeding = null;

/** Seed only when the database is empty. Concurrent cold starts share one promise. */
export async function ensureSeed(db) {
    const count = await db.collection('users').estimatedDocumentCount();
    if (count > 0) return false;
    if (!seeding) seeding = seedAll(db).finally(() => { seeding = null; });
    await seeding;
    return true;
}

export async function seedAll(db) {
    const r = rng(20260101);
    const between = (a, b) => a + r() * (b - a);
    const int = (a, b) => Math.floor(between(a, b + 1));
    const now = dayjs();
    const today = fmt(now);
    const ws = weekStart(now);
    const prevWs = ws.subtract(7, 'day');

    for (const c of COLLECTIONS) await db.collection(c).deleteMany({});

    // ---------- Organization settings ----------
    await db.collection('settings').insertMany([
        {
            _id: 'organization', companyName: 'KP Retail Group', regions: ['North Region', 'South Region'], departments: DEPARTMENTS,
            jobTitles: JOB_TITLES, currency: 'USD', timezone: 'America/Chicago', weekStartDay: 'Monday'
        },
        {
            _id: 'system', overtimeThresholdWeekly: 40, overtimeThresholdDaily: 10, lateGraceMinutes: 7, mealBreakAfterHours: 6,
            minMealMinutes: 30, schedulePublishLeadDays: 7, allowShiftPickup: true, sessionHours: 12
        },
        {
            _id: 'roles', roles: [
                {
                    name: 'Administrator', description: 'Full access including user, role and system configuration',
                    permissions: ['dashboard', 'employees', 'locations', 'scheduling', 'attendance', 'timeoff.approve', 'budget', 'forecast', 'reports', 'admin']
                },
                {
                    name: 'Manager', description: 'Manages employees, schedules, timecards and approvals',
                    permissions: ['dashboard', 'employees', 'locations', 'scheduling', 'attendance', 'timeoff.approve', 'budget', 'forecast', 'reports']
                },
                {
                    name: 'Employee', description: 'Self-service: own schedule, time clock and time off',
                    permissions: ['dashboard.self', 'schedule.self', 'timeclock', 'timeoff.request']
                }]
        },
    ]);

    // ---------- Locations ----------
    const locations = LOCATIONS.map((l) => ({
        _id: `loc-${l.code.toLowerCase()}`, code: l.code, name: l.name, region: l.region, address: l.address, city: l.city,
        phone: `(555) ${int(200, 899)}-${int(1000, 9999)}`, costCenter: l.costCenter, status: 'Active', baseTraffic: l.traffic,
        operatingHours: Object.fromEntries(DAY_KEYS.map((d) => [d, d === 'sun' ? { open: '10:00', close: '18:00', closed: false } : { open: '08:00', close: '20:00', closed: false }])),
        departments: [
            { name: 'Store Operations', parent: null }, { name: 'Retail Sales', parent: 'Store Operations' },
            { name: 'Customer Service', parent: 'Store Operations' }, { name: 'Inventory', parent: 'Store Operations' },
            { name: 'Optical Services', parent: null }, { name: 'Administration', parent: null }],
        weeklyLaborBudget: 0, createdAt: now.subtract(3, 'year').toISOString(),
    }));

    // ---------- Employees ----------
    const employees = [];
    const inactive = { 9: 'Terminated', 29: 'On Leave', 49: 'Terminated' };
    for (let i = 0; i < 50; i++) {
        const li = Math.floor(i / 10), pos = i % 10, loc = locations[li], job = POSITIONS[pos];
        let type = 'Full-Time';
        if (pos === 8 || (pos === 7 && li <= 2)) type = 'Part-Time';
        if ((pos === 9 && (li === 1 || li === 3)) || (pos === 7 && li >= 3)) type = 'Weekend-Only';
        let avail = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== i % 7);                 // full-time: 1 fixed day off
        if (type === 'Part-Time') avail = [i % 7, (i + 2) % 7, (i + 4) % 7, (i + 5) % 7].sort();
        if (type === 'Weekend-Only') avail = [5, 6];
        const first = FIRST[i], last = LAST[i];
        const status = inactive[i] ? 'Inactive' : 'Active';
        employees.push({
            _id: `emp-${String(i + 1).padStart(3, '0')}`, employeeId: `KP${String(1001 + i)}`, firstName: first, lastName: last,
            email: `${first}.${last}`.toLowerCase() + '@kpretail.com', phone: `(555) ${int(200, 899)}-${int(1000, 9999)}`,
            department: DEPT_OF[job], jobTitle: job, locationId: loc._id, locationName: loc.name,
            hireDate: fmt(now.subtract(int(60, 3200), 'day')), hourlyRate: round2(between(...RATE[job])),
            employmentType: type, employmentStatus: inactive[i] || 'Active', status,
            availability: DAY_KEYS.map((d, idx) => ({ day: d, available: avail.includes(idx) })),
            managerId: null, managerName: '', createdAt: now.subtract(1, 'year').toISOString(),
        });
    }
    employees[3].email = 'employee@kpwfm.com';  // linked to employee login
    employees[0].email = 'manager@kpwfm.com';   // linked to manager login
    for (const e of employees) {
        const mgr = employees[Math.floor(employees.indexOf(e) / 10) * 10];
        if (mgr !== e) { e.managerId = mgr._id; e.managerName = `${mgr.firstName} ${mgr.lastName}`; }
    }
    const active = employees.filter((e) => e.status === 'Active');

    // ---------- Shifts (previous week + current week) ----------
    function buildWeek(wStart, assignedCount, overtimeCount, openCount, rr) {
        const cands = [];
        for (const e of active) e.availability.forEach((a, d) => a.available && cands.push({ e, d, k: rr() }));
        cands.sort((a, b) => a.k - b.k);
        const shifts = [];
        cands.slice(0, assignedCount).forEach((c, idx) => {
            const types = Object.keys(SHIFT_TYPES);
            let type = c.e.employmentType === 'Weekend-Only' ? 'Mid' : types[Math.floor(rr() * 3)];
            let { start, end } = SHIFT_TYPES[type];
            const overtime = idx < overtimeCount;
            if (overtime) { type = 'Extended'; start = '08:00'; end = '18:00'; }
            const hours = hoursBetween(start, end);
            shifts.push({
                _id: newId(), locationId: c.e.locationId, employeeId: c.e._id, employeeName: `${c.e.firstName} ${c.e.lastName}`,
                date: fmt(wStart.add(c.d, 'day')), weekStart: fmt(wStart), start, end, hours, shiftType: type, department: c.e.department,
                jobTitle: c.e.jobTitle, rate: c.e.hourlyRate, cost: round2(hours * c.e.hourlyRate), overtime, posted: false, published: true, notes: overtime ? 'Overtime - inventory count' : ''
            });
        });
        const openJobs = ['Sales Associate', 'Customer Service Representative', 'Optician', 'Inventory Specialist'];
        for (let i = 0; i < openCount; i++) {
            const loc = locations[i % 5], type = Object.keys(SHIFT_TYPES)[i % 3], job = openJobs[i % 4];
            const { start, end } = SHIFT_TYPES[type];
            shifts.push({
                _id: newId(), locationId: loc._id, employeeId: null, employeeName: '', date: fmt(wStart.add((i * 3 + 1) % 7, 'day')),
                weekStart: fmt(wStart), start, end, hours: hoursBetween(start, end), shiftType: type, department: DEPT_OF[job], jobTitle: job,
                rate: RATE[job][0], cost: 0, overtime: false, posted: i < 8, published: true, notes: i < 8 ? 'Open shift - available for pickup' : 'Unassigned - needs coverage'
            });
        }
        return shifts;
    }
    // 225 x 8h + 5 x 10h overtime = 1,850 scheduled hours this week
    const curShifts = buildWeek(ws, 230, 5, 12, rng(777));
    const prevShifts = buildWeek(prevWs, 226, 3, 0, rng(555));
    // Central store schedule is still in Draft to demonstrate publishing
    curShifts.forEach((s) => { if (s.locationId === 'loc-ctr') s.published = false; });
    await db.collection('shifts').insertMany([...prevShifts, ...curShifts]);

    const schedules = [];
    for (const l of locations) {
        schedules.push({
            _id: newId(), locationId: l._id, locationName: l.name, weekStart: fmt(prevWs), status: 'Published',
            publishedAt: prevWs.subtract(6, 'day').toISOString(), publishedBy: 'Manager User'
        });
        const draft = l._id === 'loc-ctr';
        schedules.push({
            _id: newId(), locationId: l._id, locationName: l.name, weekStart: fmt(ws), status: draft ? 'Draft' : 'Published',
            publishedAt: draft ? null : ws.subtract(5, 'day').toISOString(), publishedBy: draft ? null : 'Manager User'
        });
    }
    await db.collection('schedules').insertMany(schedules);

    // ---------- Timecards (past days only) - exactly 6 open exceptions ----------
    const worked = [...prevShifts, ...curShifts].filter((s) => s.employeeId && s.date < today);
    const timecards = [];
    const missing = new Set([5, 40, 90]), late = new Set([12, 60, 120]);
    worked.forEach((s, idx) => {
        const sMin = toMin(s.start), eMin = toMin(s.end);
        let inMin = sMin + int(-5, 4);
        if (idx % 9 === 0) inMin = sMin - int(10, 20);                 // early arrival examples
        if (late.has(idx)) inMin = sMin + int(12, 25);                  // late arrivals
        const mealS = sMin + 240 + int(-15, 15);
        const tc = {
            _id: newId(), employeeId: s.employeeId, employeeName: s.employeeName, locationId: s.locationId, shiftId: s._id,
            date: s.date, scheduledStart: s.start, scheduledEnd: s.end, clockIn: fromMin(inMin), mealStart: fromMin(mealS), mealEnd: fromMin(mealS + 30),
            clockOut: missing.has(idx) ? null : fromMin(eMin + int(-5, 10)), rate: s.rate, resolved: false, notes: '', exceptions: []
        };
        const c = calcTimecard(tc, today);
        c.cost = round2(c.totalHours * s.rate);
        timecards.push(c);
    });
    if (timecards.length) await db.collection('timecards').insertMany(timecards);

    // ---------- Time off requests: 8 pending, 6 approved, 4 rejected ----------
    const statuses = [...Array(8).fill('Pending'), ...Array(6).fill('Approved'), ...Array(4).fill('Rejected')];
    const types = ['Vacation', 'Sick', 'Vacation', 'Personal', 'Vacation', 'Sick'];
    const reasons = {
        Vacation: ['Family vacation', 'Trip to visit parents', 'Wedding anniversary trip', 'Long weekend getaway'],
        Sick: ['Flu symptoms', 'Doctor appointment', 'Recovering from minor surgery'], Personal: ['Moving to a new apartment', 'Child school event', 'DMV appointment']
    };
    const reqEmps = [employees[3], ...active.filter((_, i) => i % 3 === 1)];
    const timeoff = statuses.map((st, i) => {
        const e = reqEmps[i % reqEmps.length], type = types[i % types.length];
        const start = st === 'Pending' ? now.add(int(5, 40), 'day') : now.add(int(-30, 25), 'day');
        const days = type === 'Vacation' ? int(2, 5) : 1;
        const decided = st !== 'Pending';
        return {
            _id: newId(), employeeId: e._id, employeeName: `${e.firstName} ${e.lastName}`, locationId: e.locationId, department: e.department,
            type, startDate: fmt(start), endDate: fmt(start.add(days - 1, 'day')), days, hours: days * 8, reason: reasons[type][i % reasons[type].length],
            status: st, submittedAt: start.subtract(int(7, 20), 'day').toISOString(),
            decidedAt: decided ? start.subtract(int(1, 6), 'day').toISOString() : null, decidedBy: decided ? 'Manager User' : null,
            comment: st === 'Rejected' ? 'Insufficient coverage for requested dates' : st === 'Approved' ? 'Approved - enjoy!' : ''
        };
    });
    await db.collection('timeoffrequests').insertMany(timeoff);

    // ---------- Forecasts: 12 weeks (4 past + current + 7 future), daily per location ----------
    const forecasts = [];
    const fStart = ws.subtract(4, 'week');
    for (const l of locations) {
        for (let d = 0; d < 84; d++) {
            const date = fStart.add(d, 'day');
            const dow = (date.day() + 6) % 7;
            const traffic = Math.round(l.baseTraffic * DOW_FACTOR[dow] * between(0.92, 1.08) * (1 + d * 0.0012));
            const laborHours = round2(traffic * 0.105);
            forecasts.push({
                _id: newId(), locationId: l._id, date: fmt(date), weekStart: fmt(weekStart(date)), dayOfWeek: DAY_KEYS[dow],
                customerTraffic: traffic, salesProjection: Math.round(traffic * 0.32 * between(52, 64)), laborDemandHours: laborHours,
                recommendedStaff: Math.ceil(laborHours / 8), method: 'Seeded baseline', createdAt: now.toISOString()
            });
        }
    }
    await db.collection('forecasts').insertMany(forecasts);

    // ---------- Labor budgets: 12 weeks (8 past, current, 3 future) - current week = 92% utilization ----------
    const budgets = [];
    for (const l of locations) {
        const avgRate = active.filter((e) => e.locationId === l._id).reduce((a, e, _, arr) => a + e.hourlyRate / arr.length, 0);
        const cur = curShifts.filter((s) => s.locationId === l._id && s.employeeId);
        const curHours = cur.reduce((a, s) => a + s.hours, 0), curCost = cur.reduce((a, s) => a + s.cost, 0);
        for (let w = -8; w <= 3; w++) {
            const wk = ws.add(w, 'week');
            let b;
            if (w === 0) {
                b = { budgetHours: Math.round(curHours / 0.92), budgetAmount: Math.round(curCost / 0.92), plannedHours: curHours, plannedCost: round2(curCost), actualHours: null, actualCost: null };
                l.weeklyLaborBudget = b.budgetAmount;
            } else {
                const budgetHours = Math.round(between(370, 410) * (l.baseTraffic / 500));
                const planned = round2(budgetHours * between(0.9, 1.0));
                const actual = w < 0 ? round2(planned * between(0.95, 1.07)) : null;
                if (w === -1) { /* previous week actuals from timecards */ }
                b = {
                    budgetHours, budgetAmount: Math.round(budgetHours * avgRate), plannedHours: planned, plannedCost: round2(planned * avgRate),
                    actualHours: actual, actualCost: actual === null ? null : round2(actual * avgRate)
                };
            }
            budgets.push({ _id: newId(), locationId: l._id, locationName: l.name, weekStart: fmt(wk), ...b, notes: '' });
        }
    }
    await db.collection('laborbudgets').insertMany(budgets);
    await db.collection('locations').insertMany(locations);
    await db.collection('employees').insertMany(employees);

    // ---------- Users ----------
    const mgrEmp = employees[0], eeEmp = employees[3];
    await db.collection('users').insertMany([
        { _id: 'usr-admin', email: 'admin@kpwfm.com', password: hashPassword('Admin123'), name: 'System Administrator', role: 'Administrator', employeeId: null, active: true, createdAt: now.subtract(1, 'year').toISOString(), lastLogin: null },
        { _id: 'usr-manager', email: 'manager@kpwfm.com', password: hashPassword('Manager123'), name: `${mgrEmp.firstName} ${mgrEmp.lastName}`, role: 'Manager', employeeId: mgrEmp._id, active: true, createdAt: now.subtract(1, 'year').toISOString(), lastLogin: null },
        { _id: 'usr-employee', email: 'employee@kpwfm.com', password: hashPassword('Employee123'), name: `${eeEmp.firstName} ${eeEmp.lastName}`, role: 'Employee', employeeId: eeEmp._id, active: true, createdAt: now.subtract(1, 'year').toISOString(), lastLogin: null },
    ]);

    // ---------- Report history ----------
    const rTypes = ['roster', 'schedule', 'attendance', 'laborcost', 'timeoff'];
    await db.collection('reports').insertMany(Array.from({ length: 10 }, (_, i) => ({
        _id: newId(), type: rTypes[i % 5],
        runBy: i % 2 ? 'System Administrator' : `${mgrEmp.firstName} ${mgrEmp.lastName}`, rowCount: int(12, 240), format: i % 3 ? 'View' : 'CSV',
        createdAt: now.subtract(i * 13 + 2, 'hour').toISOString()
    })));

    // ---------- Audit logs ----------
    const actors = [{ n: 'System Administrator', r: 'Administrator', e: 'admin@kpwfm.com' }, { n: `${mgrEmp.firstName} ${mgrEmp.lastName}`, r: 'Manager', e: 'manager@kpwfm.com' }];
    const samples = [
        ['CREATE', 'Employee', (k) => `Created employee ${employees[45 - k].firstName} ${employees[45 - k].lastName}`],
        ['PUBLISH', 'Schedule', (k) => `Published schedule for ${locations[k % 5].name}, week of ${fmt(ws)}`],
        ['UPDATE', 'Shift', (k) => `Edited shift for ${active[k * 3].firstName} ${active[k * 3].lastName}: 08:00-16:00 -> 10:00-18:00`],
        ['APPROVE', 'Time Off', (k) => `Approved vacation request for ${active[k * 2 + 1].firstName} ${active[k * 2 + 1].lastName}`],
        ['LOGIN', 'Auth', () => 'User signed in'],
        ['UPDATE', 'Labor Budget', (k) => `Updated labor budget for ${locations[k % 5].name}`],
    ];
    const logs = Array.from({ length: 40 }, (_, i) => {
        const [a, ent, d] = samples[i % samples.length]; const who = a === 'LOGIN' ? actors[i % 2] : actors[(i + 1) % 2];
        return {
            _id: newId(), timestamp: now.subtract(i * 7 + int(0, 5), 'hour').toISOString(), userId: null, userName: who.n, userEmail: who.e, role: who.r,
            action: a, entity: ent, entityId: null, details: d(Math.floor(i / samples.length))
        };
    });
    logs.push({ _id: newId(), timestamp: now.toISOString(), userId: null, userName: 'System', userEmail: '', role: 'System', action: 'SEED', entity: 'Database', entityId: null, details: 'Demo data seeded for KP Retail Group' });
    await db.collection('auditlogs').insertMany(logs);

    // ---------- Indexes ----------
    await Promise.all([
        db.collection('users').createIndex({ email: 1 }, { unique: true }),
        db.collection('employees').createIndex({ locationId: 1, status: 1 }),
        db.collection('shifts').createIndex({ weekStart: 1, locationId: 1 }),
        db.collection('timecards').createIndex({ employeeId: 1, date: -1 }),
        db.collection('forecasts').createIndex({ locationId: 1, date: 1 }),
        db.collection('auditlogs').createIndex({ timestamp: -1 }),
    ]);
    return { ok: true };
}
