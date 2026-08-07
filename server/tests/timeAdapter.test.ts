import { describe, expect, it } from "vitest";
import {
  getWeekWindowUtc,
  parseWeekStart,
  scheduleIntervalToUtc,
  splitExistingShiftIntoDays,
} from "../src/scheduling/timeAdapter.js";

describe("schedule time adapter", () => {
  it("accepts an ISO Monday and rejects other days", () => {
    expect(
      parseWeekStart("2026-08-10").weekday,
    ).toBe(1);

    expect(() =>
      parseWeekStart("2026-08-11"),
    ).toThrowError("WEEK_START_NOT_MONDAY");

    expect(() =>
      parseWeekStart("not-a-date"),
    ).toThrowError("WEEK_START_INVALID");
  });

  it("converts a summer Vienna interval to UTC", () => {
    const interval = scheduleIntervalToUtc(
      parseWeekStart("2026-08-10"),
      "MONDAY",
      540,
      1020,
    );

    expect(interval.startAt.toISOString()).toBe(
      "2026-08-10T07:00:00.000Z",
    );

    expect(interval.endAt.toISOString()).toBe(
      "2026-08-10T15:00:00.000Z",
    );
  });

  it("uses the winter Vienna offset", () => {
    const interval = scheduleIntervalToUtc(
      parseWeekStart("2026-12-07"),
      "MONDAY",
      540,
      1020,
    );

    expect(interval.startAt.toISOString()).toBe(
      "2026-12-07T08:00:00.000Z",
    );

    expect(interval.endAt.toISOString()).toBe(
      "2026-12-07T16:00:00.000Z",
    );
  });

  it("builds a DST-aware UTC week window", () => {
    const window = getWeekWindowUtc(
      parseWeekStart("2026-03-23"),
    );

    expect(window.startAt.toISOString()).toBe(
      "2026-03-22T23:00:00.000Z",
    );

    expect(window.endAt.toISOString()).toBe(
      "2026-03-29T22:00:00.000Z",
    );
  });

  it("splits an overnight shift into daily solver intervals", () => {
    const intervals = splitExistingShiftIntoDays(
      {
        employeeId: 1,
        projectId: 2,
        startAt: new Date(
          "2026-08-10T20:00:00.000Z",
        ),
        endAt: new Date(
          "2026-08-11T04:00:00.000Z",
        ),
      },
      parseWeekStart("2026-08-10"),
    );

    expect(intervals).toEqual([
      {
        employeeId: 1,
        projectId: 2,
        dayOfWeek: "MONDAY",
        startMinute: 1320,
        endMinute: 1440,
      },
      {
        employeeId: 1,
        projectId: 2,
        dayOfWeek: "TUESDAY",
        startMinute: 0,
        endMinute: 360,
      },
    ]);
  });

  it("clamps shifts to the requested week", () => {
    const intervals = splitExistingShiftIntoDays(
      {
        employeeId: 1,
        projectId: 2,
        startAt: new Date(
          "2026-08-09T20:00:00.000Z",
        ),
        endAt: new Date(
          "2026-08-10T08:00:00.000Z",
        ),
      },
      parseWeekStart("2026-08-10"),
    );

    expect(intervals).toEqual([
      {
        employeeId: 1,
        projectId: 2,
        dayOfWeek: "MONDAY",
        startMinute: 0,
        endMinute: 600,
      },
    ]);
  });
});