/** Reports: roster, schedule, attendance, labor cost, time off - with filters and CSV export. */
import { useEffect, useState } from 'react';
import { FileBarChart, Users, CalendarDays, Clock, Wallet, Plane, Download, Play } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import { PageHeader, Card, EmptyState, Spinner, Badge } from '../components/ui';
import { downloadCsv, weekStart, ymd, dateTime, money2 } from '../lib/format';
import dayjs from 'dayjs';

const TYPES = [
    { id: 'roster', label: 'Employee Roster', icon: Users, desc: 'All employees with job, location and pay details' },
    { id: 'schedule', label: 'Schedule Report', icon: CalendarDays, desc: 'Shifts for a week including open shifts & overtime' },
    { id: 'attendance', label: 'Attendance Report', icon: Clock, desc: 'Punches, hours and exceptions for a date range' },
    { id: 'laborcost', label: 'Labor Cost Report', icon: Wallet, desc: 'Budget vs scheduled vs actual labor by week' },
    { id: 'timeoff', label: 'Time Off Report', icon: Plane, desc: 'All leave requests and approval status' },
];
const MONEY = ['hourlyRate', 'cost', 'budgetAmount', 'plannedCost', 'actualCost', 'costVariance'];

export default function Reports() {
    const { meta, load } = useMeta();
    useEffect(() => { load(); }, [load]);
    const [type, setType] = useState('roster');
    const [f, setF] = useState({ locationId: '', weekStart: ymd(weekStart()), from: ymd(weekStart().subtract(7, 'day')), to: ymd(dayjs()), status: '' });
    const [report, setReport] = useState(null);
    const [busy, setBusy] = useState(false);
    const history = useFetch('/reports');

    const run = async (csv = false) => {
        setBusy(true);
        try {
            const r = await api(`/reports/${type}`, { params: { ...f, format: csv ? 'csv' : '' } });
            setReport(r);
            if (csv) { downloadCsv(`${type}-report-${ymd(dayjs())}.csv`, r.columns, r.rows); toast.success(`Exported ${r.rows.length} rows`); }
            history.reload();
        } catch (e) { toast.error(e.message); } finally { setBusy(false); }
    };
    useEffect(() => { setReport(null); }, [type]);

    return (
        <>
            <PageHeader title="Reports" subtitle="Operational workforce reports with CSV export" />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
                {TYPES.map((t) => (
                    <button key={t.id} onClick={() => setType(t.id)} className={`card p-4 text-left transition ${type === t.id ? 'ring-2 ring-brand-500 bg-brand-50/50' : 'hover:border-brand-300'}`}>
                        <t.icon className="h-5 w-5 text-brand-600 mb-2" /><p className="font-semibold text-sm">{t.label}</p><p className="text-xs text-slate-500 mt-0.5 hidden sm:block">{t.desc}</p>
                    </button>))}
            </div>
            <div className="card p-3 mb-4 flex flex-col md:flex-row gap-3 md:items-end">
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div><label className="label">Location</label><select className="input" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></div>
                    {type === 'schedule' && <div><label className="label">Week starting</label><input type="date" className="input" value={f.weekStart} onChange={(e) => setF({ ...f, weekStart: ymd(weekStart(e.target.value)) })} /></div>}
                    {type === 'attendance' && <><div><label className="label">From</label><input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
                        <div><label className="label">To</label><input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div></>}
                    {type === 'roster' && <div><label className="label">Status</label><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option><option>Active</option><option>Inactive</option></select></div>}
                    {type === 'timeoff' && <div><label className="label">Status</label><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All</option><option>Pending</option><option>Approved</option><option>Rejected</option></select></div>}
                </div>
                <div className="flex gap-2">
                    <button className="btn-primary" disabled={busy} onClick={() => run(false)}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <Play className="h-4 w-4" />}Run report</button>
                    <button className="btn-secondary" disabled={busy} onClick={() => run(true)}><Download className="h-4 w-4" />Export CSV</button>
                </div>
            </div>
            {report ? (
                <>
                    <h2 className="font-semibold mb-2">{report.title} <span className="text-slate-400 font-normal text-sm">({report.rows.length} rows)</span></h2>
                    <DataTable rows={report.rows} pageSize={15} columns={report.columns.map((c) => ({ ...c, render: MONEY.includes(c.key) ? (r) => money2(r[c.key]) : c.key === 'utilization' ? (r) => `${r[c.key]}%` : undefined }))} />
                </>
            ) : <div className="card"><EmptyState icon={FileBarChart} title="Run a report" message="Choose a report type and filters, then click Run report or export straight to CSV." /></div>}
            <Card title="Recent Report Runs" className="mt-6" bodyClass="divide-y">
                {(history.data || []).map((h) => (
                    <div key={h._id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                        <span className="font-medium">{TYPES.find((t) => t.id === h.type)?.label}</span>
                        <span className="text-slate-500 hidden sm:inline">{h.runBy}</span>
                        <span className="text-slate-500">{h.rowCount} rows</span><Badge tone={h.format === 'CSV' ? 'green' : 'blue'}>{h.format}</Badge>
                        <span className="text-slate-400 text-xs">{dateTime(h.createdAt)}</span>
                    </div>))}
            </Card>
        </>
    );
}
