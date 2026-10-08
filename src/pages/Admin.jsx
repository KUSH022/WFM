/** Administration: users, roles & permissions, system settings, organization configuration, audit logs. */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus, Pencil, Trash2, RotateCcw, ShieldCheck, Check } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import DataTable from '../components/DataTable';
import SearchBar from '../components/SearchBar';
import { PageHeader, Tabs, Badge, Modal, Field, Card, PageLoader, ErrorState, ConfirmModal, Spinner } from '../components/ui';
import { dateTime } from '../lib/format';

export default function Admin() {
    const [tab, setTab] = useState('users');
    return (
        <>
            <PageHeader title="Administration" subtitle="Users, roles, system settings, organization and audit trail" />
            <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users' }, { value: 'roles', label: 'Roles' }, { value: 'settings', label: 'System Settings' }, { value: 'org', label: 'Organization' }, { value: 'audit', label: 'Audit Logs' }]} />
            {tab === 'users' && <UsersTab />}
            {tab === 'roles' && <RolesTab />}
            {tab === 'settings' && <SettingsTab />}
            {tab === 'org' && <OrgTab />}
            {tab === 'audit' && <AuditTab />}
        </>
    );
}

function UsersTab() {
    const [f, setF] = useState({ q: '', role: '', page: 1, limit: 10 });
    const { data, loading, error, reload } = useFetch('/admin/users', f);
    const [edit, setEdit] = useState(null);
    const [del, setDel] = useState(null);
    const remove = async () => { try { await api(`/admin/users/${del._id}`, { method: 'DELETE' }); toast.success('User deleted'); setDel(null); reload(); } catch (e) { toast.error(e.message); setDel(null); } };
    if (error) return <ErrorState message={error} onRetry={reload} />;
    return (
        <>
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
                <SearchBar className="flex-1" value={f.q} onChange={(q) => setF({ ...f, q, page: 1 })} placeholder="Search users…" />
                <select className="input sm:w-48" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })}><option value="">All roles</option><option>Administrator</option><option>Manager</option><option>Employee</option></select>
                <button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Add user</button>
            </div>
            <DataTable loading={loading} rows={data?.items || []} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF({ ...f, page: p })} columns={[
                { key: 'name', label: 'Name', render: (u) => <span className="font-medium">{u.name}</span> },
                { key: 'email', label: 'Email' },
                { key: 'role', label: 'Role', render: (u) => <Badge>{u.role}</Badge> },
                { key: 'active', label: 'Status', render: (u) => <Badge tone={u.active ? 'green' : 'gray'}>{u.active ? 'Active' : 'Disabled'}</Badge> },
                { key: 'lastLogin', label: 'Last Login', render: (u) => dateTime(u.lastLogin) },
                { key: 'a', label: '', render: (u) => <div className="flex gap-1 justify-end"><button className="btn-ghost btn-sm" onClick={() => setEdit(u)}><Pencil className="h-4 w-4" /></button><button className="btn-ghost btn-sm text-red-600" onClick={() => setDel(u)}><Trash2 className="h-4 w-4" /></button></div> },
            ]} />
            {edit && <UserForm u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
            <ConfirmModal open={!!del} danger title="Delete user" confirmLabel="Delete" message={`Delete login for ${del?.email}?`} onClose={() => setDel(null)} onConfirm={remove} />
        </>
    );
}

function UserForm({ u, onClose, onSaved }) {
    const isNew = !u._id;
    const meta = useMeta((s) => s.meta);
    const loadMeta = useMeta((s) => s.load);
    useEffect(() => { loadMeta(); }, [loadMeta]);
    const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ defaultValues: { role: 'Employee', active: true, employeeId: '', ...u, password: '' } });
    const save = async (v) => {
        const body = { name: v.name, email: v.email, role: v.role, active: v.active === true || v.active === 'true', employeeId: v.employeeId || null, ...(v.password && { password: v.password }) };
        try { await api(isNew ? '/admin/users' : `/admin/users/${u._id}`, { method: isNew ? 'POST' : 'PUT', body }); toast.success('User saved'); onSaved(); } catch (e) { toast.error(e.message); }
    };
    return (
        <Modal open title={isNew ? 'Add User' : `Edit ${u.name}`} onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button></>}>
            <div className="grid grid-cols-2 gap-4">
                <Field label="Full name *" error={errors.name} className="col-span-2"><input className="input" {...register('name', { required: true })} /></Field>
                <Field label="Email *" error={errors.email} className="col-span-2"><input className="input" type="email" disabled={!isNew} {...register('email', { required: true })} /></Field>
                <Field label="Role"><select className="input" {...register('role')}><option>Employee</option><option>Manager</option><option>Administrator</option></select></Field>
                <Field label="Status"><select className="input" {...register('active')}><option value="true">Active</option><option value="false">Disabled</option></select></Field>
                <Field label="Linked employee record" className="col-span-2"><select className="input" {...register('employeeId')}><option value="">None</option>{meta?.employees.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName} ({e.employeeId})</option>)}</select></Field>
                <Field label={isNew ? 'Password *' : 'Reset password (optional)'} error={errors.password} className="col-span-2"><input className="input" type="password" {...register('password', { required: isNew, minLength: { value: 6, message: 'Min 6 characters' } })} /></Field>
            </div>
        </Modal>
    );
}

