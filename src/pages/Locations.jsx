import { useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { Plus, MapPin, Pencil, Trash2, Users, Clock, Building2 } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../store/authStore';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, PageLoader, ErrorState, EmptyState, ConfirmModal, Spinner } from '../components/ui';
import { money, time12 } from '../lib/format';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Locations() {
    const user = useAuth((s) => s.user);
    const { data, loading, error, reload } = useFetch('/locations');
    const [q, setQ] = useState('');
    const [edit, setEdit] = useState(null);
    const [del, setDel] = useState(null);
    const reloadMeta = useMeta((s) => s.load);
    if (loading && !data) return <PageLoader />;
    if (error) return <ErrorState message={error} onRetry={reload} />;
    const rows = data.filter((l) => !q || `${l.name} ${l.city} ${l.region} ${l.costCenter}`.toLowerCase().includes(q.toLowerCase()));
    const remove = async () => { try { await api(`/locations/${del._id}`, { method: 'DELETE' }); toast.success('Location deleted'); setDel(null); reload(); reloadMeta(true); } catch (e) { toast.error(e.message); setDel(null); } };

    return (
        <>
            <PageHeader title="Locations" subtitle="Stores, operating hours, departments, cost centers and labor budgets"
                actions={<button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" />Add location</button>} />
            <SearchBar className="mb-4 max-w-md" value={q} onChange={setQ} placeholder="Search locations…" />
            {!rows.length ? <EmptyState icon={MapPin} title="No locations found" /> : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {rows.map((l) => (
                        <div key={l._id} className="card p-5 flex flex-col">
                            <div className="flex items-start justify-between">
                                <div><h3 className="font-semibold text-slate-900">{l.name}</h3><p className="text-xs text-slate-500">{l.address}, {l.city}</p></div>
                                <Badge>{l.status}</Badge>
                            </div>
                            <div className="grid grid-cols-2 gap-3 my-4 text-sm">
                                <div><p className="text-xs text-slate-500">Region</p><p className="font-medium">{l.region}</p></div>
                                <div><p className="text-xs text-slate-500">Cost center</p><p className="font-medium">{l.costCenter}</p></div>
                                <div><p className="text-xs text-slate-500 flex items-center gap-1"><Users className="h-3 w-3" />Active staff</p><p className="font-medium">{l.employeeCount}</p></div>
                                <div><p className="text-xs text-slate-500">Weekly labor budget</p><p className="font-medium">{money(l.weeklyLaborBudget)}</p></div>
                            </div>
                            <div className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3 mb-3">
                                <p className="font-semibold flex items-center gap-1 mb-1"><Clock className="h-3 w-3" />Operating hours</p>
                                <p>Mon–Sat: {time12(l.operatingHours?.mon?.open)} – {time12(l.operatingHours?.mon?.close)}</p>
                                <p>Sun: {l.operatingHours?.sun?.closed ? 'Closed' : `${time12(l.operatingHours?.sun?.open)} – ${time12(l.operatingHours?.sun?.close)}`}</p>
                            </div>
                            <div className="text-xs mb-4">
                                <p className="font-semibold text-slate-600 flex items-center gap-1 mb-1"><Building2 className="h-3 w-3" />Department hierarchy</p>
                                {(l.departments || []).filter((d) => !d.parent).map((p) => (
                                    <div key={p.name}><span className="font-medium">{p.name}</span>
                                        {(l.departments || []).filter((c) => c.parent === p.name).map((c) => <span key={c.name} className="text-slate-500"> › {c.name}</span>)}</div>
                                ))}
                            </div>
                            <div className="mt-auto flex gap-2">
                                <button className="btn-secondary btn-sm flex-1" onClick={() => setEdit(l)}><Pencil className="h-3.5 w-3.5" />Edit</button>
                                {user.role === 'Administrator' && <button className="btn-secondary btn-sm text-red-600" onClick={() => setDel(l)}><Trash2 className="h-3.5 w-3.5" /></button>}
                            </div>
                        </div>
                    ))}
                </div>)}
            {edit && <LocationForm loc={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); reloadMeta(true); }} />}
            <ConfirmModal open={!!del} danger title="Delete location" confirmLabel="Delete" message={`Delete ${del?.name}? Locations with active employees cannot be deleted.`} onClose={() => setDel(null)} onConfirm={remove} />
        </>
    );
}

