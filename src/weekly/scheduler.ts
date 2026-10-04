export interface WeeklyQueue { enqueueDue(): Promise<number> }
// Maintenance runs in the same worker loop as message processing: one worker per deployment.
export function createWeeklyTick(queue: WeeklyQueue, now: () => number = Date.now): () => Promise<void> {
  let lastPoll = -Infinity;
  return async () => {
    if (now() - lastPoll < 60000) return;
    await queue.enqueueDue();
    lastPoll = now();
  };
}
