import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Clock, BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../store/authStore';
import { toast } from '../store/toastStore';
import { Field, Spinner } from '../components/ui';

const DEMO = [
    { role: 'Administrator', email: 'admin@kpwfm.com', password: 'Admin123' },
    { role: 'Manager', email: 'manager@kpwfm.com', password: 'Manager123' },
    { role: 'Employee', email: 'employee@kpwfm.com', password: 'Employee123' },
];

export default function Login() {
    const { register, handleSubmit, setValue, formState: { errors } } = useForm();
    const [loading, setLoading] = useState(false);
    const setSession = useAuth((s) => s.setSession);
    const nav = useNavigate();

    const onSubmit = async (v) => {
        setLoading(true);
        try {
            const { token, user } = await api('/auth/login', { method: 'POST', body: v });
            setSession(token, user);
            toast.success(`Welcome back, ${user.name.split(' ')[0]}!`);
            nav('/');
        } catch (e) { toast.error(e.message); } finally { setLoading(false); }
    };

    return (
        <div className="min-h-screen grid lg:grid-cols-2">
            <div className="hidden lg:flex flex-col justify-between bg-gradient-to-br from-brand-700 via-brand-600 to-brand-800 p-12 text-white">
                <div className="flex items-center gap-3"><div className="h-10 w-10 rounded-lg bg-white text-brand-700 flex items-center justify-center font-bold">KP</div><span className="text-lg font-semibold">KP Workforce Management</span></div>
                <div>
                    <h1 className="text-4xl font-bold leading-tight">Schedule smarter.<br />Control labor costs.</h1>
                    <p className="mt-4 text-brand-100 max-w-md">Forecast-driven scheduling, time & attendance, and labor budgeting for every KP Retail Group store.</p>
                    <div className="mt-10 space-y-4">
                        {[[CalendarDays, 'Drag-and-drop scheduling with publishing'], [Clock, 'Time clock, meal breaks & exception tracking'], [BarChart3, 'Labor budgets, forecasts & reports']].map(([I, t]) => (
                            <div key={t} className="flex items-center gap-3 text-brand-50"><div className="h-9 w-9 rounded-lg bg-white/10 flex items-center justify-center"><I className="h-5 w-5" /></div>{t}</div>
                        ))}
                    </div>
                </div>
                <p className="text-xs text-brand-200">© {new Date().getFullYear()} KP Retail Group</p>
            </div>
            <div className="flex items-center justify-center p-6 bg-slate-50">
                <div className="w-full max-w-md">
                    <div className="card p-8">
                        <h2 className="text-2xl font-bold text-slate-900">Sign in</h2>
                        <p className="text-sm text-slate-500 mt-1 mb-6">Use your KP WFM credentials</p>
                        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                            <Field label="Email" error={errors.email}><input className="input" type="email" autoComplete="email" {...register('email', { required: 'Email is required' })} /></Field>
                            <Field label="Password" error={errors.password}><input className="input" type="password" autoComplete="current-password" {...register('password', { required: 'Password is required' })} /></Field>
                            <button className="btn-primary w-full py-2.5" disabled={loading}>{loading && <Spinner className="h-4 w-4 text-white" />}Sign in</button>
                        </form>
                        <p className="text-xs text-slate-400 mt-4">First sign-in may take a few seconds while demo data is created.</p>
                    </div>
                    <div className="card p-4 mt-4">
                        <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Demo accounts</p>
                        <div className="grid grid-cols-3 gap-2">
                            {DEMO.map((d) => (
                                <button key={d.role} type="button" className="btn-secondary btn-sm" onClick={() => { setValue('email', d.email); setValue('password', d.password); }}>{d.role}</button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
