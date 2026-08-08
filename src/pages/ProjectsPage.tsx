import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "../api/client";
import type { DayOfWeek, ProjectWithCount, RequirementPriority, Skill } from "../types";

interface RequirementForm {
  dayOfWeek: DayOfWeek;
  start: string;
  end: string;
  requiredEmployees: number;
  requiredSkillId: string;
  minimumSkillLevel: number;
  priority: RequirementPriority;
}

interface ProjectForm {
  name: string;
  color: string;
  weeklyBudget: string;
  requirements: RequirementForm[];
}

const initialRequirement = (): RequirementForm => ({
  dayOfWeek: "MONDAY", start: "09:00", end: "17:00",
  requiredEmployees: 1, requiredSkillId: "", minimumSkillLevel: 1,
  priority: "NORMAL",
});

const initialForm: ProjectForm = {
  name: "",
  color: "#5267DF",
  weeklyBudget: "5000",
  requirements: [initialRequirement()],
};

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [form, setForm] = useState<ProjectForm>(initialForm);
  const [editingProject, setEditingProject] =
    useState<ProjectWithCount | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalAssignments = projects.reduce(
    (total, project) => total + project.shiftCount,
    0,
  );

  useEffect(() => {
    async function loadProjects() {
      try {
        const [data, skillData] = await Promise.all([
          apiRequest<ProjectWithCount[]>("/projects"),
          apiRequest<Skill[]>("/skills"),
        ]);
        setProjects(data);
        setSkills(skillData);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load projects",
        );
      } finally {
        setIsLoading(false);
      }
    }

    void loadProjects();
  }, []);

  function openCreateModal() {
    setEditingProject(null);
    setForm({ ...initialForm, requirements: [initialRequirement()] });
    setError(null);
    setIsModalOpen(true);
  }

  function openEditModal(project: ProjectWithCount) {
    setEditingProject(project);
    setForm({
      name: project.name,
      color: project.color,
      weeklyBudget: project.weeklyLaborBudgetCents === null
        ? ""
        : String(project.weeklyLaborBudgetCents / 100),
      requirements: [],
    });
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
     

    setIsModalOpen(false);
    setEditingProject(null);
    setForm({ ...initialForm, requirements: [initialRequirement()] });
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const project = await apiRequest<ProjectWithCount>(
        editingProject
          ? `/projects/${editingProject.id}`
          : "/projects",
        {
          method: editingProject ? "PATCH" : "POST",
          body: JSON.stringify(editingProject ? {
            name: form.name,
            color: form.color,
            weeklyLaborBudgetCents: form.weeklyBudget === ""
              ? null
              : Math.round(Number(form.weeklyBudget) * 100),
          } : {
            name: form.name,
            color: form.color,
            weeklyLaborBudgetCents: form.weeklyBudget === ""
              ? null
              : Math.round(Number(form.weeklyBudget) * 100),
            requirements: form.requirements.map((requirement) => {
              const [startHour, startMinute] = requirement.start.split(":").map(Number);
              const [endHour, endMinute] = requirement.end.split(":").map(Number);
              return {
                dayOfWeek: requirement.dayOfWeek,
                startMinute: startHour * 60 + startMinute,
                endMinute: endHour * 60 + endMinute,
                requiredEmployees: requirement.requiredEmployees,
                requiredSkillId: requirement.requiredSkillId
                  ? Number(requirement.requiredSkillId)
                  : null,
                minimumSkillLevel: requirement.requiredSkillId
                  ? requirement.minimumSkillLevel
                  : 1,
                priority: requirement.priority,
              };
            }),
          }),
        },
      );

      setProjects((currentProjects) =>
        editingProject
          ? currentProjects.map((currentProject) =>
              currentProject.id === project.id
                ? project
                : currentProject,
            )
          : [project, ...currentProjects],
      );

      closeModal();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to save project",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section>
      <div className="page-header projects-header">
        <div>
          <h2>Projects</h2>
          <p>Manage workstreams and their calendar identity.</p>
        </div>

        <button
          className="primary-button header-button"
          type="button"
          onClick={openCreateModal}
        >
          + New project
        </button>
      </div>

      <div className="project-stats">
        <div className="stat-card">
          <span>Active projects</span>
          <strong>{projects.length}</strong>
        </div>

        <div className="stat-card">
          <span>Scheduled shifts</span>
          <strong>{totalAssignments}</strong>
        </div>
      </div>

      {error && !isModalOpen && (
        <div className="error-message">{error}</div>
      )}

      {isLoading ? (
        <p className="muted-text">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="panel projects-empty">
          <strong>No projects yet</strong>
          <p>Create your first project to begin scheduling work.</p>

          <button
            className="primary-button"
            type="button"
            onClick={openCreateModal}
          >
            Create project
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => (
            <article className="project-tile" key={project.id}>
              <div
                className="project-tile-accent"
                style={{ backgroundColor: project.color }}
              />

              <div className="project-tile-header">
                <div
                  className="project-icon"
                  style={{
                    color: project.color,
                    backgroundColor: `${project.color}18`,
                  }}
                >
                  {project.name.charAt(0).toUpperCase()}
                </div>

                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openEditModal(project)}
                >
                  Edit
                </button>
              </div>

              <div className="project-tile-content">
                <h3>{project.name}</h3>
                <p>
                  {project.shiftCount}{" "}
                  {project.shiftCount === 1
                    ? "scheduled shift"
                    : "scheduled shifts"}
                </p>
                <p>{project.requirementCount} staffing requirements</p>
                <p>{project.weeklyLaborBudgetCents === null
                  ? "No weekly budget"
                  : `€${(project.weeklyLaborBudgetCents / 100).toLocaleString("en-GB")} weekly budget`}</p>
              </div>

              <div className="project-tile-footer">
                <span
                  className="color-dot"
                  style={{ backgroundColor: project.color }}
                />
                <span>Calendar color</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {isModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={closeModal}
        >
          <div
            className="project-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3 id="project-modal-title">
                  {editingProject ? "Edit project" : "New project"}
                </h3>
                <p>
                  {editingProject
                    ? "Update the project name or calendar color."
                    : "Create a workstream for employee assignments."}
                </p>
              </div>

              <button
                className="modal-close"
                type="button"
                aria-label="Close"
                onClick={closeModal}
              >
                ×
              </button>
            </div>

            <form className="modal-form" onSubmit={handleSubmit}>
              <label>
                Project name
                <input
                  type="text"
                  value={form.name}
                  placeholder="Customer Portal"
                  required
                  minLength={2}
                  maxLength={100}
                  autoFocus
                  onChange={(event) =>
                    setForm({
                      ...form,
                      name: event.target.value,
                    })
                  }
                />
              </label>

              <label>
                Calendar color
                <div className="modal-color-field">
                  <input
                    type="color"
                    value={form.color}
                    aria-label="Project color"
                    onChange={(event) =>
                      setForm({
                        ...form,
                        color: event.target.value.toUpperCase(),
                      })
                    }
                  />

                  <input
                    type="text"
                    value={form.color}
                    pattern="^#[0-9A-Fa-f]{6}$"
                    required
                    onChange={(event) =>
                      setForm({
                        ...form,
                        color: event.target.value,
                      })
                    }
                  />
                </div>
              </label>

              <label>
                Weekly labor budget (€)
                <input type="number" min="0" step="0.01" value={form.weeklyBudget} onChange={(event) => setForm({ ...form, weeklyBudget: event.target.value })} />
              </label>

              {!editingProject && <div className="requirements-editor">
                <div className="requirements-heading">
                  <div><strong>Staffing requirements</strong><p>Define the demand this project adds to the scheduler.</p></div>
                  <button className="secondary-button" type="button" onClick={() => setForm({ ...form, requirements: [...form.requirements, initialRequirement()] })}>+ Add requirement</button>
                </div>

                {form.requirements.map((requirement, index) => <div className="requirement-row" key={index}>
                  <select aria-label="Day" value={requirement.dayOfWeek} onChange={(event) => {
                    const requirements = [...form.requirements]; requirements[index] = { ...requirement, dayOfWeek: event.target.value as DayOfWeek }; setForm({ ...form, requirements });
                  }}>{["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((day) => <option key={day} value={day}>{day.slice(0, 3)}</option>)}</select>
                  <input aria-label="Start" type="time" value={requirement.start} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, start: event.target.value }; setForm({ ...form, requirements }); }} />
                  <input aria-label="End" type="time" value={requirement.end} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, end: event.target.value }; setForm({ ...form, requirements }); }} />
                  <input aria-label="People" title="Required employees" type="number" min="1" max="100" value={requirement.requiredEmployees} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, requiredEmployees: Number(event.target.value) }; setForm({ ...form, requirements }); }} />
                  <select aria-label="Required skill" value={requirement.requiredSkillId} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, requiredSkillId: event.target.value }; setForm({ ...form, requirements }); }}><option value="">Any skill</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select>
                  <select aria-label="Minimum skill level" disabled={!requirement.requiredSkillId} value={requirement.minimumSkillLevel} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, minimumSkillLevel: Number(event.target.value) }; setForm({ ...form, requirements }); }}>{[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>L{level}+</option>)}</select>
                  <select aria-label="Priority" value={requirement.priority} onChange={(event) => { const requirements = [...form.requirements]; requirements[index] = { ...requirement, priority: event.target.value as RequirementPriority }; setForm({ ...form, requirements }); }}>{["LOW", "NORMAL", "HIGH", "CRITICAL"].map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select>
                  <button className="remove-requirement" type="button" disabled={form.requirements.length === 1} onClick={() => setForm({ ...form, requirements: form.requirements.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                </div>)}
              </div>}

              <div
                className="color-preview"
                style={{
                  borderLeftColor: form.color,
                  backgroundColor: `${form.color}10`,
                }}
              >
                <strong>{form.name || "Project preview"}</strong>
                <span>This color will identify shifts in the calendar.</span>
              </div>

              {error && (
                <div className="error-message">{error}</div>
              )}

              <div className="modal-actions">
                <button
                  className="secondary-button modal-action"
                  type="button"
                  onClick={closeModal}
                >
                  Cancel
                </button>

                <button
                  className="primary-button modal-action"
                  disabled={isSubmitting}
                >
                  {isSubmitting
                    ? "Saving…"
                    : editingProject
                      ? "Save changes"
                      : "Create project"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
