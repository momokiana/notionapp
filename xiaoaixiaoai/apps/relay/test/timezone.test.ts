import { test } from "node:test";
import assert from "node:assert/strict";
import { clockTime, spokenTime } from "../src/assistant/speech.ts";
import { setTimeZone, timeZone, utcOffset, zoneLabel, zoneName } from "../src/assistant/timezone.ts";
import { loadModelSetup } from "../src/config.ts";

const FRI_EVENING_BEIJING = Date.parse("2026-11-13T20:20:00+08:00");
const SAT_NIGHT_BEIJING = Date.parse("2026-11-14T02:05:00+08:00");

test("the default zone is Beijing, worded as before", () => {
  assert.equal(timeZone(), "Asia/Shanghai");
  assert.equal(spokenTime(FRI_EVENING_BEIJING), "周五晚上八点二十");
  assert.equal(clockTime(FRI_EVENING_BEIJING), "周五 20:20");
  assert.equal(zoneName(), "北京时间");
  assert.equal(zoneLabel(FRI_EVENING_BEIJING), "北京时间");
});

test("another zone: its own clock and weekday, daylight saving, and the offset the model needs for reminders", () => {
  // The same moments seen from Berlin (UTC+1 in November): the weekday rolls back across midnight.
  assert.equal(spokenTime(FRI_EVENING_BEIJING, "Europe/Berlin"), "周五下午一点二十");
  assert.equal(spokenTime(SAT_NIGHT_BEIJING, "Europe/Berlin"), "周五晚上七点零五");
  assert.equal(clockTime(SAT_NIGHT_BEIJING, "Europe/Berlin"), "周五 19:05");
  assert.equal(spokenTime(FRI_EVENING_BEIJING, "America/New_York"), "周五早上七点二十");
  assert.equal(utcOffset(FRI_EVENING_BEIJING, "Europe/Berlin"), "+01:00");
  assert.equal(utcOffset(Date.parse("2026-07-01T12:00:00Z"), "Europe/Berlin"), "+02:00");
  assert.equal(utcOffset(FRI_EVENING_BEIJING, "Asia/Kolkata"), "+05:30");
  assert.equal(utcOffset(FRI_EVENING_BEIJING, "UTC"), "+00:00");
  assert.equal(zoneName("Europe/Berlin"), "当地时间");
  assert.equal(zoneLabel(FRI_EVENING_BEIJING, "Europe/Berlin"), "当地时间，UTC+01:00，写带时区的时间就用它");

  // Set for the whole relay, the helpers follow it.
  setTimeZone("europe/berlin");
  try {
    assert.equal(timeZone(), "Europe/Berlin");
    assert.equal(spokenTime(FRI_EVENING_BEIJING), "周五下午一点二十");
    assert.match(zoneLabel(FRI_EVENING_BEIJING), /^当地时间，UTC\+01:00/);
  } finally {
    setTimeZone("Asia/Shanghai");
  }
  assert.throws(() => setTimeZone("Mars/Olympus"), RangeError);
  assert.equal(timeZone(), "Asia/Shanghai");
});

test("POCKET_TIMEZONE: an IANA name, the file's timeZone, or the Beijing default with a warning", () => {
  assert.equal(loadModelSetup({}).timeZone, "Asia/Shanghai");
  assert.equal(loadModelSetup({ POCKET_TIMEZONE: "Europe/Berlin" }).timeZone, "Europe/Berlin");
  assert.equal(loadModelSetup({ POCKET_CONFIG: "/x.json" }, () => JSON.stringify({ timeZone: "America/New_York" })).timeZone, "America/New_York");
  const bad = loadModelSetup({ POCKET_TIMEZONE: "Beijing" });
  assert.equal(bad.timeZone, "Asia/Shanghai");
  assert.ok(bad.warnings.some((w) => /POCKET_TIMEZONE "Beijing" is not a time zone/.test(w)));
});
