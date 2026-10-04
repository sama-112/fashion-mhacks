export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export interface WeeklySettings { enabled: boolean; nextDueAt: string | null }
export function emptyWeeklySettings(): WeeklySettings { return { enabled: false, nextDueAt: null }; }
export function handleWeeklySettings(text: string, settings: WeeklySettings, now = new Date()): string | null {
  if (/^(?:(?:start|enable|turn on) weekly (?:suggestions|picks)|weekly (?:on|suggestions))$/i.test(text)) {
    settings.enabled = true;
    settings.nextDueAt ??= new Date(now.getTime() + WEEK_MS).toISOString();
    return `Weekly clothing suggestions are on. I'll send a few picks every seven days, starting ${new Date(settings.nextDueAt).toUTCString()}, using your wardrobe, liked styles, and category budgets. Say "weekly picks now" for a preview or "weekly off" to pause.`;
  }
  if (/^(?:(?:stop|pause|disable|turn off) weekly (?:suggestions|picks)|weekly off)$/i.test(text)) {
    settings.enabled = false; settings.nextDueAt = null;
    return 'Weekly suggestions are paused. Say "weekly on" to start them again.';
  }
  if (/^(?:weekly status|show weekly schedule)$/i.test(text)) return settings.enabled
    ? `Weekly suggestions are on. Next scheduled batch: ${new Date(settings.nextDueAt!).toUTCString()}. Say "weekly off" to pause.`
    : 'Weekly suggestions are off. Say "weekly on" to enable them or "weekly picks now" for a preview.';
  return null;
}

export function weeklyRequest(): string {
  return "Find a few clothing items to suggest this week. Use my liked style pathways, confirmed wardrobe, previous item rejection reasons, and spending limits by clothing type. Choose a useful wardrobe addition, not an item I already own. Supply Shopper criteria for one clothing category and explain how the items could fit my existing clothes. Do not invent products or prices; the Shopper will provide the listings.";
}
