/** App shell: role-based sidebar navigation + top bar. */
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, MapPin, CalendarDays, Clock, Timer, Plane, Wallet, TrendingUp, FileBarChart, Settings, LogOut, Menu, X, CalendarCheck, BookOpen } from 'lucide-react';
import { useAuth } from '../store/authStore';
import { Badge } from './ui';

export const NAV = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['Employee', 'Manager', 'Administrator'] },
    { to: '/my-schedule', label: 'My Schedule', icon: CalendarCheck, roles: ['Employee'] },
    { to: '/time-clock', label: 'Time Clock', icon: Timer, roles: ['Employee', 'Manager'] },
    { to: '/employees', label: 'Employees', icon: Users, roles: ['Manager', 'Administrator'] },
    { to: '/locations', label: 'Locations', icon: MapPin, roles: ['Manager', 'Administrator'] },
    { to: '/scheduling', label: 'Scheduling', icon: CalendarDays, roles: ['Manager', 'Administrator'] },
    { to: '/timesheets', label: 'Time & Attendance', icon: Clock, roles: ['Manager', 'Administrator'] },
    { to: '/time-off', label: 'Time Off', icon: Plane, roles: ['Employee', 'Manager', 'Administrator'] },
    { to: '/budget', label: 'Labor Budget', icon: Wallet, roles: ['Manager', 'Administrator'] },
    { to: '/forecast', label: 'Forecasting', icon: TrendingUp, roles: ['Manager', 'Administrator'] },
    { to: '/reports', label: 'Reports', icon: FileBarChart, roles: ['Manager', 'Administrator'] },
    { to: '/admin', label: 'Administration', icon: Settings, roles: ['Administrator'] },
    { to: '/admin/api-docs', label: 'API Documentation', icon: BookOpen, roles: ['Administrator'], child: true },
];

export default function Layout() {
    const { user, logout } = useAuth();
    const [open, setOpen] = useState(false);
    const nav = useNavigate();
    const items = NAV.filter((n) => n.roles.includes(user.role));

    const sidebar = (
        <div className="flex h-full flex-col bg-white border-r border-slate-200">
            <div className="flex items-center gap-2.5 px-5 h-16 border-b border-slate-100">
                <div className="h-9 w-9 rounded-lg bg-brand-600 text-white flex items-center justify-center font-bold">KP</div>
                <div><p className="font-bold text-slate-900 leading-tight">KP Workforce</p><p className="text-[11px] text-slate-500">KP Retail Group</p></div>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
                {items.map(({ to, label, icon: Icon, child }) => (
                    <NavLink key={to} to={to} end={to === '/' || to === '/admin'} onClick={() => setOpen(false)}
                        className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${child ? 'ml-4' : ''} ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                        <Icon className="h-[18px] w-[18px]" />{label}
                    </NavLink>
                ))}
            </nav>
            <div className="p-3 border-t border-slate-100">
                <button onClick={() => { logout(); nav('/login'); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700">
                    <LogOut className="h-[18px] w-[18px]" />Sign out
                </button>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen">
            <aside className="hidden lg:block fixed inset-y-0 left-0 w-64 z-30">{sidebar}</aside>
            {open && (
                <div className="lg:hidden fixed inset-0 z-40">
                    <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
                    <div className="absolute inset-y-0 left-0 w-72">{sidebar}<button className="absolute top-4 right-3 text-slate-500" onClick={() => setOpen(false)}><X /></button></div>
                </div>
            )}
            <div className="lg:pl-64">
                <header className="sticky top-0 z-20 h-16 bg-white/90 backdrop-blur border-b border-slate-200 flex items-center justify-between px-4 sm:px-6">
                    <button className="lg:hidden btn-ghost p-2" onClick={() => setOpen(true)} aria-label="Menu"><Menu className="h-5 w-5" /></button>
                    <div className="hidden sm:block text-sm text-slate-500">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
                    <div className="flex items-center gap-3">
                        <div className="text-right hidden sm:block"><p className="text-sm font-semibold text-slate-800">{user.name}</p><p className="text-xs text-slate-500">{user.email}</p></div>
                        <Badge>{user.role}</Badge>
                        <div className="h-9 w-9 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center font-semibold text-sm">
                            {user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
                        </div>
                    </div>
                </header>
                <main className="p-4 sm:p-6 max-w-[1600px] mx-auto"><Outlet /></main>
            </div>
        </div>
    );
}
