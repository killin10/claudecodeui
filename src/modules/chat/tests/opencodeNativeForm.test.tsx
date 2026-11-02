import { fireEvent, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { FormInfo } from '@opencode/client';

import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';
import type { PendingPermissionRequest } from '@/shared/types';
import '@/modules/i18n';

const form: FormInfo = { id: 'frm_native', sessionID: 'ses_test', title: 'Configure', fields: [
  { type: 'boolean', key: 'enabled', title: 'Enabled', default: false },
  { type: 'integer', key: 'count', title: 'Count', required: true, minimum: 1, maximum: 5, when: [{ key: 'enabled', op: 'eq', value: true }] },
  { type: 'string', key: 'color', title: 'Color', options: [{ value: 'red', label: 'Red' }], custom: false, default: 'red' },
] };

test('native form respects defaults/conditions and keeps answers after a server validation error', () => {
  const onDecision = vi.fn();
  const request: PendingPermissionRequest = { requestId: 'frm_native', toolName: 'AskUserQuestion', input: { form }, context: { waitForResolution: true } };
  const banner = (pending: PendingPermissionRequest) => <PermissionRequestsBanner pendingPermissionRequests={[pending]} providerLabel="OpenCode"
    handlePermissionDecision={onDecision} handleGrantToolPermission={() => ({ success: false })} />;
  const view = render(banner(request));
  expect(view.queryByRole('spinbutton')).toBeNull();
  fireEvent.change(view.getByLabelText('Enabled'), { target: { value: 'true' } });
  const number = view.getByRole('spinbutton');
  expect(number.getAttribute('min')).toBe('1');
  expect(number.getAttribute('max')).toBe('5');
  expect(number.getAttribute('step')).toBe('1');
  fireEvent.change(number, { target: { value: '3' } });
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  expect(onDecision).toHaveBeenLastCalledWith('frm_native', { allow: true, updatedInput: { answer: { enabled: true, count: 3, color: 'red' } } });
  view.rerender(banner({ ...request, context: { waitForResolution: true, validationError: 'Try again' } }));
  expect(view.getByRole('alert').textContent).toBe('Try again');
  expect((view.getByRole('spinbutton') as HTMLInputElement).value).toBe('3');
  fireEvent.change(view.getByLabelText('Enabled'), { target: { value: 'false' } });
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  expect(onDecision).toHaveBeenLastCalledWith('frm_native', { allow: true, updatedInput: { answer: { enabled: false, color: 'red' } } });
});

test('native multiselect sends values without splitting labels and external URLs require acknowledgement', () => {
  const onDecision = vi.fn();
  const input: FormInfo = { ...form, fields: [
    { key: 'sizes', title: 'Sizes', type: 'multiselect', options: [{ value: 'large', label: 'Large, wide' }], custom: false },
    { key: 'signIn', title: 'Sign in', type: 'external', url: 'https://example.com/auth' },
  ] };
  const view = render(<PermissionRequestsBanner pendingPermissionRequests={[{ requestId: 'frm', toolName: 'AskUserQuestion', input: { form: input } }]}
    handlePermissionDecision={onDecision} handleGrantToolPermission={() => ({ success: false })} />);
  fireEvent.click(view.getByLabelText('Large, wide'));
  expect(view.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.click(view.getByLabelText('Continue'));
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  expect(onDecision).toHaveBeenCalledWith('frm', { allow: true, updatedInput: { answer: { sizes: ['large'], signIn: true } } });
});

test('custom multiselect values preserve newlines while editing and submit separate values', () => {
  const onDecision = vi.fn();
  const input: FormInfo = { ...form, fields: [
    { key: 'tags', title: 'Tags', type: 'multiselect', options: [], custom: true },
  ] };
  const view = render(<PermissionRequestsBanner pendingPermissionRequests={[{ requestId: 'frm', toolName: 'AskUserQuestion', input: { form: input } }]}
    handlePermissionDecision={onDecision} handleGrantToolPermission={() => ({ success: false })} />);
  const editor = view.getByLabelText('Tags: additional values') as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'first\n' } });
  expect(editor.value).toBe('first\n');
  fireEvent.change(editor, { target: { value: `${editor.value}second` } });
  fireEvent.click(view.getByRole('button', { name: 'Submit' }));
  expect(onDecision).toHaveBeenCalledWith('frm', { allow: true, updatedInput: { answer: { tags: ['first', 'second'] } } });
});
