/**
 * The relay's local time zone (an IANA name such as Asia/Shanghai): what "now",
 * spoken times and reminders are in. Set once at startup from POCKET_TIMEZONE.
 */

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";

let zone = DEFAULT_TIME_ZONE;
const formats = new Map<string, Intl.DateTimeFormat>();

/** The canonical name of a zone Intl knows; null for anything else. */
export function validTimeZone(name: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function setTimeZone(name: string): void {
  const z = validTimeZone(name);
  if (!z) throw new RangeError(`unknown time zone "${name}"`);
  zone = z;
}

export function timeZone(): string {
  return zone;
}

function format(z: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${z}|${key}`;
  let f = formats.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: z, ...opts });
    formats.set(id, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0 = Sunday), hour (0–23) and minute of a moment in a zone. */
export function zonedParts(ts: number, z = zone): { day: number; hour: number; minute: number } {
  const parts = format(z, "parts", { weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: WEEKDAY[get("weekday")] ?? 0, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

/** The zone's offset from UTC at that moment, as ISO 8601 writes it: +08:00, -04:00, +00:00. */
export function utcOffset(ts: number, z = zone): string {
  const name = format(z, "offset", { timeZoneName: "longOffset" })
    .formatToParts(ts)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name ?? "");
  return m ? m[1]! : "+00:00";
}

/** What the times are called for the person: 北京时间 where that is what they are, otherwise 当地时间. */
export function zoneName(z = zone): string {
  return z === DEFAULT_TIME_ZONE ? "北京时间" : "当地时间";
}

/** For the model's "现在" line: away from Beijing it also gets the offset, so the times it writes carry the right one. */
export function zoneLabel(ts: number, z = zone): string {
  return z === DEFAULT_TIME_ZONE ? "北京时间" : `当地时间，UTC${utcOffset(ts, z)}，写带时区的时间就用它`;
}
