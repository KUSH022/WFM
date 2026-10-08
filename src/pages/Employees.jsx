import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Download, Pencil, UserX } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, ConfirmModal, ErrorState, Spinner } from '../components/ui';
import { money2, date, downloadCsv } from '../lib/format';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Employees() {
    const { meta, load } = useMeta();
    const [f, setF] = useState({ q: '', locationId: '', department: '', status: '', page: 1, limit: 10 });
    const { data, loading, error, reload } = useFetch('/employees', f);
    const [edit, setEdit] = useState(null);
    const [confirm, setConfirm] = useState(null);
    useEffect(() => { load(); }, [load]);
    const set = (k) => (v) => setF((p) => ({ ...p, [k]: v?.target ? v.target.value : v, page: 1 }));

    const exportCsv = async () => {
        const all = await api('/employees', { params: { ...f, page: 1, limit: 500 } });
        downloadCsv('employees.csv', cols.filter((c) => c.key !== 'actions').map((c) => ({ key: c.csv || c.key, label: c.label })), all.items.map((e) => ({ ...e, name: `${e.firstName} ${e.lastName}` })));
    };
    const deactivate = async () => {
        try { await api(`/employees/${confirm._id}`, { method: 'DELETE' }); toast.success('Employee deactivated'); setConfirm(null); reload(); load(true); }
        catch (e) { toast.error(e.message); }
    };

    const cols = [
        { key: 'employeeId', label: 'ID' },
        { key: 'name', label: 'Name', csv: 'name', render: (e) => <div><p className="font-medium text-slate-900">{e.firstName} {e.lastName}</p><p className="text-xs text-slate-500">{e.email}</p></div> },
        { key: 'jobTitle', label: 'Job Title' },
        { key: 'department', label: 'Department' },
        { key: 'locationName', label: 'Location' },
        { key: 'employmentType', label: 'Type' },
        { key: 'hourlyRate', label: 'Rate', render: (e) => money2(e.hourlyRate) },
        { key: 'hireDate', label: 'Hire Date', render: (e) => date(e.hireDate) },
        { key: 'managerName', label: 'Manager', render: (e) => e.managerName || '—' },
        { key: 'status', label: 'Status', render: (e) => <div className="flex gap-1"><Badge>{e.status}</Badge>{e.employmentStatus !== e.status && e.employmentStatus !== 'Active' && <Badge>{e.employmentStatus}</Badge>}</div> },
        {
            key: 'actions', label: '', render: (e) => (
                <div className="flex gap-1 justify-end">
                    <button className="btn-ghost btn-sm" onClick={() => setEdit(e)} title="Edit"><Pencil className="h-4 w-4" /></button>
                    {e.status === 'Active' && <button className="btn-ghost btn-sm text-red-600" onClick={() => setConfirm(e)} title="Deactivate"><UserX className="h-4 w-4" /></button>}
                </div>)
        },
    ];

    return (
        <>
            <PageHeader title="Employees" subtitle="Manage employee profiles, assignments and status"
                actions={<><button className="btn-secondary" onClick={exportCsv}><Download className="h-4 w-4" />Export</button><button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Add employee</button></>} />
            <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <SearchBar className="lg:col-span-2" value={f.q} onChange={set('q')} placeholder="Search name, email, ID, job…" />
                <select className="input" value={f.locationId} onChange={set('locationId')}><option value="">All locations</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
                <select className="input" value={f.department} onChange={set('department')}><option value="">All departments</option>{meta?.departments.map((d) => <option key={d}>{d}</option>)}</select>
                <select className="input" value={f.status} onChange={set('status')}><option value="">All statuses</option><option>Active</option><option>Inactive</option></select>
            </div>
            {error ? <ErrorState message={error} onRetry={reload} /> :
                <DataTable columns={cols} rows={data?.items || []} loading={loading} page={data?.page || 1} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF((x) => ({ ...x, page: p }))} />}
            {edit && <EmployeeForm employee={edit} meta={meta} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); load(true); }} />}
            <ConfirmModal open={!!confirm} danger title="Deactivate employee" confirmLabel="Deactivate" onClose={() => setConfirm(null)} onConfirm={deactivate}
                message={`${confirm?.firstName} ${confirm?.lastName} will be marked inactive and can no longer be scheduled. History is preserved.`} />
        </>
    );
}

