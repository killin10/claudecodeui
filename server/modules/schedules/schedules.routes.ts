import express from 'express';
import type { Request, Response } from 'express';

import { apiKeysDb } from '@/modules/database/index.js';
import { sessionControlService } from '@/modules/session-control/index.js';
import { AppError, asyncHandler, fields, stringField } from '@/shared/utils.js';

import { schedulesService } from './schedules.service.js';

/** Mounted after browser JWT authentication, or directly for API-key CLI requests. */
export function createSchedulesRouter(browser = false) {
  const router = express.Router();
  router.use((req, res, next) => {
    const key = req.headers['x-api-key'];
    const account = browser
      ? (req as Request & { user?: { id: number } }).user
      : typeof key === 'string'
        ? apiKeysDb.validateApiKey(key)
        : null;
    if (!account || !Number.isSafeInteger(Number(account.id))) {
      res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
      return;
    }
    res.locals.scheduleUserId = Number(account.id);
    next();
  });
  const user = (res: Response) => res.locals.scheduleUserId as number;
  const id = (req: Request, key = 'id') => stringField(req.params[key], key, true)!;
  router.get(
    '/',
    asyncHandler(async (req, res) => res.json(schedulesService.list(user(res), req.query))),
  );
  router.post(
    '/',
    asyncHandler(async (req, res) =>
      res.status(201).json(await schedulesService.create(user(res), req.body)),
    ),
  );
  router.post(
    '/preview',
    asyncHandler(async (req, res) => res.json(schedulesService.preview(req.body))),
  );
  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      fields(req.query, []);
      res.json(schedulesService.summary(user(res)));
    }),
  );
  router.get(
    '/sessions',
    asyncHandler(async (req, res) =>
      res.json(
        await sessionControlService.list(
          user(res),
          fields(req.query, ['search', 'projectPath', 'maxItems', 'startingToken']),
        ),
      ),
    ),
  );
  router.get(
    '/sessions/:sessionId',
    asyncHandler(async (req, res) =>
      res.json(await sessionControlService.show(user(res), id(req, 'sessionId'))),
    ),
  );
  router.get(
    '/:id',
    asyncHandler(async (req, res) => res.json(schedulesService.show(user(res), id(req)))),
  );
  router.patch(
    '/:id',
    asyncHandler(async (req, res) =>
      res.json(await schedulesService.update(user(res), id(req), req.body)),
    ),
  );
  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      fields(req.query, []);
      res.json(schedulesService.change(user(res), id(req), 'delete'));
    }),
  );
  for (const action of ['pause', 'resume'] as const) {
    router.post(
      `/:id/${action}`,
      asyncHandler(async (req, res) => {
        fields(req.body ?? {}, []);
        res.json(schedulesService.change(user(res), id(req), action));
      }),
    );
  }
  router.post(
    '/:id/run',
    asyncHandler(async (req, res) =>
      res.status(202).json(schedulesService.run(user(res), id(req), req.body ?? {})),
    ),
  );
  router.get(
    '/:id/runs',
    asyncHandler(async (req, res) =>
      res.json(schedulesService.runs(user(res), id(req), req.query)),
    ),
  );
  router.get(
    '/:id/runs/:runId',
    asyncHandler(async (req, res) =>
      res.json(schedulesService.execution(user(res), id(req), id(req, 'runId'))),
    ),
  );
  router.post(
    '/:id/runs/:runId/cancel',
    asyncHandler(async (req, res) => {
      fields(req.body ?? {}, []);
      res.json(await schedulesService.cancel(user(res), id(req), id(req, 'runId')));
    }),
  );
  router.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const known = error instanceof AppError;
    if (!known) console.error('[Schedules]', error);
    res
      .status(known ? error.statusCode : 500)
      .json({
        error: {
          code: known ? error.code : 'INTERNAL_ERROR',
          message: known ? error.message : 'Internal server error.',
        },
      });
  });
  return router;
}