const ALL_PERMS = [['dashboard', 'Workforce dashboard'], ['dashboard.self', 'Personal dashboard'], ['employees', 'Employee management'], ['locations', 'Location management'], ['scheduling', 'Scheduling'],
['schedule.self', 'Own schedule'], ['timeclock', 'Time clock'], ['attendance', 'Time & attendance'], ['timeoff.request', 'Request time off'], ['timeoff.approve', 'Approve time off'],
['budget', 'Labor budget'], ['forecast', 'Forecasting'], ['reports', 'Reports'], ['admin', 'Administration']];

function RolesTab() {
    const { data, loading, error, reload } = useFetch('/admin/settings');
    const [roles, setRoles] = useState(null);
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;
    const list = roles || data.roles?.roles || [];
    const toggle = (ri, p) => setRoles(list.map((r, i) => i !== ri ? r : { ...r, permissions: r.permissions.includes(p) ? r.permissions.filter((x) => x !== p) : [...r.permissions, p] }));
    const save = async () => { try { await api('/admin/settings/roles', { method: 'PUT', body: { roles: list } }); toast.success('Role permissions saved'); setRoles(null); reload(); } catch (e) { toast.error(e.message); } };
    return (
        <Card title="Role Permission Matrix" actions={<button className="btn-primary btn-sm" disabled={!roles} onClick={save}>Save changes</button>} bodyClass="overflow-x-auto">
            <table className="min-w-full">
                <thead><tr><th className="th">Permission</th>{list.map((r) => <th key={r.name} className="th text-center">{r.name}</th>)}</tr></thead>
                <tbody>{ALL_PERMS.map(([k, label]) => (
                    <tr key={k} className="border-t border-slate-100"><td className="td">{label}<span className="text-xs text-slate-400 ml-2">{k}</span></td>
                        {list.map((r, ri) => <td key={r.name} className="td text-center"><button onClick={() => r.name !== 'Administrator' && toggle(ri, k)}
                            className={`h-6 w-6 rounded border inline-flex items-center justify-center ${r.permissions.includes(k) ? 'bg-brand-600 border-brand-600 text-white' : 'border-slate-300'} ${r.name === 'Administrator' ? 'opacity-60 cursor-not-allowed' : ''}`}>
                            {r.permissions.includes(k) && <Check className="h-4 w-4" />}</button></td>)}</tr>))}
                </tbody>
            </table>
            <div className="grid sm:grid-cols-3 gap-3 mt-4">{list.map((r) => <div key={r.name} className="rounded-lg bg-slate-50 p-3 text-sm"><p className="font-semibold flex items-center gap-1"><ShieldCheck className="h-4 w-4 text-brand-600" />{r.name}</p><p className="text-slate-500 text-xs mt-1">{r.description}</p></div>)}</div>
        </Card>
    );
}

