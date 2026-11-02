import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FormInfo } from '@opencode/client';

import { prepareOpenCodeFormAnswer } from '@/modules/providers/list/opencode/opencode-forms.provider.js';

const form: FormInfo = {
  id: 'frm_test', sessionID: 'ses_test', title: 'Settings', fields: [
    { key: 'enabled', type: 'boolean', default: false },
    { key: 'count', type: 'integer', required: true, minimum: 1, maximum: 5, when: [{ key: 'enabled', op: 'eq', value: true }] },
    { key: 'colors', type: 'multiselect', options: [{ label: 'Red', value: 'red' }], custom: false, maxItems: 1 },
  ],
};

test('form conditions omit inactive answers, keep false, and apply defaults', () => {
  assert.deepEqual(prepareOpenCodeFormAnswer(form, { answer: { count: 99 } }, []), { enabled: false });
  assert.deepEqual(prepareOpenCodeFormAnswer(form, { answer: { enabled: true, count: 3, colors: ['red'] } }, []), { enabled: true, count: 3, colors: ['red'] });
});

test('required fields, native numeric types, bounds and options are validated before reply', () => {
  for (const count of [undefined, null, '3', NaN, Infinity, 1.5, 0, 6]) {
    assert.throws(() => prepareOpenCodeFormAnswer(form, { answer: { enabled: true, count } }, []));
  }
  assert.throws(() => prepareOpenCodeFormAnswer(form, { answer: { colors: ['blue'] } }, []));
  assert.throws(() => prepareOpenCodeFormAnswer(form, { answer: { colors: ['red', 'red'] } }, []));
  assert.throws(() => prepareOpenCodeFormAnswer(form, { answer: { unknown: true } }, []));
});

test('legacy label replies still resolve option values and boolean values', () => {
  assert.deepEqual(prepareOpenCodeFormAnswer(form, { answers: [] }, [['true'], ['4'], ['Red']]), { enabled: true, count: 4, colors: ['red'] });
});
