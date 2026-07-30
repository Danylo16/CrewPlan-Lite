# CrewPlan Lite

[![CI](https://github.com/Danylo16/CrewPlan-Lite/actions/workflows/ci.yml/badge.svg)](https://github.com/Danylo16/CrewPlan-Lite/actions/workflows/ci.yml)

A full-stack workforce scheduling application for managing employees, projects, and weekly shift assignments.

CrewPlan prevents overlapping employee shifts, visualizes projects with distinct colors, and integrates Austrian public holidays into the weekly schedule.

![CrewPlan weekly schedule](docs/image.png)

## Features

- Weekly workforce calendar
- Employee and project management
- Color-coded project assignments
- Server-side shift conflict detection
- Support for shifts spanning multiple dates
- Austrian public holiday integration
- Input validation and structured API errors
- PostgreSQL persistence
- Automated API and business-rule tests

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
GET  /api/projects
POST /api/projects
```

### Shifts

```http
GET  /api/shifts?from=<ISO_DATE>&to=<ISO_DATE>
POST /api/shifts
```

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
git clone https://github.com/Danylo16/crewplan-lite.git
cd crewplan-lite
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
- Invalid shift input
- Invalid time ranges
- Overlapping shifts
- Adjacent shifts

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

- Editing and deleting shifts
- Authentication and role-based access
- Employee availability rules
- Filtering by employee or project
- Dedicated handling for overnight shifts
- End-to-end browser tests