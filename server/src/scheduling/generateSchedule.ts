import { getRejectionReason } from "./constraints.js";
import {
  preferredOvertimePenalty,
  UNFILLED_PENALTY,
  workloadImbalancePenalty,
} from "./scoring.js";
import { DAYS_OF_WEEK } from "./types.js";
import type {
  ProposedAssignment,
  RejectionReason,
  ScheduledInterval,
  SchedulingEmployee,
  SchedulingInput,
  SchedulingResult,
  StaffingSlot,
  UnfilledPosition,
} from "./types.js";

const DEFAULT_MAX_SEARCH_NODES = 50_000;

const priorityRank = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
} as const;

interface SearchState {
  assignments: ProposedAssignment[];
  unfilledSlots: StaffingSlot[];
  weeklyMinutes: Map<number, number>;
  intervals: Map<number, ScheduledInterval[]>;
  basePenalty: number;
}

interface SearchBest {
  assignments: ProposedAssignment[];
  unfilledSlots: StaffingSlot[];
  weeklyMinutes: Map<number, number>;
  penalty: number;
}

function compareSlots(first: StaffingSlot, second: StaffingSlot) {
  return priorityRank[first.priority] - priorityRank[second.priority]
    || Number(second.requiredSkillId !== null) - Number(first.requiredSkillId !== null)
    || first.dayOfWeek.localeCompare(second.dayOfWeek)
    || first.startMinute - second.startMinute
    || first.id - second.id
    || first.positionIndex - second.positionIndex;
}

function expandRequirements(input: SchedulingInput): StaffingSlot[] {
  return input.requirements
    .flatMap((requirement) =>
      Array.from({ length: requirement.requiredEmployees }, (_, positionIndex) => ({
        ...requirement,
        positionIndex,
        durationMinutes: requirement.endMinute - requirement.startMinute,
      })),
    )
    .sort(compareSlots);
}

function createInitialState(
  employees: SchedulingEmployee[],
  input: SchedulingInput,
): SearchState {
  const weeklyMinutes = new Map<number, number>(
    employees.map((employee) => [employee.id, 0]),
  );
  const intervals = new Map<number, ScheduledInterval[]>(
    employees.map((employee) => [employee.id, []]),
  );

  for (const shift of input.existingShifts) {
    if (!weeklyMinutes.has(shift.employeeId)) {
      continue;
    }

    const duration = shift.endMinute - shift.startMinute;
    weeklyMinutes.set(
      shift.employeeId,
      (weeklyMinutes.get(shift.employeeId) ?? 0) + duration,
    );
    intervals.get(shift.employeeId)?.push({
      dayOfWeek: shift.dayOfWeek,
      startMinute: shift.startMinute,
      endMinute: shift.endMinute,
    });
  }

  return {
    assignments: [],
    unfilledSlots: [],
    weeklyMinutes,
    intervals,
    basePenalty: 0,
  };
}

function cloneState(state: SearchState): SearchState {
  return {
    assignments: [...state.assignments],
    unfilledSlots: [...state.unfilledSlots],
    weeklyMinutes: new Map(state.weeklyMinutes),
    intervals: new Map(
      [...state.intervals].map(([employeeId, intervals]) => [
        employeeId,
        [...intervals],
      ]),
    ),
    basePenalty: state.basePenalty,
  };
}

function assignSlot(
  state: SearchState,
  employee: SchedulingEmployee,
  slot: StaffingSlot,
) {
  const previousMinutes = state.weeklyMinutes.get(employee.id) ?? 0;
  const nextMinutes = previousMinutes + slot.durationMinutes;

  state.basePenalty += preferredOvertimePenalty(
    employee,
    previousMinutes,
    nextMinutes,
  );
  state.weeklyMinutes.set(employee.id, nextMinutes);
  state.intervals.get(employee.id)?.push(slot);
  state.assignments.push({
    requirementId: slot.id,
    positionIndex: slot.positionIndex,
    employeeId: employee.id,
    projectId: slot.projectId,
    dayOfWeek: slot.dayOfWeek,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
  });
}

function markUnfilled(state: SearchState, slot: StaffingSlot) {
  state.unfilledSlots.push(slot);
  state.basePenalty += UNFILLED_PENALTY[slot.priority];
}

function getCandidates(
  employees: SchedulingEmployee[],
  state: SearchState,
  slot: StaffingSlot,
) {
  return employees
    .filter((employee) => getRejectionReason(
      employee,
      slot,
      state.intervals.get(employee.id) ?? [],
      state.weeklyMinutes.get(employee.id) ?? 0,
    ) === null)
    .sort((first, second) => {
      const firstMinutes = state.weeklyMinutes.get(first.id) ?? 0;
      const secondMinutes = state.weeklyMinutes.get(second.id) ?? 0;
      const firstPenalty = preferredOvertimePenalty(
        first,
        firstMinutes,
        firstMinutes + slot.durationMinutes,
      );
      const secondPenalty = preferredOvertimePenalty(
        second,
        secondMinutes,
        secondMinutes + slot.durationMinutes,
      );

      return firstPenalty - secondPenalty
        || firstMinutes - secondMinutes
        || first.id - second.id;
    });
}

