import type { ReactNode } from 'react';
import { NavLink, useInRouterContext } from 'react-router-dom';

/** Sidebar uses this link to preserve the host router's basename, including embedded deployments. */
export function ScheduleLink({
  sessionId,
  children,
  className,
  title,
}: {
  sessionId?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const inRouter = useInRouterContext();
  const to = '/schedules' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '');
  return inRouter ? (
    <NavLink
      to={to}
      className={({ isActive }) =>
        [className, isActive ? 'bg-accent text-foreground' : ''].filter(Boolean).join(' ')
      }
      title={title}
      aria-label={title}
    >
      {children}
    </NavLink>
  ) : (
    <a href={to} className={className} title={title} aria-label={title}>
      {children}
    </a>
  );
}
