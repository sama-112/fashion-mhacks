/** Explicit visual requests can describe hypothetical clothes without establishing ownership. */
export function isOutfitImageRequest(text: string): boolean {
  return /\b(?:generate|create|show|picture|visuali[sz]e|render)\b.*\b(?:outfit|fit)\b.*\b(?:image|picture|photo|preview)\b|\b(?:generate|create|show|visuali[sz]e|render)\b.*\b(?:image|picture|photo)\b.*\b(?:outfit|fit|wearing|in a|in an)\b|^(?:picture|visuali[sz]e|render) (?:my |the )?outfit\b/i.test(text)
    || /\b(?:show|see|picture|visuali[sz]e)\b.*\b(?:what|how)\b.*\b(?:I|I'd|I’d|me)\b.*\blook\b/i.test(text)
    || /\b(?:show|picture|visuali[sz]e)\b.*\bme\b.*\b(?:wearing|in (?:a|an|the)|with .+ on)\b/i.test(text);
}
