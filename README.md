# CrewPlan Lite

[![CI](https://github.com/Danylo16/CrewPlan-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/Danylo16/CrewPlan-Lite/actions/workflows/ci.yml)

A full-stack project portfolio capacity planner for turning project scope into feasible multi-week staffing plans.

CrewPlan combines project lifecycle, work-package dependencies, employee skills, availability, labor cost, recurring fixed coverage and actual progress in one rolling-horizon planning workflow.

![CrewPlan weekly schedule](docs/image.png)

## Live Demo

- [Open CrewPlan Lite](https://crew-plan-lite.vercel.app/)
- [API health check](https://crewplan-lite.onrender.com/api/health)

> The API is hosted on a free Render instance and may require up to one minute to wake up after inactivity.

## Features

- Multi-week rolling-horizon portfolio planning with preview/apply safety
- Immutable planning history with versioned optimizer evidence and allocation provenance
- Weekly capacity, utilization, cost, budget and deadline diagnostics
- Project lifecycle, priorities, deadlines and optimization strategies
- Work packages with remaining hours, skill levels, dependencies and parallelism
- Actual work logs kept separate from planned allocations
- Fixed coverage for recurring time-specific staffing commitments
- Weekly workforce calendar with week navigation
- Employee profiles with skills, availability, capacity, cost and overtime
- Create, edit, and delete manual shift assignments; solver allocations remain planner-managed
- Filter schedule by employee and project
- Color-coded project assignments
- Server-side conflict detection during shift creation and editing
- Adjacent shift support
- Overnight and multi-date shifts
- Austrian public holiday integration with graceful failure handling
- Input validation and structured API errors
- PostgreSQL persistence through Prisma ORM
- Automated API and business-rule tests
- Continuous integration with GitHub Actions

## Tech Stack

### Frontend

- React
- TypeScript
- Vite
- React Router
- CSS

### Backend

- Node.js
- Express
- TypeScript
- Zod
- Prisma ORM
- PostgreSQL

### Infrastructure and testing

- Neon PostgreSQL
- Vitest
- Supertest
- OpenHolidays API

## Architecture

```text
React frontend
      |
      | REST / JSON
      v
Express API
      |
      +---- Prisma ORM ---- PostgreSQL
      |
      +---- OpenHolidays API
```

The frontend never connects directly to the database or external holiday service. All data access and business rules are handled by the Express backend.

## Shift Conflict Detection

Two shifts overlap when:

```text
newStart < existingEnd
AND
newEnd > existingStart
```

Adjacent shifts are allowed. For example, `09:00–13:00` and `13:00–17:00` do not overlap.

Conflict validation is performed on the server rather than relying on the user interface.

## API Endpoints

### Employees

```http
GET  /api/employees
POST /api/employees
```

### Projects

```http
GET    /api/projects
GET    /api/projects/:id
POST   /api/projects
PATCH  /api/projects/:id
POST   /api/projects/:id/transition
DELETE /api/projects/:id
```

### Portfolio planner

```http
POST /api/portfolio-plan/preview
POST /api/portfolio-plan/scenarios
POST /api/portfolio-plan/resilience
POST /api/portfolio-plan/apply
GET  /api/portfolio-plan/runs
GET  /api/portfolio-plan/runs/:id
```

Portfolio decision responses are marked `Cache-Control: no-store` and include
`X-Request-Id` plus `Server-Timing` diagnostics. Apply and resilience requests
revalidate the submitted `previewId` and `inputVersion`. A stale decision returns
`409 PORTFOLIO_PREVIEW_STALE` with `recovery: REGENERATE_PREVIEW`; the frontend
discards the obsolete preview instead of allowing it to be applied.

### Work packages and actual work

```http
POST   /api/projects/:id/work-packages
PATCH  /api/work-packages/:id
PUT    /api/work-packages/:id/dependencies
DELETE /api/work-packages/:id

GET  /api/work-logs
POST /api/work-logs
POST /api/work-logs/:id/confirm
POST /api/work-logs/:id/void
```

### Shifts

```http
GET    /api/shifts?from=<ISO_DATE>&to=<ISO_DATE>
POST   /api/shifts
PATCH  /api/shifts/:id
DELETE /api/shifts/:id
```

`PATCH` and `DELETE` reject solver-generated or planning-run shifts with
`409 PLANNER_MANAGED_SHIFT`. Generated allocations must be replaced through the
Portfolio Planner so a direct edit cannot invalidate the accepted plan.

### Public holidays

```http
GET /api/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
```

### Health check

```http
GET /api/health
```

## Local Setup

### Requirements

- Node.js 20+
- Yarn 1.x
- PostgreSQL database or Neon account

### 1. Clone the repository

```bash
git clone https://github.com/Danylo16/CrewPlan-Lite.git
cd CrewPlan-Lite
```

### 2. Install frontend dependencies

```bash
yarn install
```

### 3. Install backend dependencies

```bash
cd server
yarn install
```

### 4. Configure backend environment

Copy:

```text
server/.env.example
```

to:

```text
server/.env
```

Set the PostgreSQL connection string:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
PORT=3000
```

### 5. Apply database migrations

```bash
yarn prisma migrate deploy
yarn prisma generate
```

### 6. Start the backend

From the server directory:

```bash
yarn dev
```

The API runs at:

```text
http://localhost:3000
```

### 7. Start the frontend

From the repository root:

```bash
yarn dev
```

The application runs at:

```text
http://localhost:5173
```

## Testing

Run backend tests:

```bash
cd server
yarn test
```

The test suite covers:

- API health status
- Shift conflicts, timezone conversion and fixed-coverage scheduling
- Project lifecycle and archive/delete safety
- Work-package dependency enforcement and actual-progress accounting
- Deterministic multi-week planning and hard deadlines
- Stale-preview protection and transactional plan application
- Preservation of manual and historical shifts during replanning

Type-check the backend:

```bash
yarn tsc --noEmit
```
Tests and production builds are also executed automatically by GitHub Actions on every push and pull request to `main`.

## Reproducible portfolio evidence

After loading the V2 demo dataset and starting the API, generate the article
evidence bundle with:

```bash
cd server
yarn evidence:portfolio
```

The command runs the same Compare strategies request at least five times,
computes min/p50/p95/max timing, verifies deterministic signatures and the
cost/deadline and cost/resilience trade-offs, performs full review and N−1
analysis for Balanced and Resilience First, and writes JSON plus Markdown under
`artifacts/`. It exits with a failure code when an acceptance gate fails. See
[`docs/portfolio-evidence.md`](docs/portfolio-evidence.md) for parameters and
the evidence contract.

## Production Build

Frontend:

```bash
yarn build
```

Backend:

```bash
cd server
yarn build
yarn start
```

## Project Structure

```text
crewplan-lite/
├── src/
│   ├── api/
│   ├── components/
│   ├── pages/
│   └── types/
├── server/
│   ├── prisma/
│   ├── src/
│   │   ├── lib/
│   │   └── routes/
│   └── tests/
└── docs/
```

## Future Improvements

- Authentication and role-based access
- Employee availability and working-hour limits
- Drag-and-drop shift rescheduling
- Improved visualization of overnight shifts across multiple calendar days
- End-to-end browser tests
- Audit history for schedule changes
