import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useToasts } from '../store/toastStore';

export default function Toasts() {
    const { toasts, dismiss } = useToasts();
    const icon = { success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />, error: <XCircle className="h-5 w-5 text-red-500" />, info: <Info className="h-5 w-5 text-brand-500" /> };
    return (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100%-2rem)] sm:w-96">
            {toasts.map((t) => (
                <div key={t.id} className="card flex items-start gap-3 p-3.5 shadow-lg animate-[fadeIn_.2s]">
                    {icon[t.type]}<p className="text-sm text-slate-700 flex-1">{t.message}</p>
                    <button onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
                </div>
            ))}
        </div>
    );
}
