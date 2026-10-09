/**
 * Scheduling workspace: weekly grid (drag & drop) and daily timeline.
 * - Drag a shift chip to another employee on the SAME day to reassign (or onto "Open Shifts" to unassign).
 *   Shifts never move between days: an open shift belongs to its date (Monday shift → Monday only).
 * - Click an empty cell to create a shift, click a chip to edit
 * - Published schedules are read-only until Edit Mode is enabled
 * - Every create/edit/assign is validated server-side (rules engine); warnings (budget, overtime) show as toasts
 */
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { useForm } from 'react-hook-form';
import { ChevronLeft, ChevronRight, Send, Copy, Plus, CalendarDays, AlertTriangle, Trash2, Lock, Unlock, ShieldCheck } from 'lucide-react';
import { useFetch } from '../hooks/useFetch';
import { useMeta } from '../store/metaStore';
import { api } from '../lib/api';
import { toast } from '../store/toastStore';
import SearchBar from '../components/SearchBar';
import { PageHeader, Badge, Modal, Field, PageLoader, ErrorState, ConfirmModal, Spinner, EmptyState } from '../components/ui';
import { weekStart, ymd, time12, money, num } from '../lib/format';

const TEMPLATES = { Morning: ['08:00', '16:00'], Mid: ['10:00', '18:00'], Evening: ['12:00', '20:00'] };
const chipColor = (s) => !s.employeeId ? 'bg-amber-50 border-amber-300 text-amber-800' : s.overtime ? 'bg-red-50 border-red-300 text-red-800'
    : s.start < '10:00' ? 'bg-brand-50 border-brand-300 text-brand-800' : s.start < '12:00' ? 'bg-sky-50 border-sky-300 text-sky-800' : 'bg-indigo-50 border-indigo-300 text-indigo-800';
const dayIndex = (date) => (dayjs(date).day() + 6) % 7;
const isAvailable = (emp, date) => emp?.availability?.[dayIndex(date)]?.available !== false;
const isActive = (e) => e.status === 'Active' && !['Terminated', 'On Leave'].includes(e.employmentStatus);

