import type { PathwayRequest, StylePathway } from "./types.ts";

export type PathwayDraft = Omit<StylePathway, "id" | "status">;
export interface PathwayDecision {
  action: "generate" | "like" | "reject" | "revise" | "clarify" | "unrelated";
  targetId: string | null;
  reason: string | null;
  pathways: PathwayDraft[];
}

const strings = (maximum: number) => ({ type: "array", items: { type: "string" }, maxItems: maximum });
export const pathwayDecisionSchema = {
  type: "object", additionalProperties: false,
  required: ["action", "targetId", "reason", "pathways"],
  properties: {
    action: { type: "string", enum: ["generate", "like", "reject", "revise", "clarify", "unrelated"] },
    targetId: { type: ["string", "null"] }, reason: { type: ["string", "null"] },
    pathways: {
      type: "array", maxItems: 3,
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "description", "palette", "staples", "ownedItemIds"],
        properties: {
          title: { type: "string" }, description: { type: "string" },
          palette: strings(5), staples: strings(6), ownedItemIds: strings(12),
        },
      },
    },
  },
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pathway plan.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /https?:\/\/|www\./i.test(value)) {
    throw new Error("Invalid pathway plan.");
  }
  return value.trim();
}
function list(value: unknown, minimum: number, maximum: number, itemMaximum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error("Invalid pathway plan.");
  const result = value.map(item => text(item, itemMaximum));
  if (new Set(result.map(item => item.toLowerCase())).size !== result.length) throw new Error("Invalid pathway plan.");
  return result;
}

export function parsePathwayDecision(value: unknown, wardrobe: PathwayRequest["wardrobe"]): PathwayDecision {
  const decision = object(value);
  const action = text(decision.action, 20) as PathwayDecision["action"];
  if (!["generate", "like", "reject", "revise", "clarify", "unrelated"].includes(action)) throw new Error("Invalid pathway plan.");
  const targetId = decision.targetId === null ? null : text(decision.targetId, 100);
  const reason = decision.reason === null ? null : text(decision.reason, 300);
  if (!Array.isArray(decision.pathways) || decision.pathways.length > 3) throw new Error("Invalid pathway plan.");
  const ownedIds = new Set(wardrobe.map(item => item.id));
  const pathways = decision.pathways.map(value => {
    const path = object(value);
    const ownedItemIds = list(path.ownedItemIds, 0, 12, 100);
    if (ownedItemIds.some(id => !ownedIds.has(id))) throw new Error("Invalid wardrobe reference.");
    return {
      title: text(path.title, 80), description: text(path.description, 400),
      palette: list(path.palette, 1, 5, 40), staples: list(path.staples, 1, 6, 100), ownedItemIds,
    };
  });
  if (new Set(pathways.map(path => path.title.toLowerCase())).size !== pathways.length) throw new Error("Duplicate pathways.");
  if (action === "generate" && (targetId !== null || reason !== null || pathways.length < 2)) throw new Error("Invalid generation.");
  if (action === "revise" && (!reason || !targetId || pathways.length < 1 || pathways.length > 2)) throw new Error("Invalid revision.");
  if (action === "reject" && reason !== null) throw new Error("Rejection with a reason requires revision.");
  if (["like", "reject"].includes(action) && !targetId) throw new Error("Missing target.");
  if (!["generate", "revise"].includes(action) && pathways.length > 0) throw new Error("Unexpected pathways.");
  return { action, targetId, reason, pathways };
}
