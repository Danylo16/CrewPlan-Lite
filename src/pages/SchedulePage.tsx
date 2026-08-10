import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type {
  Employee,
  Holiday,
  Project,
  Shift,
} from "../types";

interface ShiftForm {
  employeeId: string;
  projectId: string;
  startAt: string;
  endAt: string;
  note: string;
}

const SCHEDULE_TIME_ZONE = "Europe/Vienna";

function startOfWeek(date: Date) {
  const result = new Date(date);
  const day = result.getDay();
  const difference = day === 0 ? -6 : 1 - day;

  result.setDate(result.getDate() + difference);
  result.setHours(0, 0, 0, 0);

  return result;
}

function addDays(date: Date, amount: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function toLocalInputValue(date: Date) {
  const parts = scheduleDateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function scheduleInputToUtc(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Invalid allocation date or time");
  }
  const [, year, month, day, hour, minute] = match;
  const localTimestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  let candidate = localTimestamp;

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = scheduleDateTimeParts(new Date(candidate));
    const representedTimestamp = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    candidate -= representedTimestamp - localTimestamp;
  }

  const result = new Date(candidate);
  if (toLocalInputValue(result) !== value) {
    throw new Error("This local time does not exist in Europe/Vienna");
  }

  return result.toISOString();
}

function scheduleDateKey(value: string) {
  const parts = scheduleDateTimeParts(new Date(value));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekBoundaryUtc(date: Date, daysToAdd = 0) {
  return scheduleInputToUtc(`${toDateKey(addDays(date, daysToAdd))}T00:00`);
}

function scheduleDateTimeParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

function createInitialForm(referenceDate = new Date()): ShiftForm {
  const isDateOnlyReference = referenceDate.getHours() === 0
    && referenceDate.getMinutes() === 0
    && referenceDate.getSeconds() === 0;
  const start = isDateOnlyReference
    ? `${toDateKey(referenceDate)}T09:00`
    : toLocalInputValue(referenceDate).replace(/:\d{2}$/, ":00");
  const end = toLocalInputValue(
    new Date(new Date(scheduleInputToUtc(start)).getTime() + 4 * 60 * 60_000),
  );

  return {
    employeeId: "",
    projectId: "",
    startAt: start,
    endAt: end,
    note: "",
  };
}

function formatTime(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SCHEDULE_TIME_ZONE,
  }).format(new Date(date));
}

function allocationLabel(shift: Shift) {
  if (shift.kind === "WORK_PACKAGE") return "Planned work";
  if (shift.kind === "FIXED_COVERAGE") return "Fixed coverage";
  if (shift.origin === "MANUAL") return "Manual allocation";
  return "Legacy allocation";
}