export default function Scheduling() {
    const { meta, load } = useMeta();
    const [ws, setWs] = useState(weekStart());
    const [locationId, setLocationId] = useState('');
    const [department, setDepartment] = useState('');
    const [q, setQ] = useState('');
    const [view, setView] = useState('week');
    const [dayIdx, setDayIdx] = useState(dayIndex(dayjs()));
    const [modal, setModal] = useState(null);
    const [copyOpen, setCopyOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(null);
    useEffect(() => { load().then((m) => m && !locationId && setLocationId(m.locations[0]?._id)); }, [load]); // eslint-disable-line

    const wsStr = ymd(ws);
    const { data: shifts, loading, error, reload } = useFetch('/shifts', { weekStart: wsStr, locationId, department }, { skip: !locationId });
    const { data: schedules, reload: reloadSched } = useFetch('/schedules', { weekStart: wsStr });
    const sched = schedules?.find((s) => s.locationId === locationId);
    const locked = !!sched?.locked;
    const days = Array.from({ length: 7 }, (_, i) => ws.add(i, 'day'));

    const employees = useMemo(() => (meta?.employees || []).filter((e) => e.locationId === locationId && isActive(e)
        && (!department || e.department === department) && (!q || `${e.firstName} ${e.lastName}`.toLowerCase().includes(q.toLowerCase()))), [meta, locationId, department, q]);
    const byCell = useMemo(() => { const m = {}; (shifts || []).forEach((s) => { const k = `${s.employeeId || 'open'}|${s.date}`; (m[k] ||= []).push(s); }); return m; }, [shifts]);
    const assigned = (shifts || []).filter((s) => s.employeeId);
    const totals = { hours: assigned.reduce((a, s) => a + s.hours, 0), cost: assigned.reduce((a, s) => a + s.cost, 0), open: (shifts || []).filter((s) => !s.employeeId).length, draft: (shifts || []).filter((s) => !s.published).length };
    const refresh = () => { reload(); reloadSched(); };
    const blockedByLock = () => { if (locked) { toast.error('This schedule is published. Click "Enable Edit Mode" before making changes.'); return true; } return false; };

    /** Drag & drop handler – enforces "same date" before calling the API. */
    const move = async (shiftId, employeeId, date) => {
        const s = shifts.find((x) => x._id === shiftId);
        if (!s || (s.employeeId === employeeId && s.date === date)) return;
        if (blockedByLock()) return;
        if (s.date !== date) {
            toast.error(`Shifts keep their original date. This ${dayjs(s.date).format('dddd')} shift can only be assigned on ${dayjs(s.date).format('dddd')} (${dayjs(s.date).format('MMM D')}).`);
            return;
        }
        try {
            const r = !s.employeeId && employeeId
                ? await api(`/shifts/${shiftId}/assign`, { method: 'POST', body: { employeeId, date } })
                : await api(`/shifts/${shiftId}`, { method: 'PUT', body: { employeeId } });
            toast.success(!s.employeeId ? 'Open shift assigned' : employeeId ? 'Shift reassigned' : 'Shift moved to open shifts');
            toast.warnings(r.warnings);
            refresh();
        } catch (e) { toast.error(e.message); }
    };
    const publish = async () => {
        setBusy(true);
        try { const r = await api('/schedules/publish', { method: 'POST', body: { locationId, weekStart: wsStr } }); toast.success(`Schedule published (${r.published} shifts, ${r.changed} changed). Employees can now see it.`); refresh(); }
        catch (e) { toast.error(e.message); } finally { setBusy(false); }
    };
    const toggleEditMode = async (enabled) => {
        setBusy(true);
        try { await api('/schedules/edit-mode', { method: 'POST', body: { locationId, weekStart: wsStr, enabled } }); toast.info(enabled ? 'Edit Mode enabled – changes stay in draft until you re-publish.' : 'Edit Mode closed.'); refresh(); }
        catch (e) { toast.error(e.message); } finally { setBusy(false); }
    };
    const copyPrev = async (replace) => {
        setBusy(true);
        try {
            const r = await api('/schedules/copy', { method: 'POST', body: { locationId, fromWeek: ymd(ws.subtract(7, 'day')), toWeek: wsStr, replace } });
            toast.success(`Copied ${r.copied} shifts from previous week`);
            if (r.convertedToOpen) toast.warning(`${r.convertedToOpen} copied shift(s) became open shifts because the employee is inactive, unavailable, on approved leave or changed department.`);
            setCopyOpen(false); refresh();
        } catch (e) { toast.error(e.message); } finally { setBusy(false); }
    };

    if (!meta) return <PageLoader />;
    const loc = meta.locations.find((l) => l._id === locationId);

    // Rendered as a plain function (not a component) so drag state updates don't remount the dragged chip
    const renderCell = (emp, d) => {
        const date = ymd(d), key = `${emp?._id || 'open'}|${date}`, list = byCell[key] || [];
        const unavailable = emp && !isAvailable(emp, date);
        return (
            <td key={key} onDragOver={(e) => { e.preventDefault(); setDragOver(key); }} onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.preventDefault(); setDragOver(null); move(e.dataTransfer.getData('text/plain'), emp?._id || null, date); }}
                onClick={() => { if (blockedByLock()) return; setModal({ employeeId: emp?._id || '', date, locationId, department: emp?.department || department || 'Retail Sales', jobTitle: emp?.jobTitle || 'Sales Associate' }); }}
                className={`border border-slate-100 p-1 align-top h-16 min-w-[120px] cursor-pointer transition ${dragOver === key ? 'bg-brand-100' : unavailable ? 'bg-[repeating-linear-gradient(45deg,#f8fafc,#f8fafc_6px,#f1f5f9_6px,#f1f5f9_12px)]' : 'hover:bg-brand-50/50'}`}>
                {unavailable && !list.length && <span className="text-[10px] text-slate-400">Unavailable</span>}
                {list.map((s) => (
                    <div key={s._id} draggable={!locked} onDragStart={(e) => e.dataTransfer.setData('text/plain', s._id)} onClick={(e) => { e.stopPropagation(); setModal(s); }}
                        className={`mb-1 rounded-md border px-2 py-1 text-[11px] leading-tight ${locked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} ${chipColor(s)} ${!s.published ? 'border-dashed' : ''}`}>
                        <p className="font-semibold">{time12(s.start)}–{time12(s.end)}</p>
                        <p className="truncate opacity-80">{s.employeeId ? s.jobTitle : `${s.jobTitle}${s.posted ? ' · posted' : ''}`}</p>
                        {s.requiredSkills?.length > 0 && <p className="truncate opacity-60">⚑ {s.requiredSkills.join(', ')}</p>}
                    </div>))}
            </td>);
    };

    return (
        <>
            <PageHeader title="Scheduling" subtitle={loc ? `${loc.name} · ${loc.region}` : ''}
                actions={<>
                    {sched?.status === 'Published' && (sched.editMode
                        ? <button className="btn-secondary" onClick={() => toggleEditMode(false)} disabled={busy}><Lock className="h-4 w-4" />Exit Edit Mode</button>
                        : <button className="btn-secondary" onClick={() => toggleEditMode(true)} disabled={busy}><Unlock className="h-4 w-4" />Enable Edit Mode</button>)}
                    <button className="btn-secondary" onClick={() => !blockedByLock() && setCopyOpen(true)} disabled={busy}><Copy className="h-4 w-4" />Copy previous week</button>
                    <button className="btn-secondary" onClick={() => !blockedByLock() && setModal({ locationId, date: ymd(days[view === 'day' ? dayIdx : 0]), employeeId: '', department: department || 'Retail Sales', jobTitle: 'Sales Associate' })}><Plus className="h-4 w-4" />Add shift</button>
                    <button className="btn-primary" onClick={publish} disabled={busy || !shifts?.length}>{busy ? <Spinner className="h-4 w-4 text-white" /> : <Send className="h-4 w-4" />}Publish</button>
                </>} />

            <div className="card p-3 mb-4 flex flex-col xl:flex-row gap-3 xl:items-center">
                <div className="flex items-center gap-2">
                    <button className="btn-secondary px-2" onClick={() => setWs(ws.subtract(7, 'day'))}><ChevronLeft className="h-4 w-4" /></button>
                    <div className="text-sm font-semibold min-w-[170px] text-center">{ws.format('MMM D')} – {ws.add(6, 'day').format('MMM D, YYYY')}</div>
                    <button className="btn-secondary px-2" onClick={() => setWs(ws.add(7, 'day'))}><ChevronRight className="h-4 w-4" /></button>
                    <button className="btn-ghost btn-sm" onClick={() => setWs(weekStart())}>This week</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 flex-1">
                    <select className="input" value={locationId} onChange={(e) => setLocationId(e.target.value)}>{meta.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select>
                    <select className="input" value={department} onChange={(e) => setDepartment(e.target.value)}><option value="">All departments</option>{meta.departments.map((d) => <option key={d}>{d}</option>)}</select>
                    <SearchBar value={q} onChange={setQ} placeholder="Filter employees…" />
                </div>
                <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm shrink-0">
                    {['week', 'day'].map((v) => <button key={v} onClick={() => setView(v)} className={`px-4 py-2 capitalize ${view === v ? 'bg-brand-600 text-white' : 'bg-white text-slate-600'}`}>{v}</button>)}
                </div>
            </div>

            {locked && (
                <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm text-brand-800 flex items-center gap-2">
                    <Lock className="h-4 w-4" />This schedule is published and read-only. Enable Edit Mode to change shifts; all changes are tracked in the audit log.
                </div>)}
            {sched?.editMode && (
                <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
                    <Unlock className="h-4 w-4" />Edit Mode is on. Changes are saved as draft and become visible to employees when you re-publish.
                </div>)}
            {sched?.overBudget && (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />Labor budget warning: scheduled cost {money(sched.cost)} is {sched.budgetUtilization}% of the weekly budget {money(sched.budgetAmount)}.
                </div>)}

            <div className="flex flex-wrap gap-3 mb-4 text-sm items-center">
                <Badge>{sched?.status || 'Not Started'}</Badge>
                {sched?.editMode && <Badge tone="yellow">Edit mode</Badge>}
                {totals.draft > 0 && sched?.status === 'Published' && <Badge tone="yellow">{totals.draft} unpublished changes</Badge>}
                <span className="text-slate-600">Scheduled: <b>{num(totals.hours)} hrs</b></span>
                <span className="text-slate-600">Labor cost: <b>{money(totals.cost)}</b>{sched?.budgetAmount ? <> / {money(sched.budgetAmount)} (<b className={sched.overBudget ? 'text-red-600' : ''}>{sched.budgetUtilization}%</b>)</> : null}</span>
                <span className="text-slate-600">Open shifts: <b>{totals.open}</b></span>
                <span className="text-slate-400 hidden md:inline">· Drag shifts between employees on the same day · dashed = draft · red = overtime</span>
            </div>

            {error ? <ErrorState message={error} onRetry={reload} /> : loading && !shifts ? <PageLoader /> : view === 'week' ? (
                <div className="card overflow-x-auto relative">
                    {loading && <div className="absolute inset-0 bg-white/50 z-10 flex items-center justify-center"><Spinner className="h-7 w-7" /></div>}
                    <table className="w-full border-collapse">
                        <thead><tr>
                            <th className="th sticky left-0 z-[1] min-w-[190px]">Employee</th>
                            {days.map((d) => <th key={ymd(d)} className={`th text-center ${ymd(d) === ymd(dayjs()) ? 'text-brand-700 bg-brand-50' : ''}`}>{d.format('ddd')}<br /><span className="font-normal normal-case">{d.format('MMM D')}</span></th>)}
                        </tr></thead>
                        <tbody>
                            <tr className="bg-amber-50/40">
                                <td className="td sticky left-0 bg-amber-50 font-semibold text-amber-800 z-[1]">Open Shifts</td>
                                {days.map((d) => renderCell(null, d))}
                            </tr>
                            {employees.map((e) => {
                                const hrs = assigned.filter((s) => s.employeeId === e._id).reduce((a, s) => a + s.hours, 0);
                                const max = meta.rules?.maxWeeklyHours ?? 48, ot = meta.rules?.overtimeThresholdWeekly ?? 40;
                                return (
                                    <tr key={e._id}>
                                        <td className="td sticky left-0 bg-white z-[1] border-r border-slate-100">
                                            <p className="font-medium text-slate-900">{e.firstName} {e.lastName}</p>
                                            <p className="text-xs text-slate-500 flex items-center gap-1">{e.jobTitle} · {e.department} · {e.employmentType}</p>
                                            <p className={`text-xs font-semibold ${hrs > max ? 'text-red-700' : hrs > ot ? 'text-red-600' : 'text-slate-600'}`}>{hrs} / {max} hrs{hrs > ot && <span className="inline-flex items-center gap-0.5 ml-1"><AlertTriangle className="h-3 w-3" />OT</span>}</p>
                                        </td>
                                        {days.map((d) => renderCell(e, d))}
                                    </tr>);
                            })}
                        </tbody>
                    </table>
                    {!employees.length && <EmptyState icon={CalendarDays} title="No employees match the filters" />}
                </div>
            ) : (
                <DayView days={days} dayIdx={dayIdx} setDayIdx={setDayIdx} employees={employees} shifts={shifts || []} onEdit={setModal} />
            )}

            {modal && <ShiftModal shift={modal} meta={meta} locked={locked} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh(); }} />}
            <Modal open={copyOpen} title="Copy previous week" onClose={() => setCopyOpen(false)}
                footer={<><button className="btn-secondary" onClick={() => setCopyOpen(false)}>Cancel</button>
                    <button className="btn-secondary" disabled={busy} onClick={() => copyPrev(true)}>Replace existing</button>
                    <button className="btn-primary" disabled={busy} onClick={() => copyPrev(false)}>Copy</button></>}>
                <p className="text-sm text-slate-600">Copy all shifts for <b>{loc?.name}</b> from the week of <b>{ws.subtract(7, 'day').format('MMM D')}</b> into the week of <b>{ws.format('MMM D')}</b>. Each shift keeps its weekday, department and job role. Copied shifts are created as draft until you publish; assignments that break rules (inactive, unavailable, approved leave) become open shifts.</p>
            </Modal>
        </>
    );
}

