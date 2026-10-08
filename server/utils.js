/** Shared date / math / query helpers. Weeks start on Monday. */
import dayjs from 'dayjs';

export const fmt = (d) => dayjs(d).format('YYYY-MM-DD');
export const weekStart = (d = dayjs()) => { const x = dayjs(d).startOf('day'); return x.subtract((x.day() + 6) % 7, 'day'); };
export const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const hoursBetween = (s, e) => { let m = toMin(e) - toMin(s); if (m <= 0) m += 1440; return +(m / 60).toFixed(2); };
export const round2 = (n) => Math.round((n || 0) * 100) / 100;

export function pageParams(q) {
    const page = Math.max(1, parseInt(q.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit) || 10));
    return { page, limit, skip: (page - 1) * limit };
}

/** Run a paginated find and return { items, total, page, pages }. */
export async function paginate(col, filter, q, sort = { _id: 1 }) {
    const { page, limit, skip } = pageParams(q);
    const [items, total] = await Promise.all([
        col.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
        col.countDocuments(filter),
    ]);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export const regex = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

export const SHIFT_TYPES = {
    Morning: { start: '08:00', end: '16:00' },
    Mid: { start: '10:00', end: '18:00' },
    Evening: { start: '12:00', end: '20:00' },
};

const EXCEPTION_TYPES = ['Missing Punch', 'Late Arrival', 'Missed Meal Break', 'Early Departure'];

/**
 * Recalculate a timecard: worked hours (minus meal), exceptions and early-arrival flag.
 * `today` (YYYY-MM-DD) is used to detect missing clock-out punches on past days.
 */
export function calcTimecard(tc, today = fmt(dayjs())) {
    const ex = new Set((tc.exceptions || []).filter((e) => !EXCEPTION_TYPES.includes(e)));
    let total = 0;
    if (tc.clockIn && tc.clockOut) {
        total = hoursBetween(tc.clockIn, tc.clockOut);
        if (tc.mealStart && tc.mealEnd) total -= hoursBetween(tc.mealStart, tc.mealEnd);
        else if (total > 6) ex.add('Missed Meal Break');
    }
    if (tc.clockIn && !tc.clockOut && tc.date < today) ex.add('Missing Punch');
    if (tc.mealStart && !tc.mealEnd && tc.clockOut) ex.add('Missing Punch');
    let earlyArrival = false;
    if (tc.scheduledStart && tc.clockIn) {
        const diff = toMin(tc.clockIn) - toMin(tc.scheduledStart);
        if (diff > 7) ex.add('Late Arrival');
        if (diff <= -10) earlyArrival = true;
    }
    if (tc.scheduledEnd && tc.clockOut && toMin(tc.scheduledEnd) - toMin(tc.clockOut) > 15) ex.add('Early Departure');
    return { ...tc, totalHours: round2(Math.max(0, total)), exceptions: [...ex], earlyArrival };
}

export function toCsv(columns, rows) {
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n');
}
