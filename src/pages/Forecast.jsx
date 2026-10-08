/** Demand forecasting: daily & weekly traffic, sales, labor demand and staffing recommendations. */
import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { useForm } from 'react-hook-form';
import { Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, AreaChart, Area } from 'recharts';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import { PageHeader, Card, StatCard, Modal, Field, PageLoader, ErrorState, Spinner } from '../components/ui';
import { money, num, weekStart, ymd } from '../lib/format';
import { Users, ShoppingCart, Clock, UserPlus } from 'lucide-react';

export default function Forecast() {
    const { meta, load } = useMeta();
    useEffect(() => { load(); }, [load]);
    const [locationId, setLocationId] = useState('');
    const [ws, setWs] = useState(weekStart());
    const [gen, setGen] = useState(false);
    const from = ymd(weekStart().subtract(4, 'week')), to = ymd(weekStart().add(8, 'week').subtract(1, 'day'));
    const { data, loading, error, reload } = useFetch('/forecasts', { locationId, from, to });
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;

    const byDate = Object.values(data.reduce((m, f) => {
        const d = (m[f.date] ||= { date: f.date, day: dayjs(f.date).format('ddd D'), customerTraffic: 0, salesProjection: 0, laborDemandHours: 0, recommendedStaff: 0 });
        d.customerTraffic += f.customerTraffic; d.salesProjection += f.salesProjection; d.laborDemandHours += f.laborDemandHours; d.recommendedStaff += f.recommendedStaff; return m;
    }, {})).sort((a, b) => a.date.localeCompare(b.date));
    const week = byDate.filter((d) => d.date >= ymd(ws) && d.date <= ymd(ws.add(6, 'day')));
    const weekly = Object.values(byDate.reduce((m, d) => {
        const k = ymd(weekStart(d.date)); const w = (m[k] ||= { week: dayjs(k).format('MMM D'), k, customerTraffic: 0, salesProjection: 0, laborDemandHours: 0 });
        w.customerTraffic += d.customerTraffic; w.salesProjection += d.salesProjection; w.laborDemandHours += d.laborDemandHours; return m;
    }, {}));
    const sum = (k) => week.reduce((a, d) => a + d[k], 0);

    return (
        <>
            <PageHeader title="Demand Forecasting" subtitle="Customer traffic, sales projections and labor demand"
                actions={<>
                    <select className="input w-56" value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
                    <button className="btn-primary" onClick={() => setGen(true)}><Sparkles className="h-4 w-4" />Generate forecast</button></>} />
            <div className="flex items-center gap-2 mb-4">
                <button className="btn-secondary px-2" onClick={() => setWs(ws.subtract(7, 'day'))}><ChevronLeft className="h-4 w-4" /></button>
                <span className="text-sm font-semibold">Week of {ws.format('MMM D, YYYY')}</span>
                <button className="btn-secondary px-2" onClick={() => setWs(ws.add(7, 'day'))}><ChevronRight className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                <StatCard label="Customer Traffic" value={num(sum('customerTraffic'))} icon={Users} hint="Forecast for the week" />
                <StatCard label="Sales Projection" value={money(sum('salesProjection'))} icon={ShoppingCart} tone="green" />
                <StatCard label="Labor Demand" value={`${num(sum('laborDemandHours'))} hrs`} icon={Clock} tone="violet" />
                <StatCard label="Avg Daily Staff Needed" value={num(sum('recommendedStaff') / (week.length || 1), 1)} icon={UserPlus} tone="amber" />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                <Card title="Daily Demand Forecast">
                    <div className="h-72"><ResponsiveContainer><ComposedChart data={week}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="day" fontSize={12} />
                        <YAxis yAxisId="l" fontSize={12} /><YAxis yAxisId="r" orientation="right" fontSize={12} /><Tooltip formatter={(v) => num(v)} /><Legend />
                        <Bar yAxisId="l" dataKey="customerTraffic" name="Traffic" fill="#93c5fd" radius={[4, 4, 0, 0]} />
                        <Line yAxisId="r" dataKey="laborDemandHours" name="Labor hrs" stroke="#1d4ed8" strokeWidth={2} /></ComposedChart></ResponsiveContainer></div>
                </Card>
                <Card title="Weekly Forecast (12 weeks)">
                    <div className="h-72"><ResponsiveContainer><AreaChart data={weekly}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="week" fontSize={12} /><YAxis fontSize={12} />
                        <Tooltip formatter={(v) => num(v)} /><Legend />
                        <Area dataKey="customerTraffic" name="Traffic" stroke="#2563eb" fill="#dbeafe" />
                        <Area dataKey="laborDemandHours" name="Labor hrs" stroke="#1e3a8a" fill="#93c5fd" /></AreaChart></ResponsiveContainer></div>
                </Card>
            </div>
            <DataTable rows={week} rowKey="date" columns={[
                { key: 'date', label: 'Date', render: (d) => dayjs(d.date).format('ddd, MMM D') },
                { key: 'customerTraffic', label: 'Customer Traffic', render: (d) => num(d.customerTraffic) },
                { key: 'salesProjection', label: 'Sales Projection', render: (d) => money(d.salesProjection) },
                { key: 'laborDemandHours', label: 'Labor Demand Hrs', render: (d) => num(d.laborDemandHours, 1) },
                { key: 'recommendedStaff', label: 'Recommended Staff (8h shifts)', render: (d) => num(d.recommendedStaff) },
            ]} />
            {gen && <GenerateModal meta={meta} onClose={() => setGen(false)} onDone={() => { setGen(false); reload(); }} />}
        </>
    );
}

function GenerateModal({ meta, onClose, onDone }) {
    const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: { locationId: '', weeks: 4, growthPct: 2, promoPct: 0 } });
    const run = async (v) => { try { const r = await api('/forecasts/generate', { method: 'POST', body: v }); toast.success(`Forecast generated (${r.records} daily records)`); onDone(); } catch (e) { toast.error(e.message); } };
    return (
        <Modal open title="Generate Forecast" onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(run)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Generate</button></>}>
            <p className="text-sm text-slate-600 mb-4">Forecasts start next week using a weighted 4-week moving average of the same weekday (40/30/20/10%), adjusted by growth and promotion uplift. Labor demand = traffic × 0.105 hrs; staffing = labor hrs ÷ 8.</p>
            <div className="grid grid-cols-2 gap-4">
                <Field label="Location" className="col-span-2"><select className="input" {...register('locationId')}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></Field>
                <Field label="Weeks ahead (1-12)"><input type="number" min={1} max={12} className="input" {...register('weeks')} /></Field>
                <Field label="Growth %"><input type="number" className="input" {...register('growthPct')} /></Field>
                <Field label="Promotion uplift %"><input type="number" className="input" {...register('promoPct')} /></Field>
            </div>
        </Modal>
    );
}