function DayView({ days, dayIdx, setDayIdx, employees, shifts, onEdit }) {
    const date = ymd(days[dayIdx]);
    const START = 6, END = 22, span = END - START;
    const pos = (t) => { const [h, m] = t.split(':').map(Number); return ((h + m / 60 - START) / span) * 100; };
    const list = shifts.filter((s) => s.date === date);
    const rows = [{ _id: null, label: 'Open Shifts' }, ...employees.map((e) => ({ _id: e._id, label: `${e.firstName} ${e.lastName}`, sub: e.jobTitle }))]
        .map((r) => ({ ...r, shifts: list.filter((s) => (s.employeeId || null) === r._id) })).filter((r) => r._id === null || r.shifts.length);
    return (
        <div className="card p-4">
            <div className="flex gap-1 mb-4 overflow-x-auto">
                {days.map((d, i) => <button key={i} onClick={() => setDayIdx(i)} className={`btn-sm btn ${i === dayIdx ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{d.format('ddd D')}</button>)}
            </div>
            <div className="overflow-x-auto">
                <div className="min-w-[760px]">
                    <div className="flex ml-48 text-[11px] text-slate-400 mb-1">{Array.from({ length: span / 2 + 1 }, (_, i) => <div key={i} style={{ width: `${100 / (span / 2)}%` }} className="-ml-2">{dayjs().hour(START + i * 2).format('ha')}</div>)}</div>
                    {rows.map((r) => (
                        <div key={r._id || 'open'} className="flex items-center border-t border-slate-100 h-12">
                            <div className="w-48 shrink-0 pr-2"><p className={`text-sm font-medium truncate ${!r._id ? 'text-amber-700' : ''}`}>{r.label}</p>{r.sub && <p className="text-[11px] text-slate-500">{r.sub}</p>}</div>
                            <div className="relative flex-1 h-8 bg-slate-50 rounded">
                                {r.shifts.map((s) => (
                                    <button key={s._id} onClick={() => onEdit(s)} style={{ left: `${pos(s.start)}%`, width: `${pos(s.end) - pos(s.start)}%` }}
                                        className={`absolute top-0 h-8 rounded border text-[11px] font-semibold px-2 truncate ${chipColor(s)}`}>{time12(s.start)}–{time12(s.end)} {r._id ? '' : `· ${s.jobTitle}`}</button>))}
                            </div>
                        </div>))}
                    {rows.length <= 1 && !rows[0]?.shifts.length && <EmptyState title="No shifts on this day" />}
                </div>
            </div>
        </div>
    );
}

/**
 * Create / edit shift. For existing shifts the date, location, department and job role are locked
 * (schedule integrity) and only times, employee, required skills and notes can change.
 */
function ShiftModal({ shift, meta, locked, onClose, onSaved }) {
    const isNew = !shift._id;
    const [confirmDel, setConfirmDel] = useState(false);
    const [ruleErrors, setRuleErrors] = useState([]);
    const { register, handleSubmit, setValue, watch, formState: { isSubmitting, errors } } = useForm({
        defaultValues: { start: '08:00', end: '16:00', posted: true, notes: '', ...shift, employeeId: shift.employeeId || '', skillsText: (shift.requiredSkills || []).join(', ') }
    });
    const v = { locationId: watch('locationId') || shift.locationId, department: watch('department') || shift.department, date: watch('date') || shift.date, skillsText: watch('skillsText') || '' };
    const required = v.skillsText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    // Employee list: only active employees of the shift's location and department (business rule)
    const emps = meta.employees.filter((e) => e.locationId === v.locationId && isActive(e) && (!meta.rules?.enforceDepartmentMatch || e.department === v.department));
    const hint = (e) => {
        const flags = [];
        if (v.date && !isAvailable(e, v.date)) flags.push('unavailable');
        const missing = required.filter((r) => !(e.effectiveSkills || []).map((x) => x.toLowerCase()).includes(r));
        if (missing.length) flags.push(`missing ${missing.join('/')}`);
        return flags.length ? ` (${flags.join(', ')})` : '';
    };
    const submit = async (f) => {
        setRuleErrors([]);
        const requiredSkills = f.skillsText.split(',').map((s) => s.trim()).filter(Boolean);
        const body = isNew
            ? { locationId: f.locationId, date: f.date, start: f.start, end: f.end, employeeId: f.employeeId || null, department: f.department, jobTitle: f.jobTitle, notes: f.notes, posted: !!f.posted, requiredSkills }
            : { start: f.start, end: f.end, employeeId: f.employeeId || null, notes: f.notes, posted: !!f.posted, requiredSkills };
        try {
            let r;
            if (!isNew && !shift.employeeId && f.employeeId && f.start === shift.start && f.end === shift.end) {
                r = await api(`/shifts/${shift._id}/assign`, { method: 'POST', body: { employeeId: f.employeeId } });   // open-shift assignment
                if (f.notes !== shift.notes || requiredSkills.join() !== (shift.requiredSkills || []).join()) r = await api(`/shifts/${shift._id}`, { method: 'PUT', body: { notes: f.notes, requiredSkills } });
            } else r = await api(isNew ? '/shifts' : `/shifts/${shift._id}`, { method: isNew ? 'POST' : 'PUT', body });
            toast.success(isNew ? 'Shift created' : 'Shift updated');
            toast.warnings(r.warnings);
            onSaved();
        } catch (e) { setRuleErrors(e.details?.length ? e.details : [e.message]); }
    };
    const remove = async () => { try { await api(`/shifts/${shift._id}`, { method: 'DELETE' }); toast.success('Shift deleted'); onSaved(); } catch (e) { toast.error(e.message); setConfirmDel(false); } };
    const lockCls = !isNew ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : '';
    return (
        <Modal open title={locked ? 'Shift (read-only – published)' : isNew ? 'New Shift' : 'Edit Shift'} onClose={onClose}
            footer={<>{!isNew && !locked && <button className="btn-ghost text-red-600 mr-auto" onClick={() => setConfirmDel(true)}><Trash2 className="h-4 w-4" />Delete</button>}
                <button className="btn-secondary" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
                {!locked && <button className="btn-primary" disabled={isSubmitting} onClick={handleSubmit(submit)}>{isSubmitting && <Spinner className="h-4 w-4 text-white" />}Save</button>}</>}>
            {locked && <p className="mb-4 rounded-lg bg-brand-50 border border-brand-200 p-3 text-sm text-brand-800 flex gap-2"><Lock className="h-4 w-4 mt-0.5" />Enable Edit Mode on the schedule to change this shift.</p>}
            {ruleErrors.length > 0 && (
                <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                    <p className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle className="h-4 w-4" />WFM rule violation</p>
                    <ul className="list-disc pl-5 space-y-0.5">{ruleErrors.map((m) => <li key={m}>{m}</li>)}</ul>
                </div>)}
            <fieldset disabled={locked} className="grid grid-cols-2 gap-4">
                <Field label="Location" className="col-span-2"><select className={`input ${lockCls}`} disabled={!isNew} {...register('locationId', { required: true })}>{meta.locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}</select></Field>
                <Field label="Date *" error={errors.date} className="col-span-2"><input type="date" className={`input ${lockCls}`} disabled={!isNew} {...register('date', { required: true })} /></Field>
                <Field label="Department"><select className={`input ${lockCls}`} disabled={!isNew} {...register('department')}>{meta.departments.map((d) => <option key={d}>{d}</option>)}</select></Field>
                <Field label="Job role"><select className={`input ${lockCls}`} disabled={!isNew} {...register('jobTitle')}>{meta.jobTitles.map((d) => <option key={d}>{d}</option>)}</select></Field>
                {!isNew && <p className="col-span-2 -mt-2 text-xs text-slate-500 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Date ({dayjs(shift.date).format('dddd')}), location, department and job role are locked to preserve schedule integrity.</p>}
                <Field label={`Employee (active, same location${meta.rules?.enforceDepartmentMatch ? ' & department' : ''})`} className="col-span-2">
                    <select className="input" {...register('employeeId')}>
                        <option value="">— Open shift (unassigned) —</option>
                        {emps.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName} · {e.jobTitle}{hint(e)}</option>)}
                    </select>
                </Field>
                <div className="col-span-2 flex gap-2">{Object.entries(TEMPLATES).map(([k, [s, e]]) => <button type="button" key={k} className="btn-secondary btn-sm flex-1" onClick={() => { setValue('start', s); setValue('end', e); }}>{k} {time12(s)}–{time12(e)}</button>)}</div>
                <Field label="Start"><input type="time" className="input" {...register('start', { required: true })} /></Field>
                <Field label="End"><input type="time" className="input" {...register('end', { required: true })} /></Field>
                <Field label="Required skills (comma separated, optional)" className="col-span-2">
                    <input className="input" list="kp-shift-skills" placeholder="e.g. Key Holder" {...register('skillsText')} />
                    <datalist id="kp-shift-skills">{meta.skills?.map((s) => <option key={s} value={s} />)}</datalist>
                </Field>
                <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" {...register('posted')} />Post open shift so employees can pick it up</label>
                <Field label="Notes" className="col-span-2"><input className="input" {...register('notes')} /></Field>
                <p className="col-span-2 text-xs text-slate-400">Rules checked on save: availability & approved leave, overlap/duplicates, max {meta.rules?.maxDailyHours}h/day, {meta.rules?.maxWeeklyHours}h/week, {meta.rules?.minRestHours}h rest between shifts, required skills, labor budget (warning).</p>
            </fieldset>
            <ConfirmModal open={confirmDel} danger title="Delete shift" message="This shift will be permanently removed." confirmLabel="Delete" onClose={() => setConfirmDel(false)} onConfirm={remove} />
        </Modal>
    );
}
