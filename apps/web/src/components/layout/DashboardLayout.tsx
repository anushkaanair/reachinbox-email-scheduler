import { Outlet } from 'react-router-dom';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { AssistantProvider } from '@/components/assistant/AssistantProvider';
import { CommandPalette } from '@/components/assistant/CommandPalette';
import { WelcomeTour } from '@/components/onboarding/WelcomeTour';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export function DashboardLayout() {
  useLiveEvents(); // one SSE stream for the whole signed-in app
  // Onboarding is opt-in (sidebar → Getting started). The brief says login lands on the dashboard, so we never redirect away from it.
  return (
    <AssistantProvider>
      <div className="flex min-h-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          {/* @container lets pages lay out by the space they actually get (the assistant panel takes some). */}
          <main className="@container flex-1 px-4 py-6 md:px-10 md:py-7">
            <Outlet />
          </main>
        </div>
        <AssistantPanel />
      </div>
      <CommandPalette />
      <WelcomeTour />
    </AssistantProvider>
  );
}
