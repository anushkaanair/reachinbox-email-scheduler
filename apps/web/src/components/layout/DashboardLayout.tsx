import { Outlet } from 'react-router-dom';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

export function DashboardLayout() {
  useLiveEvents(); // one SSE stream for the whole signed-in app
  return (
    <div className="flex min-h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
