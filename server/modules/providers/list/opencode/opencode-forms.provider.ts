import type { FormAnswer, FormInfo } from '@opencode/client';

import { readObjectRecord } from '@/shared/utils.js';

function fromLabels(field: FormInfo['fields'][number], labels: string[]): unknown {
  const values = labels.map((label) => 'options' in field
    ? field.options?.find((option) => (option.label ?? option.value) === label)?.value ?? label
    : label);
  if (values.length === 0) return undefined;
  switch (field.type) {
    case 'external': return true;
    case 'multiselect': return values;
    case 'boolean': return values[0] === 'true' ? true : values[0] === 'false' ? false : values[0];
    case 'integer':
    case 'number': return Number(values[0]);
    case 'string': return values[0];
  }
}

function validateValue(field: FormInfo['fields'][number], value: unknown): void {
  const fail = (message: string): never => { throw new Error(`${field.title || field.key}: ${message}`); };
  if (field.type === 'external') {
    if (value !== true) fail('Please acknowledge before continuing.');
    return;
  }
  if (value === undefined) {
    if (field.required) fail('An answer is required.');
    return;
  }
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') fail('Choose true or false.');
      return;
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('Enter a finite number.');
      const number = value as number;
      if (field.type === 'integer' && !Number.isInteger(number)) fail('Enter an integer.');
      if (field.minimum !== undefined && number < Number(field.minimum)) fail(`Minimum: ${field.minimum}.`);
      if (field.maximum !== undefined && number > Number(field.maximum)) fail(`Maximum: ${field.maximum}.`);
      return;
    }
    case 'string': {
      if (typeof value !== 'string') fail('Enter text.');
      const text = value as string;
      if (field.minLength !== undefined && text.length < field.minLength) fail(`Minimum length: ${field.minLength}.`);
      if (field.maxLength !== undefined && text.length > field.maxLength) fail(`Maximum length: ${field.maxLength}.`);
      if (field.pattern && !new RegExp(field.pattern).test(text)) fail('The value does not match the required pattern.');
      if (field.custom === false && field.options && !field.options.some((option) => option.value === text)) fail('Choose one of the available options.');
      return;
    }
    case 'multiselect': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail('Choose a list of options.');
      const selected = value as string[];
      if (field.minItems !== undefined && selected.length < field.minItems) fail(`Select at least ${field.minItems} options.`);
      if (field.maxItems !== undefined && selected.length > field.maxItems) fail(`Select at most ${field.maxItems} options.`);
      if (field.custom === false && selected.some((item) => !field.options.some((option) => option.value === item))) fail('Choose from the available options.');
    }
  }
}

/** Runtime form replies use native keys/types; older clients can still submit label lists. */
export function prepareOpenCodeFormAnswer(form: FormInfo, updatedInput: unknown, labels: string[][]): FormAnswer {
  const input = readObjectRecord(updatedInput);
  const supplied = readObjectRecord(input?.answer);
  if (input && 'answer' in input && !supplied) throw new Error('The answer must be an object keyed by form field.');
  if (supplied && Object.keys(supplied).some((key) => !form.fields.some((field) => field.key === key))) {
    throw new Error('The answer contains an unknown field.');
  }
  const answer: FormAnswer = {};
  form.fields.forEach((field, index) => {
    const active = !('when' in field) || (field.when ?? []).every((condition) => {
      const previous = answer[condition.key];
      if (previous === undefined) return false;
      const matches = Array.isArray(previous) ? previous.includes(String(condition.value)) : previous === condition.value;
      return condition.op === 'eq' ? matches : !matches;
    });
    if (!active) return;
    const suppliedValue = supplied ? supplied[field.key] : fromLabels(field, labels[index] ?? []);
    const value = suppliedValue === undefined && 'default' in field ? field.default : suppliedValue;
    validateValue(field, value);
    if (value !== undefined) answer[field.key] = value as FormAnswer[string];
  });
  return answer;
}
