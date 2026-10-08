import { Link } from 'react-router-dom';
import { Users, UserCheck, MapPin, CalendarPlus, Plane, Gauge, Clock, AlertTriangle, DollarSign, CalendarCheck, Timer } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import { useFetch } from '../hooks/useFetch';
import { useAuth } from '../store/authStore';
import { PageHeader, StatCard, Card, PageLoader, ErrorState, Badge, EmptyState } from '../components/ui';
import { money, num, date, time12 } from '../lib/format';

const COLORS = ['#2563eb', '#60a5fa', '#1e40af', '#93c5fd', '#3b82f6'];

export default function Dashboard() {
    const user = useAuth((s) => s.user);
    const { data, loading, error, reload } = useFetch('/dashboard');
    if (loading && !data) return <PageLoader label="Loading dashboard…" />;
    if (error) return <ErrorState message={error} onRetry={reload} />;
    if (data.role === 'Employee') return <EmployeeDashboard d={data} name={user.name} />;
    const c = data.cards;
    return (
        <>
            <PageHeader title="Workforce Dashboard" subtitle={`KP Retail Group · Week of ${date(data.weekStart)}`} />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                <StatCard label="Total Employees" value={num(c.totalEmployees)} icon={Users} hint="All employment statuses" />
                <StatCard label="Active Employees" value={num(c.activeEmployees)} icon={UserCheck} tone="green" hint={`${c.totalEmployees - c.activeEmployees} inactive / on leave`} />
                <StatCard label="Locations" value={num(c.locations)} icon={MapPin} tone="violet" hint="North & South regions" />
                <StatCard label="Open Shifts" value={num(c.openShifts)} icon={CalendarPlus} tone="amber" hint="Unassigned this week" />
                <StatCard label="Pending Time Off" value={num(c.pendingTimeOff)} icon={Plane} tone="amber" hint="Awaiting approval" />
                <StatCard label="Labor Budget Utilization" value={`${c.budgetUtilization}%`} icon={Gauge} tone={c.budgetUtilization > 100 ? 'red' : 'green'} hint={`${money(c.laborCost)} of ${money(c.laborBudget)}`} />
                <StatCard label="Weekly Scheduled Hours" value={num(c.scheduledHours)} icon={Clock} hint={`Labor cost ${money(c.laborCost)}`} />
                <StatCard label="Attendance Exceptions" value={num(c.attendanceExceptions)} icon={AlertTriangle} tone="red" hint="Missing punches & late arrivals" />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-4">
                <Card title="Weekly Staffing Overview" className="xl:col-span-2">
                    <div className="h-72">
                        <ResponsiveContainer>
                            <BarChart data={data.staffing}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                                <XAxis dataKey="day" fontSize={12} /><YAxis fontSize={12} />
                                <Tooltip /><Legend />
                                <Bar dataKey="scheduledHours" name="Scheduled hours" fill="#2563eb" radius={[4, 4, 0, 0]} />
                                <Bar dataKey="requiredHours" name="Forecast demand hours" fill="#93c5fd" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
                <Card title="Hours by Department">
                    <div className="h-72">
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie data={data.departmentHours} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                                    {data.departmentHours.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                                </Pie>
                                <Tooltip formatter={(v) => `${num(v)} hrs`} /><Legend wrapperStyle={{ fontSize: 12 }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </Card>
            </div>

            <Card title="Labor Trend (12 weeks)" className="mb-4">
                <div className="h-72">
                    <ResponsiveContainer>
                        <LineChart data={data.laborTrend}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                            <XAxis dataKey="week" fontSize={12} /><YAxis fontSize={12} />
                            <Tooltip formatter={(v) => `${num(v)} hrs`} /><Legend />
                            <Line type="monotone" dataKey="budgetHours" name="Budget hours" stroke="#1e40af" strokeDasharray="5 4" dot={false} strokeWidth={2} />
                            <Line type="monotone" dataKey="plannedHours" name="Scheduled hours" stroke="#3b82f6" strokeWidth={2} />
                            <Line type="monotone" dataKey="actualHours" name="Actual hours" stroke="#10b981" strokeWidth={2} connectNulls={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card title="Pending Time Off" actions={<Link to="/time-off" className="text-sm text-brand-600 font-medium">View all</Link>} bodyClass="divide-y">
                    {data.recentPending.length ? data.recentPending.map((t) => (
                        <div key={t._id} className="flex items-center justify-between px-5 py-3">
                            <div><p className="text-sm font-medium">{t.employeeName}</p><p className="text-xs text-slate-500">{t.type} · {date(t.startDate)} – {date(t.endDate)}</p></div>
                            <Badge>Pending</Badge>
                        </div>)) : <EmptyState title="No pending requests" />}
                </Card>
                <Card title="Attendance Exceptions" actions={<Link to="/timesheets" className="text-sm text-brand-600 font-medium">Resolve</Link>} bodyClass="divide-y">
                    {data.recentExceptions.length ? data.recentExceptions.map((t) => (
                        <div key={t._id} className="flex items-center justify-between px-5 py-3">
                            <div><p className="text-sm font-medium">{t.employeeName}</p><p className="text-xs text-slate-500">{date(t.date)} · In {time12(t.clockIn)} · Out {time12(t.clockOut)}</p></div>
                            <div className="flex gap-1 flex-wrap justify-end">{t.exceptions.map((e) => <Badge key={e} tone="red">{e}</Badge>)}</div>
                        </div>)) : <EmptyState title="No open exceptions" />}
                </Card>
            </div>
        </>
    );
}

function EmployeeDashboard({ d, name }) {
    return (
        <>
            <PageHeader title={`Hi, ${name.split(' ')[0]} 👋`} subtitle={`Your week at a glance · Week of ${date(d.weekStart)}`}
                actions={<Link to="/time-clock" className="btn-primary"><Timer className="h-4 w-4" />Time Clock</Link>} />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                <StatCard label="Scheduled This Week" value={`${num(d.scheduledHours)} hrs`} icon={CalendarCheck} hint={`${d.shifts.length} shifts`} />
                <StatCard label="Recent Worked Hours" value={`${num(d.workedHours, 1)} hrs`} icon={Clock} tone="green" hint="Last 7 timecards" />
                <StatCard label="Vacation Balance" value={`${d.vacationBalance} days`} icon={Plane} tone="violet" />
                <StatCard label="Open Shifts Available" value={d.openShifts} icon={DollarSign} tone="amber" hint="Pick up extra hours" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card title="My Shifts This Week" actions={<Link to="/my-schedule" className="text-sm text-brand-600 font-medium">Full schedule</Link>} bodyClass="divide-y">
                    {d.shifts.length ? d.shifts.map((s) => (
                        <div key={s._id} className="flex items-center justify-between px-5 py-3">
                            <div><p className="text-sm font-medium">{date(s.date)}</p><p className="text-xs text-slate-500">{s.jobTitle} · {s.department}</p></div>
                            <span className="text-sm font-semibold text-brand-700">{time12(s.start)} – {time12(s.end)}</span>
                        </div>)) : <EmptyState title="No published shifts this week" />}
                </Card>
                <Card title="My Time Off Requests" actions={<Link to="/time-off" className="text-sm text-brand-600 font-medium">Request</Link>} bodyClass="divide-y">
                    {d.timeoff.length ? d.timeoff.map((t) => (
                        <div key={t._id} className="flex items-center justify-between px-5 py-3">
                            <div><p className="text-sm font-medium">{t.type}</p><p className="text-xs text-slate-500">{date(t.startDate)} – {date(t.endDate)}</p></div><Badge>{t.status}</Badge>
                        </div>)) : <EmptyState title="No requests yet" />}
                </Card>
            </div>
        </>
    );
}
