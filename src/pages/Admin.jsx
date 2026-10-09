/** Administration: users, roles & permissions, system settings (incl. WFM scheduling rules), organization, audit logs. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Plus, Pencil, Trash2, RotateCcw, ShieldCheck, Check, BookOpen } from 'lucide-react';
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
            <PageHeader title="Administration" subtitle="Users, roles, system settings, organization and audit trail"
                actions={<Link to="/admin/api-docs" className="btn-secondary"><BookOpen className="h-4 w-4" />API Documentation</Link>} />
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
            <SettingsForm s={data.system} onSaved={() => { reload(); useMeta.getState().load(true); }} />
            <div className="space-y-4">
                <Card title="Demo Data">
                    <p className="text-sm text-slate-600 mb-4">Reset the database to the original KP Retail Group demo data set (50 employees, 5 locations, current-week schedules, timecards, forecasts and budgets). All changes will be lost.</p>
                    <button className="btn-danger" onClick={() => setReset(true)} disabled={busy}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <RotateCcw className="h-4 w-4" />}Reset demo data</button>
                </Card>
                <Card title="How scheduling rules are applied">
                    <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
                        <li>Rules run on every shift create, edit, open-shift assignment, employee pickup and inbound API import.</li>
                        <li>Hard rules block the change (HTTP 422) and list every violation.</li>
                        <li>Labor budget and overtime are warnings – the change is saved and the user is alerted.</li>
                        <li>Existing seeded shifts are not modified; rules apply to new changes.</li>
                    </ul>
                </Card>
            </div>
            <ConfirmModal open={reset} danger title="Reset demo data?" confirmLabel="Reset" message="This will delete all data and re-seed the demo company. Continue?" onClose={() => setReset(false)} onConfirm={reseed} />
        </div>
    );
}

const NUM_FIELDS = [
    ['overtimeThresholdWeekly', 'Weekly overtime threshold (hrs)'], ['overtimeThresholdDaily', 'Daily overtime threshold (hrs)'],
    ['maxDailyHours', 'Max scheduled hours / day'], ['maxWeeklyHours', 'Max scheduled hours / week'],
    ['minRestHours', 'Minimum rest between shifts (hrs)'], ['maxShiftHours', 'Max single shift length (hrs)'],
    ['budgetWarningPct', 'Labor budget warning at (%)'], ['lateGraceMinutes', 'Late grace period (min)'],
    ['mealBreakAfterHours', 'Meal break required after (hrs)'], ['minMealMinutes', 'Minimum meal (min)'],
    ['schedulePublishLeadDays', 'Publish lead time (days)'], ['sessionHours', 'Session length (hrs)'],
];
const BOOL_FIELDS = [
    ['enforceAvailability', 'Block assignments on unavailable days / approved time off'], ['enforceDepartmentMatch', 'Employee department must match shift department'],
    ['enforceSkills', 'Employee must have the shift\'s required skills'], ['requireEditModeForPublished', 'Published schedules require Edit Mode'],
    ['preventDuplicateOpenShifts', 'Prevent duplicate open shifts'], ['allowShiftPickup', 'Allow employees to pick up open shifts'],
    ['logReadRequests', 'Log read-only (GET) API requests in the audit log'],
];

function SettingsForm({ s, onSaved }) {
    const { register, handleSubmit, formState: { isSubmitting } } = useForm({ defaultValues: s });
    const save = async (v) => {
        const body = Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_id').map(([k, x]) => [k, typeof s[k] === 'number' ? Number(x) : typeof s[k] === 'boolean' ? !!x : x]));
        try { await api('/admin/settings/system', { method: 'PUT', body }); toast.success('System settings saved'); onSaved(); } catch (e) { toast.error(e.message); }
    };
    return (
        <Card title="System Settings & WFM Rules" actions={<button className="btn-primary btn-sm" disabled={isSubmitting} onClick={handleSubmit(save)}>Save</button>}>
            <div className="grid grid-cols-2 gap-4">
                {NUM_FIELDS.map(([k, label]) => <Field key={k} label={label}><input type="number" min={0} className="input" {...register(k)} /></Field>)}
                <div className="col-span-2 space-y-2 pt-2 border-t">
                    {BOOL_FIELDS.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" {...register(k)} />{label}</label>)}
                </div>
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

const ACTIONS = ['LOGIN', 'CREATE', 'UPDATE', 'DELETE', 'ASSIGN', 'UNASSIGN', 'RELEASE', 'EDIT_MODE', 'PUBLISH', 'COPY', 'APPROVE', 'REJECT', 'PUNCH', 'EXPORT', 'GENERATE',
    'INBOUND', 'INBOUND_PARTIAL', 'API_REQUEST', 'API_FAILURE', 'SEED', 'RESET'];
function AuditTab() {
    const [f, setF] = useState({ q: '', action: '', entity: '', page: 1, limit: 15 });
    const { data, loading, error, reload } = useFetch('/admin/audit', f);
    if (error) return <ErrorState message={error} onRetry={reload} />;
    const tone = {
        CREATE: 'green', DELETE: 'red', LOGIN: 'gray', PUBLISH: 'blue', APPROVE: 'green', REJECT: 'red', UPDATE: 'yellow', ASSIGN: 'green', UNASSIGN: 'yellow',
        API_FAILURE: 'red', API_REQUEST: 'gray', EDIT_MODE: 'purple', RELEASE: 'yellow', INBOUND: 'blue', INBOUND_PARTIAL: 'yellow'
    };
    return (
        <>
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
                <SearchBar className="flex-1" value={f.q} onChange={(q) => setF({ ...f, q, page: 1 })} placeholder="Search details or user…" />
                <select className="input sm:w-48" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })}><option value="">All actions</option>
                    {ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
                <select className="input sm:w-48" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value, page: 1 })}><option value="">All entities</option>
                    {['Shift', 'Open Shift', 'Schedule', 'Employee', 'Location', 'Time Off', 'Timecard', 'Labor Budget', 'Settings', 'Integration', 'API', 'Auth', 'User'].map((a) => <option key={a}>{a}</option>)}</select>
            </div>
            <DataTable loading={loading} rows={data?.items || []} page={f.page} pages={data?.pages || 1} total={data?.total || 0} onPage={(p) => setF({ ...f, page: p })} columns={[
                { key: 'timestamp', label: 'Timestamp', render: (l) => dateTime(l.timestamp) },
                { key: 'userName', label: 'User', render: (l) => <div><p className="font-medium">{l.userName}</p><p className="text-xs text-slate-500">{l.role}</p></div> },
                { key: 'action', label: 'Action', render: (l) => <Badge tone={tone[l.action] || 'blue'}>{l.action}</Badge> },
                { key: 'entity', label: 'Entity' },
                { key: 'details', label: 'Details', className: 'max-w-[520px] whitespace-normal text-xs', render: (l) => l.details },
            ]} />
        </>
    );
}
