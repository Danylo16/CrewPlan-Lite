import express from "express";
import cors from "cors";
import { employeeRouter } from "./routes/employees.js";
import { holidayRouter } from "./routes/holidays.js";
import { projectRouter } from "./routes/projects.js";
import { shiftRouter } from "./routes/shifts.js";
import { skillRouter } from "./routes/skills.js";
import { projectRequirementRouter } from "./routes/projectRequirements.js";
import { scheduleRouter } from "./routes/schedule.js";
import {
  projectWorkPackageRouter,
  workPackageRouter,
} from "./routes/workPackages.js";
import { workLogRouter } from "./routes/workLogs.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/employees", employeeRouter);
app.use("/api/projects", projectRouter);
app.use("/api/shifts", shiftRouter);
app.use("/api/holidays", holidayRouter);
app.use("/api/skills", skillRouter);
app.use("/api/project-requirements", projectRequirementRouter);
app.use("/api/schedule", scheduleRouter);
app.use("/api/projects/:projectId/work-packages", projectWorkPackageRouter);
app.use("/api/work-packages", workPackageRouter);
app.use("/api/work-logs", workLogRouter);

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    message: "CrewPlan API is running",
  });
});

app.get("/api/version", (_request, response) => {
  const commit = process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT_SHA ?? "local";
  response.json({
    service: "crewplan-api",
    commit: commit === "local" ? commit : commit.slice(0, 7),
    environment: process.env.NODE_ENV ?? "development",
  });
});
