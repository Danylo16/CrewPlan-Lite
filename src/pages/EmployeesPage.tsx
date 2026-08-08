import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type { DayOfWeek, Employee, Skill } from "../types";

const WEEKDAYS: Array<{ id: DayOfWeek; label: string }> = [
  { id: "MONDAY", label: "Mon" }, { id: "TUESDAY", label: "Tue" },
  { id: "WEDNESDAY", label: "Wed" }, { id: "THURSDAY", label: "Thu" },
  { id: "FRIDAY", label: "Fri" }, { id: "SATURDAY", label: "Sat" },
  { id: "SUNDAY", label: "Sun" },
];

interface EmployeeForm {
  name: string;
  email: string;
  role: string;
  preferredHours: string;
  maxHours: string;
  hourlyCost: string;
  overtimeMultiplier: string;
  skillLevels: Record<number, number>;
  availability: Record<DayOfWeek, { enabled: boolean; start: string; end: string }>;
}

function initialForm(): EmployeeForm {
  return {
    name: "", email: "", role: "", preferredHours: "32", maxHours: "40",
    hourlyCost: "35", overtimeMultiplier: "1.5", skillLevels: {},
    availability: Object.fromEntries(WEEKDAYS.map(({ id }, index) => [id, {
      enabled: index < 5, start: "09:00", end: "17:00",
    }])) as EmployeeForm["availability"],
  };
}

function minuteOfDay(value: string) {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [form, setForm] = useState<EmployeeForm>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<Employee[]>("/employees"),
      apiRequest<Skill[]>("/skills"),
    ]).then(([employeeData, skillData]) => {
      setEmployees(employeeData);
      setSkills(skillData);
    }).catch((loadError) => setError(
      loadError instanceof Error ? loadError.message : "Failed to load team data",
    )).finally(() => setIsLoading(false));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const selectedSkills = Object.entries(form.skillLevels);
    const availability = WEEKDAYS.filter(({ id }) => form.availability[id].enabled);

    if (selectedSkills.length === 0 || availability.length === 0) {
      setError("Select at least one skill and one available day");
      return;
    }

    setIsSubmitting(true);
    try {
      const employee = await apiRequest<Employee>("/employees", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          role: form.role,
          preferredWeeklyMinutes: Math.round(Number(form.preferredHours) * 60),
          maxWeeklyMinutes: Math.round(Number(form.maxHours) * 60),
          hourlyCostCents: Math.round(Number(form.hourlyCost) * 100),
          overtimeRateBasisPoints: Math.round(Number(form.overtimeMultiplier) * 10_000),
          skills: selectedSkills.map(([skillId, level]) => ({
            skillId: Number(skillId), level,
          })),
          availability: availability.map(({ id }) => ({
            dayOfWeek: id,
            startMinute: minuteOfDay(form.availability[id].start),
            endMinute: minuteOfDay(form.availability[id].end),
          })),
        }),
      });
      setEmployees((current) => [employee, ...current]);
      setForm(initialForm());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create employee");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header">
        <div><h2>Employees</h2><p>Create scheduler-ready employee profiles.</p></div>
        <span className="count-badge">{employees.length} employees</span>
      </div>

      <div className="employee-layout">
        <form className="panel form-panel employee-form" onSubmit={handleSubmit}>
          <h3>New employee profile</h3>
          <div className="form-row three-columns">
            <label>Name<input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>Email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label>Role<input required minLength={2} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></label>
          </div>

          <div className="form-section">
            <div><strong>Capacity and cost</strong><p>Weekly limits and fully loaded hourly cost.</p></div>
            <div className="form-row four-columns">
              <label>Preferred hours<input required type="number" min="0" max="168" step="0.5" value={form.preferredHours} onChange={(e) => setForm({ ...form, preferredHours: e.target.value })} /></label>
              <label>Maximum hours<input required type="number" min="0.5" max="168" step="0.5" value={form.maxHours} onChange={(e) => setForm({ ...form, maxHours: e.target.value })} /></label>
              <label>Hourly cost (€)<input required type="number" min="0" step="0.01" value={form.hourlyCost} onChange={(e) => setForm({ ...form, hourlyCost: e.target.value })} /></label>
              <label>Overtime multiplier<input required type="number" min="1" max="5" step="0.1" value={form.overtimeMultiplier} onChange={(e) => setForm({ ...form, overtimeMultiplier: e.target.value })} /></label>
            </div>
          </div>

          <div className="form-section">
            <div><strong>Skills</strong><p>Select competency and level from 1 to 5.</p></div>
            <div className="skill-grid">
              {skills.map((skill) => {
                const selected = form.skillLevels[skill.id] !== undefined;
                return <div className={`skill-option ${selected ? "selected" : ""}`} key={skill.id}>
                  <label><input type="checkbox" checked={selected} onChange={(e) => {
                    const levels = { ...form.skillLevels };
                    if (e.target.checked) levels[skill.id] = 3; else delete levels[skill.id];
                    setForm({ ...form, skillLevels: levels });
                  }} />{skill.name}</label>
                  {selected && <select aria-label={`${skill.name} level`} value={form.skillLevels[skill.id]} onChange={(e) => setForm({ ...form, skillLevels: { ...form.skillLevels, [skill.id]: Number(e.target.value) } })}>
                    {[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>Level {level}</option>)}
                  </select>}
                </div>;
              })}
            </div>
          </div>

          <div className="form-section">
            <div><strong>Weekly availability</strong><p>Recurring working windows in Europe/Vienna.</p></div>
            <div className="availability-grid">
              {WEEKDAYS.map(({ id, label }) => {
                const slot = form.availability[id];
                return <div className={`availability-row ${slot.enabled ? "enabled" : ""}`} key={id}>
                  <label><input type="checkbox" checked={slot.enabled} onChange={(e) => setForm({ ...form, availability: { ...form.availability, [id]: { ...slot, enabled: e.target.checked } } })} />{label}</label>
                  <input type="time" disabled={!slot.enabled} value={slot.start} onChange={(e) => setForm({ ...form, availability: { ...form.availability, [id]: { ...slot, start: e.target.value } } })} />
                  <span>to</span>
                  <input type="time" disabled={!slot.enabled} value={slot.end} onChange={(e) => setForm({ ...form, availability: { ...form.availability, [id]: { ...slot, end: e.target.value } } })} />
                </div>;
              })}
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}
          <button className="primary-button" disabled={isSubmitting}>{isSubmitting ? "Creating profile…" : "Create employee"}</button>
        </form>

        <div className="panel team-panel">
          <h3>Scheduler-ready team</h3>
          {isLoading && <p className="muted-text">Loading employees…</p>}
          <div className="item-list">{employees.map((employee) => <article className="employee-card detailed" key={employee.id}>
            <div className="employee-avatar">{employee.name.charAt(0).toUpperCase()}</div>
            <div className="employee-card-body"><strong>{employee.name}</strong><p>{employee.role}</p>
              <div className="employee-meta"><span>{employee.preferredWeeklyMinutes / 60}h preferred</span><span>{employee.maxWeeklyMinutes / 60}h max</span><span>€{(employee.hourlyCostCents / 100).toFixed(2)}/h</span></div>
              <div className="employee-skills">{employee.skills?.map((item) => <span key={item.skillId}>{item.skill.name} · L{item.level}</span>)}</div>
            </div>
          </article>)}</div>
        </div>
      </div>
    </section>
  );
}