function LocationForm({ loc, onClose, onSaved }) {
    const isNew = !loc._id;
    const defaults = {
        region: 'North Region', status: 'Active', weeklyLaborBudget: 9000,
        operatingHours: Object.fromEntries(DAYS.map((d) => [d, { open: '08:00', close: '20:00', closed: false }])),
        departments: [{ name: 'Retail Sales', parent: '' }], ...loc
    };
    defaults.departments = defaults.departments.map((d) => ({ ...d, parent: d.parent || '' }));
    const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm({ defaultValues: defaults });
    const { fields, append, remove } = useFieldArray({ control, name: 'departments' });
    const submit = async (v) => {
        const { _id, employeeCount, createdAt, ...body } = v;
        body.departments = body.departments.filter((d) => d.name).map((d) => ({ name: d.name, parent: d.parent || null }));
        try { await api(isNew ? '/locations' : `/locations/${loc._id}`, { method: isNew ? 'POST' : 'PUT', body }); toast.success('Location saved'); onSaved(); }
        catch (e) { toast.error(e.message); }
    };
    return (
        <Modal open title={isNew ? 'Add Location' : `Edit ${loc.name}`} onClose={onClose} size="max-w-3xl"
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Save</button></>}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Name *" error={errors.name} className="sm:col-span-2"><input className="input" {...register('name', { required: true })} /></Field>
                <Field label="Code"><input className="input" {...register('code')} /></Field>
                <Field label="Address"><input className="input" {...register('address')} /></Field>
                <Field label="City"><input className="input" {...register('city')} /></Field>
                <Field label="Phone"><input className="input" {...register('phone')} /></Field>
                <Field label="Region"><select className="input" {...register('region')}><option>North Region</option><option>South Region</option></select></Field>
                <Field label="Cost center *" error={errors.costCenter}><input className="input" {...register('costCenter', { required: true })} /></Field>
                <Field label="Weekly labor budget ($)"><input className="input" type="number" {...register('weeklyLaborBudget')} /></Field>
                <Field label="Status"><select className="input" {...register('status')}><option>Active</option><option>Inactive</option></select></Field>
            </div>
            <h4 className="font-semibold text-sm mt-6 mb-2">Operating hours</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {DAYS.map((d) => (
                    <div key={d} className="flex items-center gap-2 text-sm">
                        <span className="w-10 capitalize font-medium">{d}</span>
                        <input type="time" className="input" {...register(`operatingHours.${d}.open`)} />
                        <input type="time" className="input" {...register(`operatingHours.${d}.close`)} />
                        <label className="flex items-center gap-1 text-xs"><input type="checkbox" {...register(`operatingHours.${d}.closed`)} />Closed</label>
                    </div>))}
            </div>
            <h4 className="font-semibold text-sm mt-6 mb-2">Department hierarchy</h4>
            <div className="space-y-2">
                {fields.map((f, i) => (
                    <div key={f.id} className="flex gap-2">
                        <input className="input" placeholder="Department" {...register(`departments.${i}.name`)} />
                        <input className="input" placeholder="Parent (optional)" {...register(`departments.${i}.parent`)} />
                        <button type="button" className="btn-ghost" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></button>
                    </div>))}
                <button type="button" className="btn-secondary btn-sm" onClick={() => append({ name: '', parent: '' })}><Plus className="h-3.5 w-3.5" />Add department</button>
            </div>
        </Modal>
    );
}
