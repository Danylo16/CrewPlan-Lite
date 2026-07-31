export interface Employee {
  id: number;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: number;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWithCount extends Project {
  shiftCount: number;
}

export interface Shift {
  id: number;
  employeeId: number;
  projectId: number;
  startAt: string;
  endAt: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  employee: Employee;
  project: Project;
}

export interface Holiday {
  id: string;
  date: string;
  endDate: string;
  name: string;
  nationwide: boolean;
}