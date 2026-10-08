/** Debounced search input. */
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';

export default function SearchBar({ value, onChange, placeholder = 'Search…', className = '' }) {
    const [v, setV] = useState(value || '');
    useEffect(() => { const t = setTimeout(() => v !== value && onChange(v), 350); return () => clearTimeout(t); }, [v]); // eslint-disable-line
    return (
        <div className={`relative ${className}`}>
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input className="input pl-9" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} />
        </div>
    );
}
