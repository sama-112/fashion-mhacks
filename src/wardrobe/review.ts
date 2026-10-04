import { randomUUID } from "node:crypto";
import { MAX_WARDROBE_ITEMS, type WardrobeCandidate } from "./types.ts";

export interface WardrobeReview {
  readonly action: "show" | "update" | "confirm" | "cancel" | "unrecognized";
  readonly items: WardrobeCandidate[];
  readonly text: string;
}

const COMMANDS = 'Reply with "change 2: navy shirt", "remove 2", or "add black jeans" to correct this list. Reply "save wardrobe" to confirm these items, or "cancel" to discard this draft.';

export function formatWardrobeReview(items: readonly WardrobeCandidate[]): string {
  const list = items.length
    ? items.map((item, index) => `${index + 1}. ${item.description}${item.uncertain ? " (please check; unclear in the video)" : ""}`).join("\n")
    : "No clothing items are in this draft. Add an item or send a clearer closet video.";
  return `Wardrobe draft — please check each item. These items are not saved yet.\n\n${list}\n\n${COMMANDS}`;
}

function validDescription(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\r\n\u0000-\u001f]|https?:\/\/|www\./i.test(value);
}

/** Pure command interpretation: the caller persists a draft or a confirmed wardrobe separately. */
export function reviewWardrobe(text: string, candidates: readonly WardrobeCandidate[]): WardrobeReview {
  const items = candidates.map(item => ({ ...item, colors: [...item.colors] }));
  const command = text.trim();
  const result = (action: WardrobeReview["action"], message = formatWardrobeReview(items)): WardrobeReview => ({ action, items, text: message });
  if (/^(?:show|review) wardrobe$/i.test(command)) return result("show");
  if (/^(?:cancel|cancel wardrobe)$/i.test(command)) return result("cancel", "Wardrobe draft discarded.");
  if (/^save wardrobe$/i.test(command)) {
    if (!items.length) return result("show", `Add at least one item before saving.\n\n${COMMANDS}`);
    return result("confirm", `Ready to save ${items.length} reviewed clothing item${items.length === 1 ? "" : "s"}.`);
  }

  const change = /^change\s+([1-9]\d*):\s*(.+)$/i.exec(command);
  const remove = /^remove\s+([1-9]\d*)$/i.exec(command);
  const add = /^add\s+(.+)$/i.exec(command);
  if (change || remove) {
    const position = Number((change ?? remove)![1]) - 1;
    if (!Number.isSafeInteger(position) || position >= items.length) {
      return result("show", `That item number is not in this draft.\n\n${formatWardrobeReview(items)}`);
    }
    if (remove) items.splice(position, 1);
    else {
      const description = change![2]!.trim();
      if (!validDescription(description)) return result("show", "Use a short description of up to 200 characters on one line, without links.");
      // A correction can change the garment entirely; don't retain guessed attributes.
      items[position] = { ...items[position]!, description, category: "other", colors: [], uncertain: false };
    }
    return result("update");
  }
  if (add) {
    const description = add[1]!.trim();
    if (!validDescription(description)) return result("show", "Use a short description of up to 200 characters on one line, without links.");
    if (items.length >= MAX_WARDROBE_ITEMS) return result("show", `A wardrobe draft can contain up to ${MAX_WARDROBE_ITEMS} items. Remove an item before adding another.`);
    items.push({ id: randomUUID(), description, category: "other", colors: [], uncertain: false });
    return result("update");
  }
  return result("unrecognized", `Please check or correct your wardrobe draft first.\n\n${COMMANDS}`);
}
