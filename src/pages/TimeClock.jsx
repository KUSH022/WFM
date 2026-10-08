/** Time clock: clock in/out and meal break punches with live status. Times use the browser's local clock. */
import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { LogIn, LogOut, Coffee, UtensilsCrossed } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import { PageHeader, Card, PageLoader, ErrorState, Badge, Spinner } from '../components/ui';
import { time12, date, num } from '../lib/format';

export default function TimeClock() {
    const [now, setNow] = useState(dayjs());
    const [busy, setBusy] = useState(false);
    const [page, setPage] = useState(1);
    useEffect(() => { const t = setInterval(() => setNow(dayjs()), 1000); return () => clearInterval(t); }, []);
    const today = now.format('YYYY-MM-DD');
    const { data, loading, error, reload } = useFetch('/timecards/status', { date: today });
    const history = useFetch('/timecards', { page, limit: 7 });

    const punch = async (action, label) => {
        setBusy(true);
        try { await api('/timecards/punch', { method: 'POST', body: { action, date: today, time: dayjs().format('HH:mm') } }); toast.success(`${label} recorded at ${dayjs().format('h:mm A')}`); reload(); history.reload(); }
        catch (e) { toast.error(e.message); } finally { setBusy(false); }
    };
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} />;
    const c = data.card;
    const state = !c ? 'out' : c.clockOut ? 'done' : c.mealStart && !c.mealEnd ? 'meal' : 'in';
    const status = { out: ['Not clocked in', 'gray'], in: ['Working', 'green'], meal: ['On meal break', 'yellow'], done: ['Shift complete', 'blue'] }[state];

    return (
        <>
            <PageHeader title="Time Clock" subtitle="Record your punches for today" />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <div className="card p-8 text-center lg:col-span-2">
                    <p className="text-sm text-slate-500">{now.format('dddd, MMMM D, YYYY')}</p>
                    <p className="text-5xl sm:text-6xl font-bold text-slate-900 my-3 tabular-nums">{now.format('h:mm:ss A')}</p>
                    <Badge tone={status[1]}>{status[0]}</Badge>
                    <p className="text-sm text-slate-500 mt-3">{data.shift ? `Scheduled today: ${time12(data.shift.start)} – ${time12(data.shift.end)}` : 'No shift scheduled today'}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
                        <button className="btn-primary py-3" disabled={busy || state !== 'out'} onClick={() => punch('in', 'Clock in')}><LogIn className="h-4 w-4" />Clock In</button>
                        <button className="btn-secondary py-3" disabled={busy || state !== 'in' || !!c?.mealStart} onClick={() => punch('mealStart', 'Meal start')}><Coffee className="h-4 w-4" />Start Meal</button>
                        <button className="btn-secondary py-3" disabled={busy || state !== 'meal'} onClick={() => punch('mealEnd', 'Meal end')}><UtensilsCrossed className="h-4 w-4" />End Meal</button>
                        <button className="btn-danger py-3" disabled={busy || state !== 'in'} onClick={() => punch('out', 'Clock out')}><LogOut className="h-4 w-4" />Clock Out</button>
                    </div>
                    {busy && <Spinner className="h-5 w-5 mx-auto mt-4" />}
                </div>
                <Card title="Today's Punches">
                    <dl className="space-y-3 text-sm">
                        {[['Clock in', c?.clockIn], ['Meal start', c?.mealStart], ['Meal end', c?.mealEnd], ['Clock out', c?.clockOut]].map(([k, v]) => (
                            <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd className="font-semibold">{time12(v)}</dd></div>))}
                        <div className="flex justify-between border-t pt-3"><dt className="text-slate-500">Worked hours</dt><dd className="font-semibold">{num(c?.totalHours || 0, 2)}</dd></div>
                        {c?.exceptions?.length > 0 && <div className="flex gap-1 flex-wrap">{c.exceptions.map((e) => <Badge key={e} tone="red">{e}</Badge>)}</div>}
                    </dl>
                </Card>
            </div>
            <h2 className="font-semibold mb-3">My Timesheet</h2>
            <DataTable loading={history.loading} rows={history.data?.items || []} page={page} pages={history.data?.pages || 1} total={history.data?.total || 0} onPage={setPage}
                columns={[
                    { key: 'date', label: 'Date', render: (r) => date(r.date) },
                    { key: 'sched', label: 'Scheduled', render: (r) => r.scheduledStart ? `${time12(r.scheduledStart)} – ${time12(r.scheduledEnd)}` : '—' },
                    { key: 'clockIn', label: 'In', render: (r) => time12(r.clockIn) },
                    { key: 'meal', label: 'Meal', render: (r) => r.mealStart ? `${time12(r.mealStart)} – ${time12(r.mealEnd)}` : '—' },
                    { key: 'clockOut', label: 'Out', render: (r) => time12(r.clockOut) },
                    { key: 'totalHours', label: 'Hours', render: (r) => num(r.totalHours, 2) },
                    { key: 'exceptions', label: 'Status', render: (r) => r.exceptions.length ? r.exceptions.map((e) => <Badge key={e} tone={r.resolved ? 'gray' : 'red'}>{e}</Badge>) : <Badge tone="green">OK</Badge> },
                ]} />
        </>
    );
}
