/** Routes with authentication + role guards. */
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './store/authStore';
import Layout from './components/Layout';
import Toasts from './components/Toasts';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Employees from './pages/Employees';
import Locations from './pages/Locations';
import Scheduling from './pages/Scheduling';
import MySchedule from './pages/MySchedule';
import TimeClock from './pages/TimeClock';
import Timesheets from './pages/Timesheets';
import TimeOff from './pages/TimeOff';
import Budget from './pages/Budget';
import Forecast from './pages/Forecast';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import ApiDocs from './pages/ApiDocs';
import { EmptyState } from './components/ui';
import { ShieldAlert } from 'lucide-react';

const M = ['Manager', 'Administrator'];

function Guard({ roles, children }) {
    const user = useAuth((s) => s.user);
    if (!user) return <Navigate to="/login" replace />;
    if (roles && !roles.includes(user.role)) return <EmptyState icon={ShieldAlert} title="Access denied" message="Your role does not have access to this page." />;
    return children;
}

export default function App() {
    const user = useAuth((s) => s.user);
    return (
        <>
            <Toasts />
            <Routes>
                <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
                <Route element={<Guard><Layout /></Guard>}>
                    <Route index element={<Dashboard />} />
                    <Route path="my-schedule" element={<MySchedule />} />
                    <Route path="time-clock" element={<Guard roles={['Employee', 'Manager']}><TimeClock /></Guard>} />
                    <Route path="employees" element={<Guard roles={M}><Employees /></Guard>} />
                    <Route path="locations" element={<Guard roles={M}><Locations /></Guard>} />
                    <Route path="scheduling" element={<Guard roles={M}><Scheduling /></Guard>} />
                    <Route path="timesheets" element={<Guard roles={M}><Timesheets /></Guard>} />
                    <Route path="time-off" element={<TimeOff />} />
                    <Route path="budget" element={<Guard roles={M}><Budget /></Guard>} />
                    <Route path="forecast" element={<Guard roles={M}><Forecast /></Guard>} />
                    <Route path="reports" element={<Guard roles={M}><Reports /></Guard>} />
                    <Route path="admin" element={<Guard roles={['Administrator']}><Admin /></Guard>} />
                    <Route path="admin/api-docs" element={<Guard roles={['Administrator']}><ApiDocs /></Guard>} />
                    <Route path="*" element={<EmptyState title="Page not found" message="The page you are looking for does not exist." />} />
                </Route>
            </Routes>
        </>
    );
}
