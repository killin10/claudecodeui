import { useId, useState } from 'react';
import type { FormAnswer, FormInfo } from '@opencode/client';

import type { PermissionPanelProps } from '@/shared/types';

type Field = FormInfo['fields'][number];
type ControlProps<T extends Field = Field> = {
  field: T;
  value: FormAnswer[string] | undefined;
  onChange(value: FormAnswer[string]): void;
};

const INPUT_CLASS = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

function activeAnswer(form: FormInfo, values: FormAnswer): FormAnswer {
  const answer: FormAnswer = {};
  for (const field of form.fields) {
    if (!isActive(field, answer)) continue;
    const value = values[field.key];
    if (value === undefined || ((field.type === 'number' || field.type === 'integer') && value === '')) continue;
    answer[field.key] = field.type === 'number' || field.type === 'integer' ? Number(value) : value;
  }
  return answer;
}

function isActive(field: Field, answer: FormAnswer): boolean {
  if (!('when' in field)) return true;
  return (field.when ?? []).every((condition) => {
    const value = answer[condition.key];
    if (value === undefined) return false;
    const matches = Array.isArray(value) ? value.includes(String(condition.value)) : value === condition.value;
    return condition.op === 'eq' ? matches : !matches;
  });
}

function MultiselectControl({ field, value, onChange }: ControlProps<Extract<Field, { type: 'multiselect' }>>) {
  const selected = Array.isArray(value) ? value : [];
  // Preserve unfinished lines while the submitted answer contains only nonempty values.
  const [customText, setCustomText] = useState(() => selected
    .filter((item) => !field.options.some((option) => option.value === item)).join('\n'));
  const toggleOption = (option: string, checked: boolean) => {
    onChange(checked ? [...selected, option] : selected.filter((item) => item !== option));
  };
  const updateCustom = (text: string) => {
    setCustomText(text);
    onChange([
      ...selected.filter((item) => field.options.some((option) => option.value === item)),
      ...text.split('\n').filter(Boolean),
    ]);
  };
  return (
    <div className="space-y-2">
      {field.options.map((option) => (
        <label key={option.value} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => toggleOption(option.value, event.target.checked)} />
          <span>
            {option.label}
            {option.description && <span className="ml-2 text-muted-foreground">{option.description}</span>}
          </span>
        </label>
      ))}
      {field.custom !== false && (
        <textarea aria-label={`${field.title || field.key}: additional values`} className={INPUT_CLASS}
          placeholder="Additional values, one per line" value={customText} onChange={(event) => updateCustom(event.target.value)} />
      )}
      {(field.minItems !== undefined || field.maxItems !== undefined) && (
        <p className="text-xs text-muted-foreground">Selections: {field.minItems ?? 0}–{field.maxItems ?? '∞'}</p>
      )}
    </div>
  );
}

function StringControl({ field, value, onChange }: ControlProps<Extract<Field, { type: 'string' }>>) {
  const listId = useId();
  const label = field.title || field.key;
  if (field.options && field.custom === false) {
    return (
      <select aria-label={label} className={INPUT_CLASS} value={String(value ?? '')} required={field.required} onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>Choose…</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <>
      <input aria-label={label} className={INPUT_CLASS} type={field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'}
        required={field.required} minLength={field.minLength} maxLength={field.maxLength} pattern={field.pattern} placeholder={field.placeholder}
        list={field.options?.length ? listId : undefined} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
      {field.options?.length ? (
        <datalist id={listId}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
      ) : null}
    </>
  );
}

function FormControl({ field, value, onChange }: ControlProps) {
  const label = field.title || field.key;
  if (field.type === 'multiselect') return <MultiselectControl field={field} value={value} onChange={onChange} />;
  if (field.type === 'string') return <StringControl field={field} value={value} onChange={onChange} />;
  if (field.type === 'external') {
    return (
      <div className="space-y-2">
        {/^https?:\/\//i.test(field.url) && <a href={field.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">{label}</a>}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={value === true} required onChange={(event) => onChange(event.target.checked)} />Continue
        </label>
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select aria-label={label} className={INPUT_CLASS} value={value === undefined ? '' : String(value)} required={field.required}
        onChange={(event) => onChange(event.target.value === 'true')}>
        <option value="" disabled>Choose…</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return <input aria-label={label} className={INPUT_CLASS} type="number" required={field.required} min={field.minimum} max={field.maximum}
      step={field.type === 'integer' ? 1 : 'any'} value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />;
  }
  return null;
}

/** PermissionRequestsBanner delegates V2 forms here to preserve native types, constraints and retryable answers. */
export function OpenCodeFormPanel({ request, form, onDecision, agentLabel }: PermissionPanelProps & { form: FormInfo }) {
  // Answers survive a server validation error because retries retain the request id and mounted panel.
  const [values, setValues] = useState<FormAnswer>(() => {
    const defaults: FormAnswer = {};
    for (const field of form.fields) {
      if ('default' in field && field.default !== undefined) defaults[field.key] = field.default;
    }
    return defaults;
  });
  const answer = activeAnswer(form, values);
  const context = request.context as { validationError?: string } | undefined;
  return <form className="space-y-4 rounded-xl border border-border bg-background p-4" onSubmit={(event) => {
    event.preventDefault();
    onDecision(request.requestId, { allow: true, updatedInput: { answer } });
  }}>
    <p className="font-medium">{agentLabel || 'OpenCode'}: {form.title}</p>
    {form.fields.filter((field) => isActive(field, answer) && !('hidden' in field && field.hidden)).map((field) => <fieldset key={field.key} className="space-y-1.5">
      <legend className="text-sm font-medium">{field.title || field.key}{'required' in field && field.required ? ' *' : ''}</legend>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      <FormControl field={field} value={values[field.key]} onChange={(value) => setValues((previous) => ({ ...previous, [field.key]: value }))} />
    </fieldset>)}
    {context?.validationError && <p role="alert" className="text-sm text-destructive">{context.validationError}</p>}
    <div className="flex justify-end gap-2">
      <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => onDecision(request.requestId, { allow: false })}>Dismiss</button>
      <button type="submit" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground">Submit</button>
    </div>
  </form>;
}
