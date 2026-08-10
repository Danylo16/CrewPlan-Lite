import { getRejectionReason } from "./constraints.js";
import {
  allocationCostBreakdown,
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
  unfilledByPriority: Record<StaffingSlot["priority"], number>;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
}

interface ObjectiveScore {
  unfilledCritical: number;
  unfilledHigh: number;
  unfilledNormal: number;
  unfilledLow: number;
  overtimeMinutes: number;
  overtimeCostCents: number;
  laborCostCents: number;
  workloadImbalance: number;
}

interface SearchBest {
  assignments: ProposedAssignment[];
  unfilledSlots: StaffingSlot[];
  weeklyMinutes: Map<number, number>;
  penalty: number;
  score: ObjectiveScore;
  regularMinutes: number;
  overtimeMinutes: number;
  regularCostCents: number;
  overtimeCostCents: number;
}

const objectiveKeys: Array<keyof ObjectiveScore> = [
  "unfilledCritical",
  "unfilledHigh",
  "unfilledNormal",
  "unfilledLow",
  "overtimeMinutes",
  "overtimeCostCents",
  "laborCostCents",
  "workloadImbalance",
];

function compareObjective(first: ObjectiveScore, second: ObjectiveScore) {
  for (const key of objectiveKeys) {
    const difference = first[key] - second[key];
    if (difference !== 0) return difference;
  }
  return 0;
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
    unfilledByPriority: { CRITICAL: 0, HIGH: 0, NORMAL: 0, LOW: 0 },
    regularMinutes: 0,
    overtimeMinutes: 0,
    regularCostCents: 0,
    overtimeCostCents: 0,
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
    unfilledByPriority: { ...state.unfilledByPriority },
    regularMinutes: state.regularMinutes,
    overtimeMinutes: state.overtimeMinutes,
    regularCostCents: state.regularCostCents,
    overtimeCostCents: state.overtimeCostCents,
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
  const cost = allocationCostBreakdown(
    employee,
    previousMinutes,
    slot.durationMinutes,
  );
  state.regularMinutes += cost.regularMinutes;
  state.overtimeMinutes += cost.overtimeMinutes;
  state.regularCostCents += cost.regularCostCents;
  state.overtimeCostCents += cost.overtimeCostCents;
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
  state.unfilledByPriority[slot.priority] += 1;
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
      const firstCost = allocationCostBreakdown(
        first,
        firstMinutes,
        slot.durationMinutes,
      );
      const secondCost = allocationCostBreakdown(
        second,
        secondMinutes,
        slot.durationMinutes,
      );

      return firstPenalty - secondPenalty
        || firstCost.overtimeMinutes - secondCost.overtimeMinutes
        || firstCost.overtimeCostCents - secondCost.overtimeCostCents
        || firstCost.totalCostCents - secondCost.totalCostCents
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

function objectiveScore(
  employees: SchedulingEmployee[],
  state: SearchState,
  includeImbalance = true,
): ObjectiveScore {
  return {
    unfilledCritical: state.unfilledByPriority.CRITICAL,
    unfilledHigh: state.unfilledByPriority.HIGH,
    unfilledNormal: state.unfilledByPriority.NORMAL,
    unfilledLow: state.unfilledByPriority.LOW,
    overtimeMinutes: state.overtimeMinutes,
    overtimeCostCents: state.overtimeCostCents,
    laborCostCents: state.regularCostCents + state.overtimeCostCents,
    workloadImbalance: includeImbalance
      ? workloadImbalancePenalty(employees, state.weeklyMinutes)
      : 0,
  };
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
    score: objectiveScore(employees, greedy),
    regularMinutes: greedy.regularMinutes,
    overtimeMinutes: greedy.overtimeMinutes,
    regularCostCents: greedy.regularCostCents,
    overtimeCostCents: greedy.overtimeCostCents,
  };

  function search(slotIndex: number, state: SearchState) {
    if (exploredNodes >= maxSearchNodes) {
      searchLimitReached = true;
      return;
    }

    exploredNodes += 1;

    if (compareObjective(
      objectiveScore(employees, state, false),
      { ...best.score, workloadImbalance: 0 },
    ) >= 0) {
      return;
    }

    if (slotIndex === slots.length) {
      const penalty = totalPenalty(employees, state);
      const score = objectiveScore(employees, state);
      if (compareObjective(score, best.score) < 0) {
        best = {
          assignments: [...state.assignments],
          unfilledSlots: [...state.unfilledSlots],
          weeklyMinutes: new Map(state.weeklyMinutes),
          penalty,
          score,
          regularMinutes: state.regularMinutes,
          overtimeMinutes: state.overtimeMinutes,
          regularCostCents: state.regularCostCents,
          overtimeCostCents: state.overtimeCostCents,
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
      existingPositions: 0,
      proposedPositions: assignedPositions,
      unfilledPositions: unfilledPositions.length,
      coveragePercent: requestedPositions === 0
        ? 100
        : Math.round((assignedPositions / requestedPositions) * 10_000) / 100,
      assignedMinutes: best.assignments.reduce(
        (total, assignment) =>
          total + assignment.endMinute - assignment.startMinute,
        0,
      ),
      regularMinutes: best.regularMinutes,
      overtimeMinutes: best.overtimeMinutes,
      regularCostCents: best.regularCostCents,
      overtimeCostCents: best.overtimeCostCents,
      laborCostCents: best.regularCostCents + best.overtimeCostCents,
      penalty: best.penalty,
      exploredNodes,
      searchLimitReached,
      hardConflicts: 0,
    },
  };
}
