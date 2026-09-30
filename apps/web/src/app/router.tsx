import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { CampaignsPage } from '@/pages/CampaignsPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ScheduledPage } from '@/pages/ScheduledPage';
import { SentPage } from '@/pages/SentPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { Spinner } from '@/components/ui/Spinner';

// Heavy pages (charts; the composer with CSV parsing, forms and forecast) load on demand.
const SendersPage = lazy(() =>
  import('@/pages/SendersPage').then((m) => ({ default: m.SendersPage })),
);
const ComposePage = lazy(() =>
  import('@/pages/ComposePage').then((m) => ({ default: m.ComposePage })),
);
const AnalyticsPage = lazy(() =>
  import('@/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })),
);
const pageFallback = (
  <div className="grid h-64 place-items-center text-brand-600">
    <Spinner className="size-6" />
  </div>
);

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<DashboardLayout />}>
            <Route path="/dashboard" element={<Navigate to="/dashboard/scheduled" replace />} />
            <Route path="/dashboard/scheduled" element={<ScheduledPage />} />
            <Route path="/dashboard/sent" element={<SentPage />} />
            <Route
              path="/compose"
              element={
                <Suspense fallback={pageFallback}>
                  <ComposePage />
                </Suspense>
              }
            />
            <Route path="/campaigns" element={<CampaignsPage />} />
            <Route
              path="/senders"
              element={
                <Suspense fallback={pageFallback}>
                  <SendersPage />
                </Suspense>
              }
            />
            <Route
              path="/analytics"
              element={
                <Suspense fallback={pageFallback}>
                  <AnalyticsPage />
                </Suspense>
              }
            />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  );
}
