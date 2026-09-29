import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <div className="grid h-full place-items-center">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="The page you're looking for doesn't exist."
        action={
          <Link to="/dashboard">
            <Button>Go to dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}
