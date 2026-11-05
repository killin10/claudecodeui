import React, { useLayoutEffect } from 'react';
import { act, render } from '@testing-library/react';
import { expect, test } from 'vitest';

import { useSidebarScrollAnchor } from '@/modules/sidebar/hooks/useSidebarScrollAnchor';

function List({ ids }: { ids: string[] }) {
  // Install geometry before the anchor's layout effect reads it.
  useLayoutEffect(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="list"]')!;
    node.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
    [...node.children].forEach((child, index) => {
      child.getBoundingClientRect = () => ({ top: index * 30 - node.scrollTop, bottom: (index + 1) * 30 - node.scrollTop } as DOMRect);
    });
  });
  const ref = useSidebarScrollAnchor('conversations');
  return <div ref={ref} data-testid="list">{ids.map(id => <div key={id} data-sidebar-session-id={id}>{id}</div>)}</div>;
}

test('insertion and removal above the visible session retain its viewport position', () => {
  const view = render(<List ids={['a', 'b', 'c', 'd']} />);
  const node = view.getByTestId('list');
  act(() => { node.scrollTop = 35; node.dispatchEvent(new Event('scroll')); });
  view.rerender(<List ids={['new', 'a', 'b', 'c', 'd']} />);
  expect(node.scrollTop).toBe(65);
  view.rerender(<List ids={['new', 'b', 'c', 'd']} />);
  expect(node.scrollTop).toBe(35);
  view.unmount();
});