function totalPenalty(
  employees: SchedulingEmployee[],
  state: SearchState,
) {
  return state.basePenalty
    + workloadImbalancePenalty(employees, state.weeklyMinutes);
}

function greedySolution(
  employees: SchedulingEmployee[],
  slots: StaffingSlot[],
  initialState: SearchState,
) {
  const state = cloneState(initialState);

  for (const slot of slots) {
    const candidate = getCandidates(employees, state, slot)[0];

    if (candidate) {
      assignSlot(state, candidate, slot);
    } else {
      markUnfilled(state, slot);
    }
  }

  return state;
}

function buildUnfilledPositions(
  employees: SchedulingEmployee[],
  best: SearchBest,
  existingIntervals: Map<number, ScheduledInterval[]>,
): UnfilledPosition[] {
  const finalIntervals = new Map(
    [...existingIntervals].map(([employeeId, intervals]) => [
      employeeId,
      [...intervals],
    ]),
  );

  for (const assignment of best.assignments) {
    finalIntervals.get(assignment.employeeId)?.push(assignment);
  }

  return best.unfilledSlots.map((slot) => {
    const rejectionCounts: Record<RejectionReason, number> = {
      NOT_AVAILABLE: 0,
      MISSING_SKILL: 0,
      OVERLAP: 0,
      WEEKLY_LIMIT: 0,
    };

    for (const employee of employees) {
      const reason = getRejectionReason(
        employee,
        slot,
        finalIntervals.get(employee.id) ?? [],
        best.weeklyMinutes.get(employee.id) ?? 0,
      );

      if (reason) {
        rejectionCounts[reason] += 1;
      }
    }

    return {
      requirementId: slot.id,
      positionIndex: slot.positionIndex,
      projectId: slot.projectId,
      dayOfWeek: slot.dayOfWeek,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      priority: slot.priority,
      rejectionCounts,
    };
  });
}

export function generateSchedule(input: SchedulingInput): SchedulingResult {
  const employees = [...input.employees].sort((first, second) => first.id - second.id);
  const slots = expandRequirements(input);
  const initialState = createInitialState(employees, input);
  const greedy = greedySolution(employees, slots, initialState);
  const maxSearchNodes = input.maxSearchNodes ?? DEFAULT_MAX_SEARCH_NODES;

  let exploredNodes = 0;
  let searchLimitReached = false;
  let best: SearchBest = {
    assignments: greedy.assignments,
    unfilledSlots: greedy.unfilledSlots,
    weeklyMinutes: greedy.weeklyMinutes,
    penalty: totalPenalty(employees, greedy),
  };

  function search(slotIndex: number, state: SearchState) {
    if (exploredNodes >= maxSearchNodes) {
      searchLimitReached = true;
      return;
    }

    exploredNodes += 1;

    if (state.basePenalty >= best.penalty) {
      return;
    }

    if (slotIndex === slots.length) {
      const penalty = totalPenalty(employees, state);
      if (penalty < best.penalty) {
        best = {
          assignments: [...state.assignments],
          unfilledSlots: [...state.unfilledSlots],
          weeklyMinutes: new Map(state.weeklyMinutes),
          penalty,
        };
      }
      return;
    }

    const slot = slots[slotIndex];
    if (!slot) {
      return;
    }

    for (const candidate of getCandidates(employees, state, slot)) {
      const next = cloneState(state);
      assignSlot(next, candidate, slot);
      search(slotIndex + 1, next);
    }

    const unfilled = cloneState(state);
    markUnfilled(unfilled, slot);
    search(slotIndex + 1, unfilled);
  }

  search(0, cloneState(initialState));

  const existingIntervals = createInitialState(employees, input).intervals;
  const unfilledPositions = buildUnfilledPositions(
    employees,
    best,
    existingIntervals,
  );
  const requestedPositions = slots.length;
  const assignedPositions = best.assignments.length;

  return {
    assignments: [...best.assignments].sort((first, second) =>
      DAYS_OF_WEEK.indexOf(first.dayOfWeek) - DAYS_OF_WEEK.indexOf(second.dayOfWeek)
        || first.startMinute - second.startMinute
        || first.requirementId - second.requirementId
        || first.positionIndex - second.positionIndex,
    ),
    unfilledPositions,
    metrics: {
      requestedPositions,
      assignedPositions,
      unfilledPositions: unfilledPositions.length,
      coveragePercent: requestedPositions === 0
        ? 100
        : Math.round((assignedPositions / requestedPositions) * 10_000) / 100,
      assignedMinutes: best.assignments.reduce(
        (total, assignment) =>
          total + assignment.endMinute - assignment.startMinute,
        0,
      ),
      penalty: best.penalty,
      exploredNodes,
      searchLimitReached,
      hardConflicts: 0,
    },
  };
}
