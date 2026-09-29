import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { CampaignsPage } from '@/pages/CampaignsPage';
import { ComposePage } from '@/pages/ComposePage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ScheduledPage } from '@/pages/ScheduledPage';
import { SentPage } from '@/pages/SentPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { Spinner } from '@/components/ui/Spinner';

// The chart library is only downloaded when Analytics is opened.
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
            <Route path="/compose" element={<ComposePage />} />
            <Route path="/campaigns" element={<CampaignsPage />} />
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
