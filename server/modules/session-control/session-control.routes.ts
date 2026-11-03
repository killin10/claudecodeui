import express from 'express';
import type { Request, Response } from 'express';

import { apiKeysDb } from '@/modules/database/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { sessionControlService } from './session-control.service.js';
import { createSubmissionDispatcher } from './session-submissions.service.js';
import { fields, invalid, stringField } from './session-control.validation.js';

/** One dispatcher for the API router and server startup. */
export const submissionDispatcher = createSubmissionDispatcher(providerRuntimeService);

function user(res: Response): number { return res.locals.sessionControlUserId as number; }

function id(req: Request): string { return stringField(req.params.sessionId, 'sessionId', true)!; }

function body(req: Request, allowed: string[]) { return fields(req.body ?? {}, allowed); }

/** API-key authenticated session automation routes, mounted independently of browser JWT routes. */
export function createSessionControlRouter(dispatcher = submissionDispatcher) {
  const router = express.Router();
  router.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    const account = typeof key === 'string' ? apiKeysDb.validateApiKey(key) : null;
    if (!account) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'A valid x-api-key is required.' } });
      return;
    }
    res.locals.sessionControlUserId = account.id;
    next();
  });
  router.get('/sessions', asyncHandler(async (req, res) => {
    const input = fields(req.query, ['provider', 'projectPath', 'search', 'archiveState', 'executionState', 'maxItems', 'startingToken']);
    res.json(await sessionControlService.list(user(res), input));
  }));
  router.post('/sessions', asyncHandler(async (req, res) => {
    res.status(201).json(await sessionControlService.create(user(res), body(req, ['provider', 'projectPath', 'model', 'title', 'permissionMode', 'clientToken'])));
  }));
  router.get('/sessions/:sessionId', asyncHandler(async (req, res) => res.json(await sessionControlService.show(user(res), id(req)))));
  router.post('/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    res.status(202).json(await sessionControlService.send(user(res), id(req), body(req, ['message', 'ifBusy', 'clientToken'])));
    void dispatcher.poll().catch((error) => console.error('[SessionControl] Dispatch failed', error));
  }));
  router.get('/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    res.json(await sessionControlService.messages(id(req), fields(req.query, ['maxItems', 'startingToken'])));
  }));
  for (const action of ['archive', 'restore'] as const) {
    router.post(`/sessions/:sessionId/${action}`, asyncHandler(async (req, res) => {
      body(req, []);
      res.json(await sessionControlService.change(user(res), id(req), action));
    }));
  }
  router.delete('/sessions/:sessionId', asyncHandler(async (req, res) => {
    const input = fields(req.query, ['permanent']);
    if (input.permanent !== 'true') {
      invalid('permanent=true is required.');
    }
    res.json(await sessionControlService.change(user(res), id(req), 'delete'));
  }));
  router.get('/sessions/:sessionId/submissions/:submissionId', asyncHandler(async (req, res) => {
    res.json(sessionControlService.submission(user(res), id(req), stringField(req.params.submissionId, 'submissionId', true)!));
  }));
  router.post('/sessions/:sessionId/submissions/:submissionId/cancel', asyncHandler(async (req, res) => {
    body(req, []);
    res.json(await dispatcher.cancel(user(res), id(req), stringField(req.params.submissionId, 'submissionId', true)!));
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const known = error instanceof AppError;
    res.status(known ? error.statusCode : 500).json({ error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Internal server error.' } });
    if (!known) {
      console.error('[SessionControl]', error);
    }
  });
  return router;
}
