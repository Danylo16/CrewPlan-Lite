import type {
  RejectionReason,
  ScheduledInterval,
  SchedulingEmployee,
  StaffingSlot,
} from "./types.js";

export function intervalsOverlap(
  first: ScheduledInterval,
  second: ScheduledInterval,
) {
  return first.dayOfWeek === second.dayOfWeek
    && first.startMinute < second.endMinute
    && first.endMinute > second.startMinute;
}

export function getRejectionReason(
  employee: SchedulingEmployee,
  slot: StaffingSlot,
  scheduledIntervals: ScheduledInterval[],
  weeklyMinutes: number,
): RejectionReason | null {
  const isAvailable = employee.availability.some((availability) =>
    availability.dayOfWeek === slot.dayOfWeek
      && availability.startMinute <= slot.startMinute
      && availability.endMinute >= slot.endMinute,
  );

  if (!isAvailable) {
    return "NOT_AVAILABLE";
  }

  if (slot.requiredSkillId !== null) {
    const hasRequiredSkill = employee.skills.some((skill) =>
      skill.skillId === slot.requiredSkillId
        && skill.level >= slot.minimumSkillLevel,
    );

    if (!hasRequiredSkill) {
      return "MISSING_SKILL";
    }
  }

  if (scheduledIntervals.some((interval) => intervalsOverlap(interval, slot))) {
    return "OVERLAP";
  }

  if (weeklyMinutes + slot.durationMinutes > employee.maxWeeklyMinutes) {
    return "WEEKLY_LIMIT";
  }

  return null;
}
