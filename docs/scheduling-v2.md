# CrewPlan scheduling v2

## Goal

Generate a deterministic weekly schedule from employee availability, skills,
working-hour limits, existing shifts, and project staffing requirements. A
generation request only creates a preview. Persisting assignments is a separate,
transactional operation.

## Time model

- A scheduling period is one ISO week starting on Monday.
- Recurring availability and project requirements use a day of week and minutes
  from midnight (`0..1440`).
- Generated assignments are converted to UTC timestamps at the API boundary.
- Overnight requirements are represented as two requirements. The initial v2
  solver does not accept a recurring interval that crosses midnight.

## Hard constraints

A generated assignment is valid only when all of these conditions hold:

1. The employee is available for the complete requirement interval.
2. The employee has the required skill at or above the minimum level, when a
   skill is required.
3. The assignment does not overlap an existing or proposed shift.
4. The employee does not exceed `maxWeeklyMinutes`.
5. One employee fills at most one position in a staffing requirement.

The solver never returns an assignment that violates a hard constraint.

## Soft constraints and scoring

The solver minimizes penalty. The initial weights are deliberately explicit and
may be changed after measuring demo scenarios.

| Condition | Penalty |
| --- | ---: |
| Unfilled critical position | 10,000 |
| Unfilled high-priority position | 5,000 |
| Unfilled normal position | 1,000 |
| Unfilled low-priority position | 500 |
| Minute above an employee's preferred weekly limit | 2 |
| Workload imbalance between employees | 1 per 10 minutes |

Priority affects which requirement remains unfilled; it never permits a hard
constraint violation.

## Determinism

The same normalized input must return the same assignments, explanations, and
score. Candidate and requirement ordering therefore use stable numeric/string
tie-breakers. Random selection is forbidden in v2.

## Generation API

`POST /api/schedule/generate`

```json
{
  "weekStart": "2026-08-10",
  "replaceExisting": false
}
```

The date must be a Monday. Generation does not mutate the database.

```json
{
  "previewId": "opaque-content-hash",
  "inputVersion": "opaque-content-hash",
  "assignments": [],
  "unfilledRequirements": [],
  "metrics": {
    "coveragePercent": 92,
    "assignedMinutes": 18960,
    "unfilledPositions": 3,
    "hardConflicts": 0,
    "penalty": 7000
  }
}
```

Each unfilled requirement includes candidate rejection counts for unavailable,
missing-skill, overlap, and weekly-limit reasons.

## Apply API

`POST /api/schedule/apply`

```json
{
  "previewId": "opaque-content-hash",
  "inputVersion": "opaque-content-hash",
  "weekStart": "2026-08-10",
  "replaceExisting": false,
  "assignments": []
}
```

Apply recomputes the input version and validates every assignment. A stale
preview returns `409 SCHEDULE_PREVIEW_STALE`. All shift writes occur in a single
database transaction. Any failure rolls the complete operation back.

## Initial performance boundary

The portfolio release targets one week, up to 50 employees, 100 requirements,
and 300 individual staffing positions. The API must enforce these limits rather
than silently becoming unresponsive.
