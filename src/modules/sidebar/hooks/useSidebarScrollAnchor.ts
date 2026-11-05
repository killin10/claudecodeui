import { useLayoutEffect, useRef } from 'react';

type Anchor = { id: string; top: number };

/** SidebarContent uses stable session rows to keep the viewport through live reordering. */
export function useSidebarScrollAnchor(viewKey: string) {
  // Geometry is captured after layout and on user scroll, before the next list commit.
  const container = useRef<HTMLDivElement>(null);
  const previous = useRef<{ key: string; anchors: Anchor[]; scrollTop: number } | null>(null);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const rows = () => [...node.querySelectorAll<HTMLElement>('[data-sidebar-session-id]')];
    const capture = () => {
      const top = node.getBoundingClientRect().top;
      previous.current = { key: viewKey, scrollTop: node.scrollTop, anchors: rows()
        .filter(row => row.getBoundingClientRect().bottom > top)
        .slice(0, 3).map(row => ({ id: row.dataset.sidebarSessionId!, top: row.getBoundingClientRect().top - top })) };
    };
    const saved = previous.current;
    if (saved?.key === viewKey && saved.scrollTop > 0) {
      for (const anchor of saved.anchors) {
        const row = rows().find(item => item.dataset.sidebarSessionId === anchor.id);
        if (!row) continue;
        node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top;
        break;
      }
    }
    capture();
    node.addEventListener('scroll', capture, { passive: true });
    return () => node.removeEventListener('scroll', capture);
  });
  return container;
}
