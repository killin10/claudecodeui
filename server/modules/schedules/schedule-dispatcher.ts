import { dispatchSchedules } from './schedules.service.js';

let timer: ReturnType<typeof setInterval> | undefined;
/** Server startup owns the timer; scheduling only enqueues, so model execution cannot block it. */
export function startScheduleDispatcher() {
  if (timer) return;
  const poll = () => {
    try {
      dispatchSchedules();
    } catch (error) {
      console.error('[Schedules] Poll failed', error);
    }
  };
  timer = setInterval(poll, 5000);
  timer.unref();
  poll();
}
/** Server shutdown releases the timer; persisted triggers survive restart. */
export function closeScheduleDispatcher() {
  clearInterval(timer);
  timer = undefined;
}
