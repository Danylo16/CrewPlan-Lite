# Portfolio evidence workflow

CrewPlan claims deterministic, bounded multi-objective search. It does not
claim a globally optimal schedule. The evidence workflow makes that limited
claim reproducible against the V2 dataset.

## Prerequisites

1. Apply database migrations and load the V2 demo dataset.
2. Start the API from `server/`.
3. Keep portfolio inputs unchanged for the complete evidence run.

## Run

From `server/`:

```bash
yarn evidence:portfolio
```

Defaults:

- API: `http://localhost:3000/api`
- horizon start: `2026-08-17`
- horizon: 6 weeks
- Compare strategies repetitions: 5
- output: repository-level `artifacts/`

Every value can be explicit:

```bash
yarn evidence:portfolio \
  --api=http://localhost:3000/api \
  --horizon-start=2026-08-17 \
  --horizon-weeks=6 \
  --repeats=5 \
  --output=../artifacts
```

Environment variable equivalents are `CREWPLAN_API_URL`,
`EVIDENCE_HORIZON_START`, `EVIDENCE_HORIZON_WEEKS`, `EVIDENCE_REPEATS`, and
`EVIDENCE_OUTPUT_DIR`.

## Outputs

- `portfolio-evidence.json` is the machine-readable source for tables and
  charts.
- `portfolio-evidence.md` is the reviewable article appendix.

Both files contain the API commit, environment, dataset version, horizon,
request correlation IDs, timing distribution, deterministic signature,
shortlist outcomes, full-review deltas, N−1 outcomes and every acceptance gate.
Compare timing is split into pre-optimizer database/input preparation, optimizer,
and post-optimizer result assembly. The API opens its database connection before
it starts listening, so the first measured request does not pay connection
initialization hidden inside the planning endpoint.

## Merge and article gates

The command fails unless:

- at least five Compare strategies runs were measured;
- every Compare strategies HTTP request finished in under 10 seconds;
- every run produced the same scenario signature;
- all four shortlist searches completed with full coverage and a non-trivial
  candidate pool;
- cost/deadline and cost/resilience trade-offs remain visible;
- Balanced and Resilience First full reviews complete without unplanned scope;
- their full-review resilience trade-off remains visible;
- both N−1 runs finish in under 20 seconds and test every scheduled employee.

`recoverableAbsences` is recorded but deliberately is not a pass/fail gate. A
fragile portfolio is a valid business finding, not an algorithm failure.
