/** Normalize explicit spoken commands, without turning a generic 'yes' into a wardrobe save. */
export function spokenCommand(text: string): string {
  const command = text.trim().replace(/[.!?]+$/, "").replace(/^please\s+/i, "");
  if (/^(?:save|confirm) (?:(?:my|the) wardrobe|(?:these|the) (?:clothes|items))$/i.test(command)) return "save wardrobe";
  if (/^(?:cancel|discard) (?:(?:my|the|this) )?(?:wardrobe|draft)$/i.test(command)) return "cancel";
  if (/^(?:show|read|list) (?:my |the )?(?:wardrobe|closet)$/i.test(command)) return "show wardrobe";
  const numbers: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  const change = /^change (?:item )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?: to |:\s*)(.+)$/i.exec(command);
  if (change) return `change ${numbers[change[1]!.toLowerCase()] ?? change[1]}: ${change[2]}`;
  const remove = /^remove (?:item )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)$/i.exec(command);
  if (remove) return `remove ${numbers[remove[1]!.toLowerCase()] ?? remove[1]}`;
  return command;
}