function SettingsTab() {
    const { data, loading, error, reload } = useFetch('/admin/settings');
    const [reset, setReset] = useState(false);
    const [busy, setBusy] = useState(false);
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;
    const reseed = async () => { setBusy(true); try { await api('/admin/reseed', { method: 'POST' }); toast.success('Demo data has been reset'); setReset(false); useMeta.getState().load(true); reload(); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
    return (
        <div className="grid lg:grid-cols-2 gap-4">
            <SettingsForm s={data.system} onSaved={reload} />
            <Card title="Demo Data">
                <p className="text-sm text-slate-600 mb-4">Reset the database to the original KP Retail Group demo data set (50 employees, 5 locations, current-week schedules, timecards, forecasts and budgets). All changes will be lost.</p>
                <button className="btn-danger" onClick={() => setReset(true)} disabled={busy}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <RotateCcw className="h-4 w-4" />}Reset demo data</button>
            </Card>
            <ConfirmModal open={reset} danger title="Reset demo data?" confirmLabel="Reset" message="This will delete all data and re-seed the demo company. Continue?" onClose={() => setReset(false)} onConfirm={reseed} />
        </div>
    );
}

function SettingsForm({ s, onSaved }) {
    const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: s });
    const save = async (v) => {
        const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof s[k] === 'number' ? Number(x) : typeof s[k] === 'boolean' ? !!x : x]));
        try { await api('/admin/settings/system', { method: 'PUT', body }); toast.success('System settings saved'); onSaved(); } catch (e) { toast.error(e.message); }
    };
    return (
        <Card title="System Settings" actions={<button className="btn-primary btn-sm" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button>}>
            <div className="grid grid-cols-2 gap-4">
                <Field label="Weekly overtime threshold (hrs)"><input type="number" className="input" {...register('overtimeThresholdWeekly')} /></Field>
                <Field label="Daily overtime threshold (hrs)"><input type="number" className="input" {...register('overtimeThresholdDaily')} /></Field>
                <Field label="Late grace period (min)"><input type="number" className="input" {...register('lateGraceMinutes')} /></Field>
                <Field label="Meal break required after (hrs)"><input type="number" className="input" {...register('mealBreakAfterHours')} /></Field>
                <Field label="Minimum meal (min)"><input type="number" className="input" {...register('minMealMinutes')} /></Field>
                <Field label="Publish lead time (days)"><input type="number" className="input" {...register('schedulePublishLeadDays')} /></Field>
                <Field label="Session length (hrs)"><input type="number" className="input" {...register('sessionHours')} /></Field>
                <label className="flex items-center gap-2 text-sm mt-6"><input type="checkbox" {...register('allowShiftPickup')} />Allow employees to pick up open shifts</label>
            </div>
        </Card>
    );
}

function OrgTab() {
    const { data, loading, error, reload } = useFetch('/admin/settings');
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;
    return <OrgForm o={data.organization} onSaved={() => { reload(); useMeta.getState().load(true); }} />;
}
function OrgForm({ o, onSaved }) {
    const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: { ...o, regions: o.regions.join('\n'), departments: o.departments.join('\n'), jobTitles: o.jobTitles.join('\n') } });
    const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const save = async (v) => { try { await api('/admin/settings/organization', { method: 'PUT', body: { ...v, regions: lines(v.regions), departments: lines(v.departments), jobTitles: lines(v.jobTitles) } }); toast.success('Organization saved'); onSaved(); } catch (e) { toast.error(e.message); } };
    return (
        <Card title="Organization Configuration" actions={<button className="btn-primary btn-sm" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button>}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <Field label="Company name"><input className="input" {...register('companyName')} /></Field>
                <Field label="Currency"><input className="input" {...register('currency')} /></Field>
                <Field label="Timezone"><input className="input" {...register('timezone')} /></Field>
                <Field label="Week starts on"><select className="input" {...register('weekStartDay')}><option>Monday</option><option>Sunday</option></select></Field>
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
                <Field label="Regions (one per line)"><textarea rows={6} className="input" {...register('regions')} /></Field>
                <Field label="Departments (one per line)"><textarea rows={6} className="input" {...register('departments')} /></Field>
                <Field label="Job roles (one per line)"><textarea rows={6} className="input" {...register('jobTitles')} /></Field>
            </div>
        </Card>
    );
}

function AuditTab() {
    const [f, setF] = useState({ q: '', action: '', page: 1, limit: 15 });
    const { data, loading, error, reload } = useFetch('/admin/audit', f);
    if (error) return <ErrorState message={error} onRetry={reload} />;
    const tone = { CREATE: 'green', DELETE: 'red', LOGIN: 'gray', PUBLISH: 'blue', APPROVE: 'green', REJECT: 'red', UPDATE: 'yellow' };
    return (
        <>
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
                <SearchBar className="flex-1" value={f.q} onChange={(q) => setF({ ...f, q, page: 1 })} placeholder="Search details or user…" />
                <select className="input sm:w-48" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })}><option value="">All actions</option>
                    {['LOGIN', 'CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'COPY', 'APPROVE', 'REJECT', 'PUNCH', 'EXPORT', 'GENERATE', 'SEED', 'RESET'].map((a) => <option key={a}>{a}</option>)}</select>
            </div>
            <DataTable loading={loading} rows={data?.items || []} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF({ ...f, page: p })} columns={[
                { key: 'timestamp', label: 'Timestamp', render: (l) => dateTime(l.timestamp) },
                { key: 'userName', label: 'User', render: (l) => <div><p className="font-medium">{l.userName}</p><p className="text-xs text-slate-500">{l.role}</p></div> },
                { key: 'action', label: 'Action', render: (l) => <Badge tone={tone[l.action] || 'blue'}>{l.action}</Badge> },
                { key: 'entity', label: 'Entity' },
                { key: 'details', label: 'Details', className: 'max-w-[420px] truncate' },
            ]} />
        </>
    );
}
