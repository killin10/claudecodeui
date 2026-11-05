import { expect, test } from 'vitest';

import { fetchSessionListPrefix } from '@/shared/utils';

test('reloads a paginated prefix when a deletion shifts the next page', async () => {
  let rows = Array.from({ length: 180 }, (_, id) => id);
  let revision = 0;
  let calls = 0;
  const page = await fetchSessionListPrefix(140, async (limit, offset) => {
    const items = rows.slice(offset, offset + limit);
    if (++calls === 1) {
      rows = rows.slice(1);
      revision += 1;
    }
    return { items, total: rows.length };
  }, () => revision);
  expect(page.items).toEqual(rows.slice(0, 140));
  expect(page.total).toBe(179);
});

test('stops retrying a constantly changing list rather than returning a torn snapshot', async () => {
  let revision = 0;
  await expect(fetchSessionListPrefix(1, async () => {
    revision += 1;
    return { items: [1], total: 1 };
  }, () => revision)).rejects.toThrow('kept changing');
  expect(revision).toBe(3);
});
