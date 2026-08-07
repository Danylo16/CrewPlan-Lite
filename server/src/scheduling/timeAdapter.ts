import { DateTime } from "luxon";
import { DAYS_OF_WEEK } from "./types.js";
import type {
  DayOfWeek,
  ExistingShiftInput,
} from "./types.js";

export const SCHEDULE_TIME_ZONE = "Europe/Vienna";

interface StoredShift {
  employeeId: number;
  projectId: number;
  startAt: Date;
  endAt: Date;
}

export interface UtcInterval {
  startAt: Date;
  endAt: Date;
}

export function parseWeekStart(
  value: string,
  zone = SCHEDULE_TIME_ZONE,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("WEEK_START_INVALID");
  }

  const weekStart = DateTime.fromISO(value, { zone }).startOf("day");

  if (!weekStart.isValid || weekStart.toISODate() !== value) {
    throw new Error("WEEK_START_INVALID");
  }

  if (weekStart.weekday !== 1) {
    throw new Error("WEEK_START_NOT_MONDAY");
  }

  return weekStart;
}

export function getWeekWindowUtc(
  weekStart: DateTime,
): UtcInterval {
  return {
    startAt: weekStart.toUTC().toJSDate(),
    endAt: weekStart
      .plus({ days: 7 })
      .toUTC()
      .toJSDate(),
  };
}

function localTimeAtMinute(
  dayStart: DateTime,
  minute: number,
) {
  if (
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 1440
  ) {
    throw new Error("MINUTE_OUT_OF_RANGE");
  }

  if (minute === 1440) {
    return dayStart
      .plus({ days: 1 })
      .startOf("day");
  }

  const hour = Math.floor(minute / 60);
  const minuteOfHour = minute % 60;

  const result = dayStart.set({
    hour,
    minute: minuteOfHour,
    second: 0,
    millisecond: 0,
  });

  
  if (
    result.hour !== hour ||
    result.minute !== minuteOfHour
  ) {
    throw new Error("LOCAL_TIME_DOES_NOT_EXIST");
  }

  return result;
}

export function scheduleIntervalToUtc(
  weekStart: DateTime,
  dayOfWeek: DayOfWeek,
  startMinute: number,
  endMinute: number,
): UtcInterval {
  const dayIndex = DAYS_OF_WEEK.indexOf(dayOfWeek);

  if (dayIndex === -1 || startMinute >= endMinute) {
    throw new Error("SCHEDULE_INTERVAL_INVALID");
  }

  const dayStart = weekStart
    .plus({ days: dayIndex })
    .startOf("day");

  return {
    startAt: localTimeAtMinute(
      dayStart,
      startMinute,
    )
      .toUTC()
      .toJSDate(),

    endAt: localTimeAtMinute(
      dayStart,
      endMinute,
    )
      .toUTC()
      .toJSDate(),
  };
}

function floorWallMinute(date: DateTime) {
  return date.hour * 60 + date.minute;
}

function ceilWallMinute(date: DateTime) {
  const minute = floorWallMinute(date);

  return date.second > 0 || date.millisecond > 0
    ? minute + 1
    : minute;
}

export function splitExistingShiftIntoDays(
  shift: StoredShift,
  weekStart: DateTime,
  zone = SCHEDULE_TIME_ZONE,
): ExistingShiftInput[] {
  const weekEnd = weekStart.plus({ days: 7 });

  const shiftStart = DateTime
    .fromJSDate(shift.startAt, { zone: "utc" })
    .setZone(zone);

  const shiftEnd = DateTime
    .fromJSDate(shift.endAt, { zone: "utc" })
    .setZone(zone);

  if (
    !shiftStart.isValid ||
    !shiftEnd.isValid ||
    shiftEnd <= shiftStart
  ) {
    throw new Error("STORED_SHIFT_INVALID");
  }

  let cursor = DateTime.max(
    shiftStart,
    weekStart,
  );

  const clampedEnd = DateTime.min(
    shiftEnd,
    weekEnd,
  );

  const result: ExistingShiftInput[] = [];

  while (cursor < clampedEnd) {
    const dayStart = cursor.startOf("day");

    const nextDayStart = dayStart
      .plus({ days: 1 })
      .startOf("day");

    const segmentEnd = DateTime.min(
      clampedEnd,
      nextDayStart,
    );

    const dayOfWeek =
      DAYS_OF_WEEK[dayStart.weekday - 1];

    if (!dayOfWeek) {
      throw new Error("STORED_SHIFT_DAY_INVALID");
    }

    result.push({
      employeeId: shift.employeeId,
      projectId: shift.projectId,
      dayOfWeek,

      startMinute: cursor.hasSame(dayStart, "day")
        ? floorWallMinute(cursor)
        : 0,

      endMinute: segmentEnd.equals(nextDayStart)
        ? 1440
        : ceilWallMinute(segmentEnd),
    });

    cursor = segmentEnd;
  }

  return result;
}