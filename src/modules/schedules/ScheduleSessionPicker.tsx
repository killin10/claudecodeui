import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';

/** Schedule form selects only existing active sessions, with search and explicit pagination. */
export function ScheduleSessionPicker({
  initialId,
  disabled,
}: {
  initialId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation('common');
  // Search text drives server filtering rather than assuming the first page contains every session.
  const [search, setSearch] = useState('');
  // Results and continuation represent the currently loaded server page(s).
  const [page, setPage] = useState<{
    items: {
      sessionId: string;
      title: string | null;
      provider: string;
      projectPath: string | null;
    }[];
    nextToken: string | null;
  }>({ items: [], nextToken: null });
  // A preselected session may be outside the first page and must remain identifiable.
  const [selected, setSelected] = useState<{
    sessionId: string;
    title: string | null;
    provider: string;
    projectPath: string | null;
  } | null>(null);
  // Holds the selected ID across searches; required input prevents an empty target.
  const [value, setValue] = useState(initialId);
  // Request errors must not be presented as an empty session catalog.
  const [error, setError] = useState('');
  const generation = useRef(0);
  const loadingMore = useRef(false);
  useEffect(() => {
    const requestEpoch = generation;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      void api.schedules
        .sessions(search)
        .then(readApiJson<typeof page>)
        .then((result) => {
          if (generation.current === current) {
            setPage(result);
            setError('');
          }
        })
        .catch((e: Error) => {
          if (generation.current === current) setError(e.message);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      requestEpoch.current++;
    };
  }, [search]);
  useEffect(() => {
    let active = true;
    if (initialId)
      void api.schedules
        .session(initialId)
        .then(readApiJson<NonNullable<typeof selected>>)
        .then((result) => {
          if (active) setSelected(result);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [initialId]);
  async function more() {
    if (!page.nextToken || loadingMore.current) return;
    loadingMore.current = true;
    const current = generation.current;
    try {
      const next = await readApiJson<typeof page>(
        await api.schedules.sessions(search, page.nextToken),
      );
      if (current === generation.current)
        setPage((old) => ({ items: [...old.items, ...next.items], nextToken: next.nextToken }));
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      loadingMore.current = false;
    }
  }
  const options =
    selected && !page.items.some((s) => s.sessionId === selected.sessionId)
      ? [selected, ...page.items]
      : page.items;
  return (
    <div className="space-y-2">
      {!disabled && (
        <input
          aria-label={t('schedules.searchSessions')}
          placeholder={t('schedules.searchSessions')}
          className="w-full rounded border bg-background p-2"
          value={search}
          onChange={(e) => {
            setPage({ items: [], nextToken: null });
            setSearch(e.target.value);
          }}
        />
      )}
      <select
        required
        name="sessionId"
        aria-label={t('schedules.session')}
        className="w-full rounded border bg-background p-2"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          setSelected(options.find((s) => s.sessionId === e.target.value) ?? null);
        }}
      >
        <option value="">{t('schedules.chooseSession')}</option>
        {options.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {s.title || s.sessionId} · {s.provider} · {s.projectPath}
          </option>
        ))}
      </select>
      {disabled && <input type="hidden" name="sessionId" value={initialId} />}
      {page.nextToken && !disabled && (
        <button type="button" onClick={() => void more()}>
          {t('schedules.loadMore')}
        </button>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
