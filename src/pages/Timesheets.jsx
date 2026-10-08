/** Manager timesheet review: filter punches, view exceptions (missing punch / late), edit and resolve. */
import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { useForm } from 'react-hook-form';
import { Pencil, Download } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, Tabs, ErrorState } from '../components/ui';
import { time12, date, num, money2, weekStart, ymd, downloadCsv } from '../lib/format';

export default function Timesheets() {
    const { meta, load } = useMeta();
    useEffect(() => { load(); }, [load]);
    const [tab, setTab] = useState('exceptions');
    const [f, setF] = useState({ q: '', locationId: '', from: ymd(weekStart().subtract(7, 'day')), to: ymd(dayjs()), page: 1, limit: 15 });
    const params = { ...f, exceptionsOnly: tab === 'exceptions' ? 'true' : '' };
    const { data, loading, error, reload } = useFetch('/timecards', params);
    const counts = useFetch('/timecards', { exceptionsOnly: 'true', limit: 1 });
    const [edit, setEdit] = useState(null);
    const set = (k) => (v) => setF((p) => ({ ...p, [k]: v?.target ? v.target.value : v, page: 1 }));

    const cols = [
        { key: 'date', label: 'Date', render: (r) => date(r.date) },
        { key: 'employeeName', label: 'Employee', render: (r) => <span className="font-medium">{r.employeeName}</span> },
        { key: 'scheduled', label: 'Scheduled', render: (r) => r.scheduledStart ? `${time12(r.scheduledStart)} – ${time12(r.scheduledEnd)}` : 'Unscheduled' },
        { key: 'clockIn', label: 'Clock In', render: (r) => <span>{time12(r.clockIn)}{r.earlyArrival && <span className="ml-1"><Badge tone="purple">Early</Badge></span>}</span> },
        { key: 'meal', label: 'Meal Break', render: (r) => r.mealStart ? `${time12(r.mealStart)} – ${time12(r.mealEnd)}` : '—' },
        { key: 'clockOut', label: 'Clock Out', render: (r) => r.clockOut ? time12(r.clockOut) : <span className="text-red-600 font-medium">Missing</span> },
        { key: 'totalHours', label: 'Hours', render: (r) => num(r.totalHours, 2) },
        { key: 'cost', label: 'Cost', render: (r) => money2(r.cost) },
        { key: 'exceptions', label: 'Exceptions', render: (r) => r.exceptions.length ? <div className="flex gap-1">{r.exceptions.map((e) => <Badge key={e} tone={r.resolved ? 'gray' : 'red'}>{e}</Badge>)}{r.resolved && <Badge tone="green">Resolved</Badge>}</div> : <Badge tone="green">OK</Badge> },
        { key: 'a', label: '', render: (r) => <button className="btn-ghost btn-sm" onClick={() => setEdit(r)}><Pencil className="h-4 w-4" /></button> },
    ];
    const exportCsv = async () => {
        const all = await api('/timecards', { params: { ...params, page: 1, limit: 500 } });
        downloadCsv('timesheets.csv', [{ key: 'date', label: 'Date' }, { key: 'employeeName', label: 'Employee' }, { key: 'scheduledStart', label: 'Sched Start' }, { key: 'scheduledEnd', label: 'Sched End' },
        { key: 'clockIn', label: 'In' }, { key: 'mealStart', label: 'Meal Start' }, { key: 'mealEnd', label: 'Meal End' }, { key: 'clockOut', label: 'Out' }, { key: 'totalHours', label: 'Hours' }, { key: 'ex', label: 'Exceptions' }],
            all.items.map((r) => ({ ...r, ex: r.exceptions.join('; ') })));
    };

    return (
        <>
            <PageHeader title="Time & Attendance" subtitle="Review timesheets, missing punches and attendance exceptions"
                actions={<button className="btn-secondary" onClick={exportCsv}><Download className="h-4 w-4" />Export CSV</button>} />
            <Tabs value={tab} onChange={(t) => { setTab(t); setF((p) => ({ ...p, page: 1 })); }} tabs={[{ value: 'exceptions', label: 'Open Exceptions', count: counts.data?.total }, { value: 'all', label: 'All Timecards' }]} />
            <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <SearchBar value={f.q} onChange={set('q')} placeholder="Search employee…" />
                <select className="input" value={f.locationId} onChange={set('locationId')}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
                <input type="date" className="input" value={f.from} onChange={set('from')} />
                <input type="date" className="input" value={f.to} onChange={set('to')} />
            </div>
            {error ? <ErrorState message={error} onRetry={reload} /> :
                <DataTable columns={cols} rows={data?.items || []} loading={loading} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF((x) => ({ ...x, page: p }))} />}
            {edit && <EditCard card={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); counts.reload(); }} />}
        </>
    );
}

function EditCard({ card, onClose, onSaved }) {
    const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: { ...card, resolved: true } });
    const save = async (v) => {
        try { await api(`/timecards/${card._id}`, { method: 'PUT', body: { clockIn: v.clockIn, mealStart: v.mealStart, mealEnd: v.mealEnd, clockOut: v.clockOut, notes: v.notes, resolved: !!v.resolved } }); toast.success('Timecard updated'); onSaved(); }
        catch (e) { toast.error(e.message); }
    };
    return (
        <Modal open title={`Edit timecard – ${card.employeeName}, ${date(card.date)}`} onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button></>}>
            <div className="grid grid-cols-2 gap-4">
                <p className="col-span-2 text-sm text-slate-500">Scheduled: {card.scheduledStart ? `${time12(card.scheduledStart)} – ${time12(card.scheduledEnd)}` : 'Unscheduled'}</p>
                <Field label="Clock in"><input type="time" className="input" {...register('clockIn')} /></Field>
                <Field label="Clock out"><input type="time" className="input" {...register('clockOut')} /></Field>
                <Field label="Meal start"><input type="time" className="input" {...register('mealStart')} /></Field>
                <Field label="Meal end"><input type="time" className="input" {...register('mealEnd')} /></Field>
                <Field label="Manager note" className="col-span-2"><input className="input" placeholder="Reason for edit" {...register('notes')} /></Field>
                <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" {...register('resolved')} />Mark exceptions as resolved</label>
            </div>
        </Modal>
    );
}
