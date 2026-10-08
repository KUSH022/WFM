/** Time off: employees request & track; managers approve/reject (approval workflow). */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Check, X, Ban } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useAuth, isManager } from '../store/authStore';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, Tabs, ErrorState, EmptyState } from '../components/ui';
import { date, dateTime } from '../lib/format';
import { Plane } from 'lucide-react';

export default function TimeOff() {
    const user = useAuth((s) => s.user);
    const mgr = isManager(user);
    const [tab, setTab] = useState(mgr ? 'Pending' : '');
    const [f, setF] = useState({ q: '', type: '', page: 1, limit: 10 });
    const { data, loading, error, reload } = useFetch('/timeoff', { ...f, status: tab });
    const pending = useFetch('/timeoff', { status: 'Pending', limit: 1 });
    const [form, setForm] = useState(false);
    const [decide, setDecide] = useState(null);
    const refresh = () => { reload(); pending.reload(); };
    const cancel = async (t) => { try { await api(`/timeoff/${t._id}`, { method: 'DELETE' }); toast.success('Request cancelled'); refresh(); } catch (e) { toast.error(e.message); } };

    const cols = [
        ...(mgr ? [{ key: 'employeeName', label: 'Employee', render: (t) => <div><p className="font-medium">{t.employeeName}</p><p className="text-xs text-slate-500">{t.department}</p></div> }] : []),
        { key: 'type', label: 'Type', render: (t) => <Badge tone={t.type === 'Sick' ? 'red' : t.type === 'Personal' ? 'purple' : 'blue'}>{t.type}</Badge> },
        { key: 'dates', label: 'Dates', render: (t) => `${date(t.startDate)} – ${date(t.endDate)}` },
        { key: 'days', label: 'Days' },
        { key: 'reason', label: 'Reason', className: 'max-w-[220px] truncate' },
        { key: 'submittedAt', label: 'Submitted', render: (t) => date(t.submittedAt) },
        { key: 'status', label: 'Status', render: (t) => <div><Badge>{t.status}</Badge>{t.decidedBy && <p className="text-[11px] text-slate-500 mt-0.5">by {t.decidedBy}</p>}</div> },
        {
            key: 'a', label: '', render: (t) => t.status !== 'Pending' ? null : mgr ? (
                <div className="flex gap-1 justify-end">
                    <button className="btn-sm btn bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => setDecide({ t, decision: 'Approved' })}><Check className="h-3.5 w-3.5" />Approve</button>
                    <button className="btn-sm btn-danger" onClick={() => setDecide({ t, decision: 'Rejected' })}><X className="h-3.5 w-3.5" />Reject</button>
                </div>) : <button className="btn-ghost btn-sm" onClick={() => cancel(t)}><Ban className="h-3.5 w-3.5" />Cancel</button>
        },
    ];
    const tabs = [{ value: 'Pending', label: 'Pending', count: pending.data?.total }, { value: 'Approved', label: 'Approved' }, { value: 'Rejected', label: 'Rejected' }, { value: '', label: 'All' }];

    return (
        <>
            <PageHeader title={mgr ? 'Time Off Management' : 'My Time Off'} subtitle={mgr ? 'Review and approve vacation, sick and personal leave' : 'Request vacation, sick or personal leave and track status'}
                actions={<button className="btn-primary" onClick={() => setForm(true)}><Plus className="h-4 w-4" />New request</button>} />
            <Tabs tabs={mgr ? tabs : [tabs[3], ...tabs.slice(0, 3)]} value={tab} onChange={(v) => { setTab(v); setF((p) => ({ ...p, page: 1 })); }} />
            <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {mgr && <SearchBar className="sm:col-span-2" value={f.q} onChange={(q) => setF((p) => ({ ...p, q, page: 1 }))} placeholder="Search employee…" />}
                <select className="input" value={f.type} onChange={(e) => setF((p) => ({ ...p, type: e.target.value, page: 1 }))}><option value="">All types</option><option>Vacation</option><option>Sick</option><option>Personal</option></select>
            </div>
            {error ? <ErrorState message={error} onRetry={reload} /> :
                <DataTable columns={cols} rows={data?.items || []} loading={loading} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF((x) => ({ ...x, page: p }))}
                    empty={<EmptyState icon={Plane} title="No time off requests" message={tab === 'Pending' ? 'All caught up – nothing awaiting approval.' : ''} />} />}
            {form && <RequestForm mgr={mgr} onClose={() => setForm(false)} onSaved={() => { setForm(false); refresh(); }} />}
            {decide && <DecisionModal {...decide} onClose={() => setDecide(null)} onSaved={() => { setDecide(null); refresh(); }} />}
        </>
    );
}

function RequestForm({ mgr, onClose, onSaved }) {
    const meta = useMeta((s) => s.meta);
    const load = useMeta((s) => s.load);
    useEffect(() => { if (mgr) load(); }, [mgr, load]);
    const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm({ defaultValues: { type: 'Vacation' } });
    const submit = async (v) => { try { await api('/timeoff', { method: 'POST', body: v }); toast.success('Request submitted for approval'); onSaved(); } catch (e) { toast.error(e.message); } };
    return (
        <Modal open title="New Time Off Request" onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>Submit</button></>}>
            <div className="grid grid-cols-2 gap-4">
                {mgr && <Field label="Employee (blank = myself)" className="col-span-2"><select className="input" {...register('employeeId')}><option value="">Myself</option>{meta?.employees.filter((e) => e.status === 'Active').map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName}</option>)}</select></Field>}
                <Field label="Type" className="col-span-2"><select className="input" {...register('type')}><option>Vacation</option><option value="Sick">Sick leave</option><option value="Personal">Personal leave</option></select></Field>
                <Field label="Start date *" error={errors.startDate}><input type="date" className="input" {...register('startDate', { required: true })} /></Field>
                <Field label="End date *" error={errors.endDate}><input type="date" className="input" {...register('endDate', { required: true, validate: (v) => v >= watch('startDate') || 'End must be after start' })} /></Field>
                <Field label="Reason" className="col-span-2"><textarea className="input" rows={3} {...register('reason')} /></Field>
            </div>
        </Modal>
    );
}

function DecisionModal({ t, decision, onClose, onSaved }) {
    const [comment, setComment] = useState('');
    const submit = async () => { try { await api(`/timeoff/${t._id}/decision`, { method: 'PUT', body: { decision, comment } }); toast.success(`Request ${decision.toLowerCase()}`); onSaved(); } catch (e) { toast.error(e.message); } };
    return (
        <Modal open title={`${decision === 'Approved' ? 'Approve' : 'Reject'} request`} onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className={decision === 'Approved' ? 'btn-primary' : 'btn-danger'} onClick={submit}>{decision === 'Approved' ? 'Approve' : 'Reject'}</button></>}>
            <p className="text-sm text-slate-600 mb-3"><b>{t.employeeName}</b> · {t.type} · {date(t.startDate)} – {date(t.endDate)} ({t.days} day{t.days > 1 ? 's' : ''})<br />Submitted {dateTime(t.submittedAt)}</p>
            <Field label="Comment (optional)"><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        </Modal>
    );
}