export function AllocationCalendarPage() {
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [holidayWarning, setHolidayWarning] = useState(false);

  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date()),
  );

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [editingShift, setEditingShift] = useState<Shift | null>(
    null,
  );

  const [form, setForm] = useState<ShiftForm>(() =>
    createInitialForm(),
  );

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(weekStart, index),
  );

  const filteredShifts = shifts.filter((shift) => {
    const matchesEmployee =
      !employeeFilter ||
      shift.employeeId === Number(employeeFilter);

    const matchesProject =
      !projectFilter ||
      shift.projectId === Number(projectFilter);

    return matchesEmployee && matchesProject;
  });

  useEffect(() => {
    async function loadSchedule() {
      setIsLoading(true);
      setError(null);
      setHolidayWarning(false);

      try {
        const from = encodeURIComponent(weekBoundaryUtc(weekStart));
        const to = encodeURIComponent(weekBoundaryUtc(weekStart, 7));

        const holidayFrom = toDateKey(weekStart);
        const holidayTo = toDateKey(addDays(weekStart, 6));

        let holidayRequestFailed = false;

        const holidayRequest = apiRequest<Holiday[]>(
          `/holidays?from=${holidayFrom}&to=${holidayTo}`,
        ).catch((holidayError) => {
          console.warn("Holiday service unavailable:", holidayError);
          holidayRequestFailed = true;
          return [] as Holiday[];
        });

        const [
          employeeData,
          projectData,
          shiftData,
          holidayData,
        ] = await Promise.all([
          apiRequest<Employee[]>("/employees"),
          apiRequest<Project[]>("/projects"),
          apiRequest<Shift[]>(
            `/shifts?from=${from}&to=${to}`,
          ),
          holidayRequest,
        ]);

        setEmployees(employeeData);
        setProjects(projectData);
        setShifts(shiftData);
        setHolidays(holidayData);
        setHolidayWarning(holidayRequestFailed);

        setForm((currentForm) => ({
          ...currentForm,
          employeeId:
            currentForm.employeeId ||
            String(employeeData[0]?.id ?? ""),
          projectId:
            currentForm.projectId ||
            String(projectData[0]?.id ?? ""),
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load allocations",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadSchedule();
  }, [weekStart]);

  function resetShiftForm() {
    setForm((currentForm) => ({
      ...createInitialForm(weekStart),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));

    setEditingShift(null);
    setError(null);
  }

  function startEditingShift(shift: Shift) {
    setEditingShift(shift);
    setError(null);

    setForm({
      employeeId: String(shift.employeeId),
      projectId: String(shift.projectId),
      startAt: toLocalInputValue(new Date(shift.startAt)),
      endAt: toLocalInputValue(new Date(shift.endAt)),
      note: shift.note ?? "",
    });

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function belongsToVisibleWeek(shift: Shift) {
    const visibleStart = new Date(weekBoundaryUtc(weekStart));
    const visibleEnd = new Date(weekBoundaryUtc(weekStart, 7));

    return (
      new Date(shift.endAt) > visibleStart &&
      new Date(shift.startAt) < visibleEnd
    );
  }

  function changeWeek(amount: number) {
    const nextWeek = addDays(weekStart, amount);

    setWeekStart(nextWeek);
    setEditingShift(null);
    setError(null);

    setForm((currentForm) => ({
      ...createInitialForm(nextWeek),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));
  }

  function goToCurrentWeek() {
    const now = new Date();

    setWeekStart(startOfWeek(now));
    setEditingShift(null);
    setError(null);

    setForm((currentForm) => ({
      ...createInitialForm(now),
      employeeId: currentForm.employeeId,
      projectId: currentForm.projectId,
    }));
  }

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const shift = await apiRequest<Shift>(
        editingShift
          ? `/shifts/${editingShift.id}`
          : "/shifts",
        {
          method: editingShift ? "PATCH" : "POST",
          body: JSON.stringify({
            employeeId: Number(form.employeeId),
            projectId: Number(form.projectId),
            startAt: scheduleInputToUtc(form.startAt),
            endAt: scheduleInputToUtc(form.endAt),
            note: form.note.trim()
              ? form.note.trim()
              : editingShift
                ? null
                : undefined,
          }),
        },
      );

      setShifts((currentShifts) => {
        const withoutSavedShift = currentShifts.filter(
          (currentShift) => currentShift.id !== shift.id,
        );

        if (!belongsToVisibleWeek(shift)) {
          return withoutSavedShift;
        }

        return [...withoutSavedShift, shift].sort(
          (first, second) =>
            new Date(first.startAt).getTime() -
            new Date(second.startAt).getTime(),
        );
      });

      resetShiftForm();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save allocation",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteShift() {
    if (!editingShift) {
      return;
    }

    const confirmed = window.confirm(
      `Delete the allocation for ${editingShift.employee.name}?`,
    );

    if (!confirmed) {
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await apiRequest<void>(`/shifts/${editingShift.id}`, {
        method: "DELETE",
      });

      setShifts((currentShifts) =>
        currentShifts.filter(
          (shift) => shift.id !== editingShift.id,
        ),
      );

      resetShiftForm();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete allocation",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header schedule-header">
        <div>
          <h2>Allocation calendar</h2>
          <p>
            Review portfolio allocations and manage manual commitments.
          </p>
        </div>

        <div className="week-navigation">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => changeWeek(-7)}
          >
            ←
          </button>

          <strong>
            {weekStart.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}
            {" – "}
            {addDays(weekStart, 6).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </strong>

          <button
            type="button"
            aria-label="Next week"
            onClick={() => changeWeek(7)}
          >
            →
          </button>

          <button
            type="button"
            className="today-button"
            onClick={goToCurrentWeek}
          >
            Today
          </button>
        </div>
      </div>

      {editingShift && (
        <div className="editing-notice">
          <div>
            <strong>Editing allocation</strong>
            <span>
              {editingShift.employee.name} ·{" "}
              {editingShift.project.name}
            </span>
          </div>

          <button
            type="button"
            className="secondary-button"
            onClick={resetShiftForm}
          >
            Cancel editing
          </button>
        </div>
      )}

      <form className="panel shift-form" onSubmit={handleSubmit}>
        <label>
          Employee
          <select
            value={form.employeeId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                employeeId: event.target.value,
              })
            }
          >
            <option value="">Select employee</option>

            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Project
          <select
            value={form.projectId}
            required
            onChange={(event) =>
              setForm({
                ...form,
                projectId: event.target.value,
              })
            }
          >
            <option value="">Select project</option>

            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Start
          <input
            type="datetime-local"
            value={form.startAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                startAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          End
          <input
            type="datetime-local"
            value={form.endAt}
            required
            onChange={(event) =>
              setForm({
                ...form,
                endAt: event.target.value,
              })
            }
          />
        </label>

        <label>
          Note
          <input
            type="text"
            value={form.note}
            placeholder="Optional"
            maxLength={500}
            onChange={(event) =>
              setForm({
                ...form,
                note: event.target.value,
              })
            }
          />
        </label>

        <div className="shift-form-actions">
          {editingShift && (
            <button
              className="danger-button"
              type="button"
              disabled={isSubmitting}
              onClick={handleDeleteShift}
            >
              Delete
            </button>
          )}

          <button
            className="primary-button shift-submit"
            disabled={
              isSubmitting ||
              employees.length === 0 ||
              projects.length === 0
            }
          >
            {isSubmitting
              ? "Saving…"
              : editingShift
                ? "Save changes"
                : "Add manual allocation"}
          </button>
        </div>
      </form>

      {error && (
        <div className="error-message schedule-error">
          {error}
        </div>
      )}

      <div className="schedule-toolbar">
        <div className="schedule-filters">
          <label>
            Employee
            <select
              value={employeeFilter}
              onChange={(event) =>
                setEmployeeFilter(event.target.value)
              }
            >
              <option value="">All employees</option>

              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Project
            <select
              value={projectFilter}
              onChange={(event) =>
                setProjectFilter(event.target.value)
              }
            >
              <option value="">All projects</option>

              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          {(employeeFilter || projectFilter) && (
            <button
              type="button"
              className="clear-filters"
              onClick={() => {
                setEmployeeFilter("");
                setProjectFilter("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        <span className="visible-shifts-count">
         {filteredShifts.length}{" "}
         {filteredShifts.length === 1
           ? "visible allocation"
           : "visible allocations"}
        </span>
      </div>

      {holidayWarning && (
        <div className="warning-message">
          Public holidays are temporarily unavailable. Allocations are
          still displayed.
        </div>
      )}

      {isLoading ? (
        <p className="muted-text">Loading allocations…</p>
      ) : (
        <div className="calendar">
          {days.map((day) => {
            const dayShifts = filteredShifts.filter((shift) => {
              return scheduleDateKey(shift.startAt) === toDateKey(day);
            });

            const dayHolidays = holidays.filter(
              (holiday) =>
                holiday.date === toDateKey(day) &&
                holiday.nationwide,
            );

            const isToday =
              day.toDateString() === new Date().toDateString();

            return (
              <div
                className="calendar-day"
                key={day.toISOString()}
              >
                <header className={isToday ? "today" : undefined}>
                  <span>
                    {day.toLocaleDateString("en-GB", {
                      weekday: "short",
                    })}
                  </span>

                  <strong>{day.getDate()}</strong>
                </header>

                {dayHolidays.map((holiday) => (
                  <div
                    className="holiday-label"
                    key={holiday.id}
                  >
                    <span>Public holiday</span>
                    <strong>{holiday.name}</strong>
                  </div>
                ))}

                <div className="day-shifts">
                  {dayShifts.length === 0 && (
                    <span className="no-shifts">No allocations</span>
                  )}

                  {dayShifts.map((shift) => {
                    const editable = shift.origin !== "SOLVER";

                    return (
                      <button
                        className={`shift-card ${editable ? "" : "read-only-allocation"}`}
                        key={shift.id}
                        type="button"
                        title={editable
                          ? "Edit allocation"
                          : "Managed by Portfolio Planner"}
                        style={{
                          borderLeftColor: shift.project.color,
                        }}
                        onClick={editable
                          ? () => startEditingShift(shift)
                          : undefined}
                      >
                        <small className="allocation-kind">
                          {allocationLabel(shift)}
                        </small>
                        <strong>{shift.project.name}</strong>

                        <span>
                          {formatTime(shift.startAt)}
                          {" – "}
                          {formatTime(shift.endAt)}
                        </span>

                        <p>{shift.employee.name}</p>

                        {shift.note && <small>{shift.note}</small>}
                      </button>
                    );
                  })}

                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
