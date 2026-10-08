/** Small reusable UI primitives. */
import { Loader2, Inbox, AlertTriangle, X } from 'lucide-react';
import { useEffect } from 'react';

export function Spinner({ className = 'h-5 w-5' }) {
    return <Loader2 className={`animate-spin text-brand-600 ${className}`} />;
}

export function PageLoader({ label = 'Loading…' }) {
    return <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-3"><Spinner className="h-8 w-8" /><span className="text-sm">{label}</span></div>;
}

export function EmptyState({ title = 'Nothing here yet', message = '', icon: Icon = Inbox, action }) {
    return (
        <div className="flex flex-col items-center justify-center text-center py-14 px-6">
            <div className="h-12 w-12 rounded-full bg-brand-50 flex items-center justify-center mb-3"><Icon className="h-6 w-6 text-brand-500" /></div>
            <h3 className="font-semibold text-slate-700">{title}</h3>
            {message && <p className="text-sm text-slate-500 mt-1 max-w-sm">{message}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

export function ErrorState({ message, onRetry }) {
    return (
        <div className="card p-8 flex flex-col items-center text-center">
            <AlertTriangle className="h-8 w-8 text-red-500 mb-2" />
            <p className="font-semibold text-slate-700">Something went wrong</p>
            <p className="text-sm text-slate-500 mt-1">{message}</p>
            {onRetry && <button className="btn-secondary mt-4" onClick={onRetry}>Try again</button>}
        </div>
    );
}

export function PageHeader({ title, subtitle, actions }) {
    return (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
            <div>
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900">{title}</h1>
                {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
    );
}

const TONES = {
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', red: 'bg-red-50 text-red-700 ring-red-600/20',
    yellow: 'bg-amber-50 text-amber-700 ring-amber-600/20', blue: 'bg-brand-50 text-brand-700 ring-brand-600/20',
    gray: 'bg-slate-100 text-slate-600 ring-slate-500/20', purple: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};
const STATUS_TONE = {
    Active: 'green', Approved: 'green', Published: 'green', Inactive: 'gray', Terminated: 'red', Rejected: 'red', Pending: 'yellow',
    Draft: 'yellow', 'On Leave': 'purple', Cancelled: 'gray', Administrator: 'purple', Manager: 'blue', Employee: 'gray', 'Not Started': 'gray'
};
export function Badge({ children, tone }) {
    const t = TONES[tone || STATUS_TONE[children] || 'blue'];
    return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${t}`}>{children}</span>;
}

export function StatCard({ label, value, icon: Icon, hint, tone = 'blue' }) {
    const bg = { blue: 'bg-brand-50 text-brand-600', green: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600', violet: 'bg-violet-50 text-violet-600' }[tone];
    return (
        <div className="card p-4 sm:p-5 flex items-start gap-4">
            {Icon && <div className={`h-10 w-10 shrink-0 rounded-lg flex items-center justify-center ${bg}`}><Icon className="h-5 w-5" /></div>}
            <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{label}</p>
                <p className="text-2xl font-bold text-slate-900 mt-0.5">{value}</p>
                {hint && <p className="text-xs text-slate-500 mt-0.5 truncate">{hint}</p>}
            </div>
        </div>
    );
}

export function Card({ title, actions, children, className = '', bodyClass = 'p-4 sm:p-5' }) {
    return (
        <div className={`card ${className}`}>
            {(title || actions) && (
                <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3 border-b border-slate-100">
                    <h2 className="font-semibold text-slate-800">{title}</h2>{actions}
                </div>
            )}
            <div className={bodyClass}>{children}</div>
        </div>
    );
}

export function Modal({ open, title, onClose, children, footer, size = 'max-w-lg' }) {
    useEffect(() => {
        if (!open) return;
        const h = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [open, onClose]);
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
            <div className={`relative w-full ${size} bg-white rounded-t-2xl sm:rounded-xl shadow-xl max-h-[92vh] flex flex-col`}>
                <div className="flex items-center justify-between px-5 py-4 border-b">
                    <h3 className="font-semibold text-slate-900">{title}</h3>
                    <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
                </div>
                <div className="p-5 overflow-y-auto">{children}</div>
                {footer && <div className="px-5 py-3 border-t bg-slate-50 rounded-b-xl flex justify-end gap-2">{footer}</div>}
            </div>
        </div>
    );
}

export function Field({ label, error, children, className = '' }) {
    return (
        <div className={className}>
            {label && <label className="label">{label}</label>}
            {children}
            {error && <p className="text-xs text-red-600 mt-1">{error.message || 'Required'}</p>}
        </div>
    );
}

export function Tabs({ tabs, value, onChange }) {
    return (
        <div className="flex gap-1 border-b border-slate-200 mb-5 overflow-x-auto">
            {tabs.map((t) => (
                <button key={t.value} onClick={() => onChange(t.value)}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                    {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs">{t.count}</span>}
                </button>
            ))}
        </div>
    );
}

export function ConfirmModal({ open, title, message, onConfirm, onClose, confirmLabel = 'Confirm', danger }) {
    return (
        <Modal open={open} title={title} onClose={onClose}
            footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>{confirmLabel}</button></>}>
            <p className="text-sm text-slate-600">{message}</p>
        </Modal>
    );
}
