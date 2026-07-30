import express from "express";
import cors from "cors";
import { employeeRouter } from "./routes/employees.js";
import { holidayRouter } from "./routes/holidays.js";
import { projectRouter } from "./routes/projects.js";
import { shiftRouter } from "./routes/shifts.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/employees", employeeRouter);
app.use("/api/projects", projectRouter);
app.use("/api/shifts", shiftRouter);
app.use("/api/holidays", holidayRouter);

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    message: "CrewPlan API is running",
  });
});