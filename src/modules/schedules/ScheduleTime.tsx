import { useTranslation } from 'react-i18next';

/** Schedule cards, history and previews share explicit 00–23 hour formatting. */
export function ScheduleTime({ value, timezone }: { value: string; timezone: string }) {
  const { i18n } = useTranslation('common');
  return (
    <time dateTime={value} className="tabular-nums">
      {new Date(value).toLocaleString(i18n.language, {
        timeZone: timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
        hourCycle: 'h23',
      })}
    </time>
  );
}
