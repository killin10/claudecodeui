import type { ReactNode } from 'react';

import { Tooltip } from '@/shared/ui';

/** Used by sidebar session lists to show full names across the clickable row. */
export function SidebarSessionTooltip({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Tooltip
      content={name}
      position="right"
      containerClassName="block min-w-0 w-full"
      className="max-w-[min(24rem,50vw)] whitespace-normal break-words"
    >
      {children}
    </Tooltip>
  );
}
