/**
 * Reusable data grid with loading, empty state and pagination.
 * Server mode: pass `page`, `pages`, `total`, `onPage`. Client mode: omit them and rows are paginated locally.
 * columns: [{ key, label, render?(row), className? }]
 */
import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Spinner, EmptyState } from './ui';

export default function DataTable({ columns, rows = [], loading, page, pages, total, onPage, pageSize = 10, empty, onRowClick, rowKey = '_id' }) {
    const server = onPage !== undefined;
    const [localPage, setLocalPage] = useState(1);
    useEffect(() => setLocalPage(1), [rows.length]);
    const cur = server ? page : localPage;
    const totalPages = server ? pages : Math.max(1, Math.ceil(rows.length / pageSize));
    const count = server ? total : rows.length;
    const visible = server ? rows : rows.slice((localPage - 1) * pageSize, localPage * pageSize);
    const go = (p) => (server ? onPage(p) : setLocalPage(p));

    return (
        <div className="card overflow-hidden">
            <div className="overflow-x-auto relative">
                <table className="min-w-full divide-y divide-slate-200">
                    <thead><tr>{columns.map((c) => <th key={c.key} className={`th ${c.className || ''}`}>{c.label}</th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                        {visible.map((r, i) => (
                            <tr key={r[rowKey] ?? i} onClick={onRowClick ? () => onRowClick(r) : undefined} className={`${onRowClick ? 'cursor-pointer' : ''} hover:bg-brand-50/40`}>
                                {columns.map((c) => <td key={c.key} className={`td ${c.className || ''}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {loading && <div className="absolute inset-0 bg-white/60 flex items-center justify-center min-h-[120px]"><Spinner className="h-7 w-7" /></div>}
                {!loading && !visible.length && (empty || <EmptyState title="No records found" message="Try adjusting your search or filters." />)}
            </div>
            {count > 0 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm text-slate-500">
                    <span>{count.toLocaleString()} record{count === 1 ? '' : 's'}</span>
                    <div className="flex items-center gap-2">
                        <button className="btn-secondary btn-sm" disabled={cur <= 1} onClick={() => go(cur - 1)}><ChevronLeft className="h-4 w-4" /></button>
                        <span>Page {cur} of {totalPages}</span>
                        <button className="btn-secondary btn-sm" disabled={cur >= totalPages} onClick={() => go(cur + 1)}><ChevronRight className="h-4 w-4" /></button>
                    </div>
                </div>
            )}
        </div>
    );
}
