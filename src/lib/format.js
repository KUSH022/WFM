import dayjs from 'dayjs';

export const money = (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
export const money2 = (n) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n));
export const num = (n, d = 0) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
export const date = (d) => (d ? dayjs(d).format('MMM D, YYYY') : '—');
export const dateTime = (d) => (d ? dayjs(d).format('MMM D, YYYY h:mm A') : '—');
export const time12 = (t) => (t ? dayjs(`2000-01-01T${t}`).format('h:mm A') : '—');
export const weekStart = (d = dayjs()) => { const x = dayjs(d).startOf('day'); return x.subtract((x.day() + 6) % 7, 'day'); };
export const ymd = (d) => dayjs(d).format('YYYY-MM-DD');

/** Client-side CSV download for report/table exports. */
export function downloadCsv(filename, columns, rows) {
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}
