import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { AppShell } from './components/AppShell.jsx';
import { Loading } from './components/ui.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { RegisterPage } from './pages/RegisterPage.jsx';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.jsx';
import { QrLandingPage } from './pages/QrLandingPage.jsx';

/*
 * Route-level code splitting: a reporter on a phone downloads the reporting form and the
 * inventory list, not the administrator's reports/user screens.
 */
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx').then((m) => ({ default: m.DashboardPage })));
const EquipmentListPage = lazy(() => import('./pages/EquipmentListPage.jsx').then((m) => ({ default: m.EquipmentListPage })));
const EquipmentDetailPage = lazy(() => import('./pages/EquipmentDetailPage.jsx').then((m) => ({ default: m.EquipmentDetailPage })));
const EquipmentFormPage = lazy(() => import('./pages/EquipmentFormPage.jsx').then((m) => ({ default: m.EquipmentFormPage })));
const FaultListPage = lazy(() => import('./pages/FaultListPage.jsx').then((m) => ({ default: m.FaultListPage })));
const FaultDetailPage = lazy(() => import('./pages/FaultDetailPage.jsx').then((m) => ({ default: m.FaultDetailPage })));
const ReportFaultPage = lazy(() => import('./pages/ReportFaultPage.jsx').then((m) => ({ default: m.ReportFaultPage })));
const WorkQueuePage = lazy(() => import('./pages/WorkQueuePage.jsx').then((m) => ({ default: m.WorkQueuePage })));
const MaintenancePage = lazy(() => import('./pages/MaintenancePage.jsx').then((m) => ({ default: m.MaintenancePage })));
const RiskPage = lazy(() => import('./pages/RiskPage.jsx').then((m) => ({ default: m.RiskPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage.jsx').then((m) => ({ default: m.ReportsPage })));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx').then((m) => ({ default: m.UsersPage })));
const ReferencePage = lazy(() => import('./pages/ReferencePage.jsx').then((m) => ({ default: m.ReferencePage })));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage.jsx').then((m) => ({ default: m.NotificationsPage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx').then((m) => ({ default: m.ProfilePage })));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx').then((m) => ({ default: m.AuditPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx').then((m) => ({ default: m.NotFoundPage })));

function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div style={{ padding: 40 }}><Loading label="Restoring your session" rows={4} /></div>;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return children;
}

function RequireRole({ roles, children }) {
  const { user } = useAuth();
  if (!roles.includes(user?.roleCode)) return <Navigate to="/" replace />;
  return children;
}

/** Forces a password change on first sign-in when an administrator issued the password. */
function MustChangePasswordGate({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user?.mustChangePassword && location.pathname !== '/profile') {
    return <Navigate to="/profile?tab=security&forced=1" replace />;
  }
  return children;
}

function Shell({ children }) {
  return (
    <RequireAuth>
      <MustChangePasswordGate>
        <AppShell>
          <Suspense fallback={<Loading label="Loading screen" rows={5} />}>{children}</Suspense>
        </AppShell>
      </MustChangePasswordGate>
    </RequireAuth>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          {/* The QR target must resolve before sign-in, so it lives outside the shell. */}
          <Route path="/e/:tag" element={<QrLandingPage />} />
          <Route path="/" element={<Shell><DashboardPage /></Shell>} />
          <Route path="/equipment" element={<Shell><EquipmentListPage /></Shell>} />
          <Route path="/equipment/new" element={<Shell><RequireRole roles={['admin', 'technician']}><EquipmentFormPage /></RequireRole></Shell>} />
          <Route path="/equipment/:id" element={<Shell><EquipmentDetailPage /></Shell>} />
          <Route path="/equipment/:id/edit" element={<Shell><RequireRole roles={['admin', 'technician']}><EquipmentFormPage /></RequireRole></Shell>} />
          <Route path="/faults" element={<Shell><FaultListPage /></Shell>} />
          <Route path="/my-reports" element={<Shell><FaultListPage mine /></Shell>} />
          <Route path="/faults/new" element={<Shell><ReportFaultPage /></Shell>} />
          <Route path="/faults/:id" element={<Shell><FaultDetailPage /></Shell>} />
          <Route path="/report/:tag" element={<Shell><ReportFaultPage /></Shell>} />
          <Route path="/work" element={<Shell><RequireRole roles={['admin', 'technician']}><WorkQueuePage /></RequireRole></Shell>} />
          <Route path="/maintenance" element={<Shell><MaintenancePage /></Shell>} />
          <Route path="/risk" element={<Shell><RiskPage /></Shell>} />
          <Route path="/reports" element={<Shell><RequireRole roles={['admin']}><ReportsPage /></RequireRole></Shell>} />
          <Route path="/users" element={<Shell><RequireRole roles={['admin']}><UsersPage /></RequireRole></Shell>} />
          <Route path="/reference" element={<Shell><RequireRole roles={['admin', 'technician']}><ReferencePage /></RequireRole></Shell>} />
          <Route path="/audit" element={<Shell><RequireRole roles={['admin']}><AuditPage /></RequireRole></Shell>} />
          <Route path="/notifications" element={<Shell><NotificationsPage /></Shell>} />
          <Route path="/profile" element={<Shell><ProfilePage /></Shell>} />
          <Route path="*" element={<Shell><NotFoundPage /></Shell>} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
