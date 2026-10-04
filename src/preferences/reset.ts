import { emptyProfile, type StoredProfile } from "../db/stylist-store.ts";

const CONFIRM = 'Reply "confirm reset profile" to clear your saved wardrobe, drafts, style tracks, item feedback, budgets and outfit/photo preferences, pause weekly suggestions, and start fresh bot memory. Reply "cancel reset" to keep them.';

/** A reset is an explicit user command, never a Gemini decision or generic confirmation. */
export function handleProfileReset(text: string, profile: StoredProfile, cutoff: string): string | null {
  const command = text.trim().replace(/[.!?]+$/, "").replace(/^please\s+/i, "");
  if (/^(?:reset (?:my )?profile|start (?:over|fresh)|fresh start)$/i.test(command)) {
    profile.data.pendingReset = true;
    return CONFIRM;
  }
  if (/^cancel reset$/i.test(command) || profile.data.pendingReset && /^no$/i.test(command)) {
    profile.data.pendingReset = false;
    return "Profile reset canceled. Your saved clothes and preferences are still available.";
  }
  if (/^confirm reset (?:my )?profile$/i.test(command)) {
    if (!profile.data.pendingReset) return 'Send "reset profile" first so I can explain what will be cleared.';
    profile.data = { ...emptyProfile().data, historyAfter: cutoff };
    return 'Your stylist profile is fresh. Weekly suggestions are off. Send a new closet video, review the clothes, and reply "save wardrobe". You can also send a photo of yourself captioned "my photo" and choose one or two new style tracks.';
  }
  if (profile.data.pendingReset && /^(?:yes|yeah|ok|okay|sure|confirm)$/i.test(command)) return CONFIRM;
  return null;
}