function EmployeeForm({ employee, meta, onClose, onSaved }) {
    const isNew = !employee._id;
    const avail = Object.fromEntries((employee.availability || DAYS.map((d) => ({ day: d, available: d !== 'sun' }))).map((a) => [a.day, a.available]));
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
        defaultValues: { employmentType: 'Full-Time', employmentStatus: 'Active', status: 'Active', hireDate: new Date().toISOString().slice(0, 10), ...employee, avail },
    });
    const submit = async (v) => {
        const { avail: a, _id, createdAt, locationName, managerName, ...rest } = v;
        const body = { ...rest, availability: DAYS.map((d) => ({ day: d, available: !!a[d] })) };
        try {
            await api(isNew ? '/employees' : `/employees/${employee._id}`, { method: isNew ? 'POST' : 'PUT', body });
            toast.success(isNew ? 'Employee created' : 'Employee updated'); onSaved();
        } catch (e) { toast.error(e.message); }
    };
    const req = { required: 'Required' };
    return (
        <Modal open title={isNew ? 'Add Employee' : `Edit ${employee.firstName} ${employee.lastName}`} onClose={onClose} size="max-w-3xl"
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Save</button></>}>
            <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" onSubmit={handleSubmit(submit)}>
                <Field label="Employee ID"><input className="input" placeholder="Auto-generated" {...register('employeeId')} /></Field>
                <Field label="First name *" error={errors.firstName}><input className="input" {...register('firstName', req)} /></Field>
                <Field label="Last name *" error={errors.lastName}><input className="input" {...register('lastName', req)} /></Field>
                <Field label="Email *" error={errors.email}><input className="input" type="email" {...register('email', { ...req, pattern: { value: /\S+@\S+\.\S+/, message: 'Invalid email' } })} /></Field>
                <Field label="Phone"><input className="input" {...register('phone')} /></Field>
                <Field label="Hire date"><input className="input" type="date" {...register('hireDate')} /></Field>
                <Field label="Location *" error={errors.locationId}><select className="input" {...register('locationId', req)}><option value="">Select…</option>{meta?.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></Field>
                <Field label="Department *" error={errors.department}><select className="input" {...register('department', req)}><option value="">Select…</option>{meta?.departments.map((d) => <option key={d}>{d}</option>)}</select></Field>
                <Field label="Job title *" error={errors.jobTitle}><select className="input" {...register('jobTitle', req)}><option value="">Select…</option>{meta?.jobTitles.map((d) => <option key={d}>{d}</option>)}</select></Field>
                <Field label="Hourly rate ($) *" error={errors.hourlyRate}><input className="input" type="number" step="0.01" {...register('hourlyRate', { ...req, min: { value: 7.25, message: 'Below minimum wage' } })} /></Field>
                <Field label="Employment type"><select className="input" {...register('employmentType')}><option>Full-Time</option><option>Part-Time</option><option>Weekend-Only</option></select></Field>
                <Field label="Manager"><select className="input" {...register('managerId')}><option value="">None</option>{meta?.managers.filter((m) => m._id !== employee._id).map((m) => <option key={m._id} value={m._id}>{m.firstName} {m.lastName} – {m.jobTitle}</option>)}</select></Field>
                <Field label="Employment status"><select className="input" {...register('employmentStatus')}><option>Active</option><option>On Leave</option><option>Terminated</option></select></Field>
                <Field label="Active / Inactive"><select className="input" {...register('status')}><option>Active</option><option>Inactive</option></select></Field>
                <div className="sm:col-span-2 lg:col-span-3">
                    <label className="label">Availability</label>
                    <div className="flex flex-wrap gap-2">
                        {DAYS.map((d) => <label key={d} className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm capitalize"><input type="checkbox" {...register(`avail.${d}`)} />{d}</label>)}
                    </div>
                </div>
            </form>
        </Modal>
    );
}
