/** Labor budgeting: weekly budget vs scheduled (planned) vs actual hours & cost with variance. */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Pencil } from 'lucide-react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import dayjs from 'dayjs';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import { PageHeader, Card, StatCard, Modal, Field, PageLoader, ErrorState, Badge } from '../components/ui';
import { money, num } from '../lib/format';
import { Wallet, Clock, Gauge, TrendingDown } from 'lucide-react';

export default function Budget() {
    const { meta, load } = useMeta();
    useEffect(() => { load(); }, [load]);
    const [locationId, setLocationId] = useState('');
    const { data, loading, error, reload } = useFetch('/budgets', { locationId });
    const [edit, setEdit] = useState(null);
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;

    // Aggregate per week (all locations or the selected one)
    const weeks = Object.values(data.reduce((m, b) => {
        const w = (m[b.weekStart] ||= { weekStart: b.weekStart, week: dayjs(b.weekStart).format('MMM D'), budgetHours: 0, plannedHours: 0, actualHours: null, budgetAmount: 0, plannedCost: 0, actualCost: null, isCurrent: b.isCurrent });
        w.budgetHours += b.budgetHours; w.plannedHours += b.plannedHours; w.budgetAmount += b.budgetAmount; w.plannedCost += b.plannedCost;
        if (b.actualHours != null) { w.actualHours = (w.actualHours || 0) + b.actualHours; w.actualCost = (w.actualCost || 0) + b.actualCost; }
        return m;
    }, {})).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const cur = weeks.find((w) => w.isCurrent) || {};
    const util = cur.budgetAmount ? Math.round((cur.plannedCost / cur.budgetAmount) * 100) : 0;

    const cols = [
        { key: 'weekStart', label: 'Week Of', render: (b) => <span>{dayjs(b.weekStart).format('MMM D, YYYY')} {b.isCurrent && <Badge>Current</Badge>}</span> },
        { key: 'locationName', label: 'Location' },
        { key: 'budgetHours', label: 'Budget Hrs', render: (b) => num(b.budgetHours) },
        { key: 'plannedHours', label: 'Scheduled Hrs', render: (b) => num(b.plannedHours, 1) },
        { key: 'actualHours', label: 'Actual Hrs', render: (b) => num(b.actualHours, 1) },
        { key: 'hoursVariance', label: 'Hrs Variance', render: (b) => <span className={b.hoursVariance < 0 ? 'text-red-600 font-semibold' : 'text-emerald-600 font-semibold'}>{num(b.hoursVariance, 1)}</span> },
        { key: 'budgetAmount', label: 'Budget $', render: (b) => money(b.budgetAmount) },
        { key: 'cost', label: 'Sched/Actual $', render: (b) => money(b.actualCost ?? b.plannedCost) },
        { key: 'costVariance', label: '$ Variance', render: (b) => <span className={b.costVariance < 0 ? 'text-red-600 font-semibold' : 'text-emerald-600 font-semibold'}>{money(b.costVariance)}</span> },
        { key: 'utilization', label: 'Util.', render: (b) => <Badge tone={b.utilization > 100 ? 'red' : b.utilization > 95 ? 'yellow' : 'green'}>{b.utilization}%</Badge> },
        { key: 'a', label: '', render: (b) => <button className="btn-ghost btn-sm" onClick={() => setEdit(b)}><Pencil className="h-4 w-4" /></button> },
    ];

    return (
        <>
            <PageHeader title="Labor Budget" subtitle="Weekly budget vs planned and actual labor"
                actions={<select className="input w-56" value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>} />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                <StatCard label="Weekly Budget" value={money(cur.budgetAmount)} icon={Wallet} hint={`${num(cur.budgetHours)} budget hours`} />
                <StatCard label="Scheduled Labor" value={money(cur.plannedCost)} icon={Clock} tone="violet" hint={`${num(cur.plannedHours)} scheduled hours`} />
                <StatCard label="Budget Utilization" value={`${util}%`} icon={Gauge} tone={util > 100 ? 'red' : 'green'} />
                <StatCard label="Remaining Budget" value={money((cur.budgetAmount || 0) - (cur.plannedCost || 0))} icon={TrendingDown} tone="amber" />
            </div>
            <Card title="Budget vs Planned vs Actual Hours" className="mb-4">
                <div className="h-80"><ResponsiveContainer>
                    <ComposedChart data={weeks}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="week" fontSize={12} /><YAxis fontSize={12} /><Tooltip formatter={(v) => num(v, 1)} /><Legend />
                        <Bar dataKey="budgetHours" name="Budget hrs" fill="#bfdbfe" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="plannedHours" name="Scheduled hrs" fill="#2563eb" radius={[4, 4, 0, 0]} />
                        <Line dataKey="actualHours" name="Actual hrs" stroke="#10b981" strokeWidth={2} />
                    </ComposedChart></ResponsiveContainer></div>
            </Card>
            <DataTable columns={cols} rows={[...data].reverse()} loading={loading} pageSize={10} />
            {edit && <EditBudget b={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
        </>
    );
}

function EditBudget({ b, onClose, onSaved }) {
    const { register, handleSubmit } = useForm({ defaultValues: b });
    const save = async (v) => { try { await api(`/budgets/${b._id}`, { method: 'PUT', body: { budgetHours: v.budgetHours, budgetAmount: v.budgetAmount, notes: v.notes } }); toast.success('Budget updated'); onSaved(); } catch (e) { toast.error(e.message); } };
    return (
        <Modal open title={`Budget – ${b.locationName}, week of ${dayjs(b.weekStart).format('MMM D')}`} onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={handleSubmit(save)}>Save</button></>}>
            <div className="grid grid-cols-2 gap-4">
                <Field label="Budget hours"><input type="number" className="input" {...register('budgetHours')} /></Field>
                <Field label="Budget amount ($)"><input type="number" className="input" {...register('budgetAmount')} /></Field>
                <Field label="Notes" className="col-span-2"><input className="input" {...register('notes')} /></Field>
            </div>
        </Modal>
    );
}
