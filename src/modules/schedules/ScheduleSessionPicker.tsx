import { Check, ChevronsUpDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Command, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/shared/ui';
import type { ScheduleTargetSession } from '@/shared/types';

/** Schedule form selects only existing active sessions, with search and explicit pagination. */
export function ScheduleSessionPicker({
  initialId,
  disabled,
  onChange,
}: {
  initialId: string;
  disabled: boolean;
  /** Reports the chosen session (or the resolved initial one) so the form can load its provider's models and modes. */
  onChange?: (session: ScheduleTargetSession | null) => void;
}) {
  const { t } = useTranslation('common');
  // Read at call time so a new callback identity never restarts the lookups below.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  // The picker opens one searchable list, retaining the selected session when it closes.
  const [open, setOpen] = useState(false);
  // Loading must not appear as a successful empty search.
  const [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  // Search text drives server filtering rather than assuming the first page contains every session.
  const [search, setSearch] = useState('');
  // Results and continuation represent the currently loaded server page(s).
  const [page, setPage] = useState<{
    items: ScheduleTargetSession[];
    nextToken: string | null;
  }>({ items: [], nextToken: null });
  // A preselected session may be outside the first page and must remain identifiable.
  const [selected, setSelected] = useState<ScheduleTargetSession | null>(null);
  // The label and submitted ID share one selection; the initial ID remains usable during lookup.
  const value = selected?.sessionId ?? initialId;
  // Request errors must not be presented as an empty session catalog.
  const [error, setError] = useState('');
  const generation = useRef(0);
  const initialLookupGeneration = useRef(0);
  const loadingMore = useRef(false);
  useEffect(() => {
    if (!open) return;
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
            setLoading(false);
          }
        })
        .catch((e: Error) => {
          if (generation.current === current) {
            setError(e.message);
            setLoading(false);
          }
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      requestEpoch.current++;
    };
  }, [search, open]);
  useEffect(() => {
    let active = true;
    const current = ++initialLookupGeneration.current;
    if (initialId)
      void api.schedules
        .session(initialId)
        .then(readApiJson<NonNullable<typeof selected>>)
        .then((result) => {
          if (active && current === initialLookupGeneration.current) {
            setSelected(result);
            onChangeRef.current?.(result);
          }
        })
        .catch((e: Error) => {
          if (active && current === initialLookupGeneration.current) setError(e.message);
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
  const choose = (session: typeof selected) => {
    if (!session) return;
    initialLookupGeneration.current++;
    setSelected(session);
    onChangeRef.current?.(session);
    setError('');
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <input type="hidden" name="sessionId" value={value} />
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        role="combobox"
        aria-label={t('schedules.session')}
        aria-expanded={open}
        aria-required="true"
        aria-controls={listId}
        aria-haspopup="listbox"
        disabled={disabled}
        className="w-full justify-between font-normal"
        onClick={() => {
          setOpen(!open);
          if (!open) setLoading(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setLoading(true);
            setOpen(true);
          }
        }}
      >
        <span className="truncate">{selected?.title || value || t('schedules.chooseSession')}</span>
        <ChevronsUpDown className="shrink-0 text-muted-foreground" />
      </Button>
      {open && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          <Command shouldFilter={false}>
            <CommandInput
              autoFocus
              aria-label={t('schedules.searchSessions')}
              placeholder={t('schedules.searchSessions')}
              value={search}
              onValueChange={(text) => {
                setLoading(true);
                setPage({ items: [], nextToken: null });
                setSearch(text);
              }}
            />
            <CommandList id={listId}>
              {loading && (
                <p role="status" className="p-3 text-xs text-muted-foreground">
                  {t('schedules.loading')}
                </p>
              )}
              {!loading && !error && <CommandEmpty>{t('schedules.noSessions')}</CommandEmpty>}
              {page.items.map((session) => (
                <CommandItem
                  key={session.sessionId}
                  value={session.sessionId}
                  onSelect={() => choose(session)}
                  className="gap-2"
                >
                  <Check
                    className={
                      'h-4 w-4 shrink-0 ' + (value === session.sessionId ? '' : 'invisible')
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">
                      {session.title || session.sessionId}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {session.provider} · {session.projectPath}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
            {page.nextToken && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => void more()}
              >
                {t('schedules.loadMore')}
              </Button>
            )}
          </Command>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
