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
    const claim = async (s) => { try { await api(`/shifts/${s._id}/claim`, { method: 'POST' }); toast.success('Shift picked up!'); reload(); } catch (e) { toast.error(e.message); } };

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
