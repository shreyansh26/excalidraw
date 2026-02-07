import { createStore, del, entries, get, set } from "idb-keyval";

import type { FileSystemHandle } from "@excalidraw/excalidraw/data/filesystem";

const PROJECTS_DB_NAME = "excalidraw-projects-meta-db";
const SNAPSHOTS_DB_NAME = "excalidraw-projects-snapshots-db";
const SETTINGS_DB_NAME = "excalidraw-projects-settings-db";
const LOCAL_PROJECTS_API = "/api/local-projects";

const projectsStore = createStore(PROJECTS_DB_NAME, "projects");
const snapshotsStore = createStore(SNAPSHOTS_DB_NAME, "snapshots");
const settingsStore = createStore(SETTINGS_DB_NAME, "settings");

const SETTINGS_KEYS = {
  activeProjectId: "active-project-id",
  migrationDone: "legacy-migration-done",
} as const;

export const MAX_PROJECT_SNAPSHOTS = 5;

export type ProjectMetadata = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  linkedFileHandle: FileSystemHandle | null;
};

export type ProjectSnapshot = {
  id: string;
  projectId: string;
  createdAt: number;
  serialized: string;
};

type LocalApiProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type LocalApiResponse<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; error: string };

export class DuplicateProjectNameError extends Error {
  constructor(name: string) {
    super(`Project name "${name}" already exists`);
    this.name = "DuplicateProjectNameError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project "${projectId}" was not found`);
    this.name = "ProjectNotFoundError";
  }
}

const createId = () =>
  typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const normalizeProjectName = (name: string) => name.trim();

const normalizeForComparison = (name: string) =>
  normalizeProjectName(name).toLocaleLowerCase();

const ensureValidName = (name: string) => {
  const normalizedName = normalizeProjectName(name);
  if (!normalizedName) {
    throw new Error("Project name is required");
  }
  return normalizedName;
};

const getProjectsEntries = async () => {
  const allEntries = await entries(projectsStore);
  return allEntries as [string, ProjectMetadata][];
};

const getSnapshotsEntries = async () => {
  const allEntries = await entries(snapshotsStore);
  return allEntries as [string, ProjectSnapshot][];
};

const sortByUpdatedAtDesc = (a: ProjectMetadata, b: ProjectMetadata) =>
  b.updatedAt - a.updatedAt;

const mapLocalProject = (project: LocalApiProject): ProjectMetadata => ({
  ...project,
  linkedFileHandle: null,
});

export class ProjectStore {
  private static lastSnapshotTimestamp = 0;
  private static localApiStatus: "unknown" | "available" | "unavailable" =
    "unknown";

  private static createSnapshot(
    projectId: string,
    serialized: string,
  ): ProjectSnapshot {
    const now = Date.now();
    const createdAt =
      now > this.lastSnapshotTimestamp ? now : this.lastSnapshotTimestamp + 1;
    this.lastSnapshotTimestamp = createdAt;

    return {
      id: createId(),
      projectId,
      createdAt,
      serialized,
    };
  }

  private static async requestLocalApi<T>(
    path: string,
    init?: RequestInit,
  ): Promise<LocalApiResponse<T> | null> {
    if (typeof window === "undefined") {
      this.localApiStatus = "unavailable";
      return null;
    }
    if (this.localApiStatus === "unavailable") {
      return null;
    }

    try {
      const response = await fetch(`${LOCAL_PROJECTS_API}${path}`, {
        headers: {
          "Content-Type": "application/json",
        },
        ...init,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      } & T;

      this.localApiStatus = "available";

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: payload.error || "Request failed",
        };
      }

      return {
        ok: true,
        data: payload as T,
        status: response.status,
      };
    } catch {
      if (this.localApiStatus !== "available") {
        this.localApiStatus = "unavailable";
      }
      return null;
    }
  }

  static async listProjects(): Promise<ProjectMetadata[]> {
    const localProjectsResponse = await this.requestLocalApi<{
      projects: LocalApiProject[];
    }>("");

    if (localProjectsResponse?.ok) {
      return localProjectsResponse.data.projects
        .map(mapLocalProject)
        .sort(sortByUpdatedAtDesc);
    }
    if (localProjectsResponse && !localProjectsResponse.ok) {
      throw new Error(localProjectsResponse.error);
    }

    const allProjects = (await getProjectsEntries()).map(([, project]) => ({
      ...project,
    }));
    return allProjects.sort(sortByUpdatedAtDesc);
  }

  static async getProject(projectId: string): Promise<ProjectMetadata | null> {
    const localProjectResponse = await this.requestLocalApi<{
      project: LocalApiProject;
      serialized: string;
    }>(`/${encodeURIComponent(projectId)}`);

    if (localProjectResponse?.ok) {
      return mapLocalProject(localProjectResponse.data.project);
    }

    if (localProjectResponse && !localProjectResponse.ok) {
      if (localProjectResponse.status === 404) {
        return null;
      }
      throw new Error(localProjectResponse.error);
    }

    const project = await get<ProjectMetadata>(projectId, projectsStore);
    return project ?? null;
  }

  static async createProject(name: string): Promise<ProjectMetadata> {
    const normalizedName = ensureValidName(name);

    const createProjectResponse = await this.requestLocalApi<{
      project: LocalApiProject;
    }>("", {
      method: "POST",
      body: JSON.stringify({
        name: normalizedName,
      }),
    });

    if (createProjectResponse?.ok) {
      return mapLocalProject(createProjectResponse.data.project);
    }

    if (createProjectResponse && !createProjectResponse.ok) {
      if (createProjectResponse.status === 409) {
        throw new DuplicateProjectNameError(normalizedName);
      }
      throw new Error(createProjectResponse.error);
    }

    await this.assertNameIsUnique(normalizedName);

    const now = Date.now();
    const project: ProjectMetadata = {
      id: createId(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      linkedFileHandle: null,
    };
    await set(project.id, project, projectsStore);
    return project;
  }

  static async renameProject(
    projectId: string,
    nextName: string,
  ): Promise<ProjectMetadata> {
    const normalizedName = ensureValidName(nextName);

    const renameProjectResponse = await this.requestLocalApi<{
      project: LocalApiProject;
    }>(`/${encodeURIComponent(projectId)}/rename`, {
      method: "POST",
      body: JSON.stringify({
        name: normalizedName,
      }),
    });

    if (renameProjectResponse?.ok) {
      return mapLocalProject(renameProjectResponse.data.project);
    }

    if (renameProjectResponse && !renameProjectResponse.ok) {
      if (renameProjectResponse.status === 409) {
        throw new DuplicateProjectNameError(normalizedName);
      }
      if (renameProjectResponse.status === 404) {
        throw new ProjectNotFoundError(projectId);
      }
      throw new Error(renameProjectResponse.error);
    }

    const existingProject = await this.getProject(projectId);
    if (!existingProject) {
      throw new ProjectNotFoundError(projectId);
    }

    if (
      normalizeForComparison(existingProject.name) ===
      normalizeForComparison(normalizedName)
    ) {
      return existingProject;
    }

    await this.assertNameIsUnique(normalizedName, projectId);

    const renamedProject: ProjectMetadata = {
      ...existingProject,
      name: normalizedName,
      updatedAt: Date.now(),
      linkedFileHandle: null,
    };
    await set(projectId, renamedProject, projectsStore);
    return renamedProject;
  }

  static async deleteProject(projectId: string): Promise<void> {
    const deleteProjectResponse = await this.requestLocalApi<{ success: true }>(
      `/${encodeURIComponent(projectId)}`,
      {
        method: "DELETE",
      },
    );

    if (deleteProjectResponse?.ok) {
      const activeProjectId = await this.getActiveProjectId();
      if (activeProjectId === projectId) {
        await this.setActiveProjectId(null);
      }
      return;
    }

    if (deleteProjectResponse && !deleteProjectResponse.ok) {
      if (deleteProjectResponse.status === 404) {
        const activeProjectId = await this.getActiveProjectId();
        if (activeProjectId === projectId) {
          await this.setActiveProjectId(null);
        }
        return;
      }
      throw new Error(deleteProjectResponse.error);
    }

    await del(projectId, projectsStore);
    const snapshots = await this.listSnapshots(projectId);
    await Promise.all(
      snapshots.map((snapshot) => del(snapshot.id, snapshotsStore)),
    );

    const activeProjectId = await this.getActiveProjectId();
    if (activeProjectId === projectId) {
      await this.setActiveProjectId(null);
    }
  }

  static async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    const localSnapshotsResponse = await this.requestLocalApi<{
      project: LocalApiProject;
      serialized: string;
    }>(`/${encodeURIComponent(projectId)}`);

    if (localSnapshotsResponse?.ok) {
      return [
        this.createSnapshot(projectId, localSnapshotsResponse.data.serialized),
      ];
    }

    if (localSnapshotsResponse && !localSnapshotsResponse.ok) {
      if (localSnapshotsResponse.status === 404) {
        return [];
      }
      throw new Error(localSnapshotsResponse.error);
    }

    return (await getSnapshotsEntries())
      .map(([, snapshot]) => snapshot)
      .filter((snapshot) => snapshot.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  static async getLatestSnapshot(
    projectId: string,
  ): Promise<ProjectSnapshot | null> {
    const snapshots = await this.listSnapshots(projectId);
    return snapshots[0] ?? null;
  }

  static async saveSnapshot(
    projectId: string,
    serialized: string,
  ): Promise<ProjectSnapshot> {
    const saveSnapshotResponse = await this.requestLocalApi<{
      project: LocalApiProject;
      serialized: string;
    }>(`/${encodeURIComponent(projectId)}/snapshot`, {
      method: "POST",
      body: JSON.stringify({
        serialized,
      }),
    });

    if (saveSnapshotResponse?.ok) {
      return this.createSnapshot(
        projectId,
        saveSnapshotResponse.data.serialized,
      );
    }

    if (saveSnapshotResponse && !saveSnapshotResponse.ok) {
      if (saveSnapshotResponse.status === 404) {
        throw new ProjectNotFoundError(projectId);
      }
      throw new Error(saveSnapshotResponse.error);
    }

    const project = await this.getProject(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    const snapshot = this.createSnapshot(projectId, serialized);
    await set(snapshot.id, snapshot, snapshotsStore);

    await this.pruneSnapshots(projectId);
    await this.touchProject(projectId);

    return snapshot;
  }

  static async touchProject(projectId: string): Promise<void> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    await set(
      projectId,
      {
        ...project,
        updatedAt: Date.now(),
      },
      projectsStore,
    );
  }

  static async setLinkedFileHandle(
    projectId: string,
    linkedFileHandle: FileSystemHandle | null,
  ): Promise<ProjectMetadata> {
    const localProjectResponse = await this.requestLocalApi<{
      project: LocalApiProject;
      serialized: string;
    }>(`/${encodeURIComponent(projectId)}`);

    if (localProjectResponse?.ok) {
      return mapLocalProject(localProjectResponse.data.project);
    }

    if (localProjectResponse && !localProjectResponse.ok) {
      if (localProjectResponse.status === 404) {
        throw new ProjectNotFoundError(projectId);
      }
      throw new Error(localProjectResponse.error);
    }

    const project = await this.getProject(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    const updatedProject: ProjectMetadata = {
      ...project,
      linkedFileHandle,
      updatedAt: Date.now(),
    };
    await set(projectId, updatedProject, projectsStore);
    return updatedProject;
  }

  static async getActiveProjectId(): Promise<string | null> {
    return (
      (await get<string>(SETTINGS_KEYS.activeProjectId, settingsStore)) ?? null
    );
  }

  static async setActiveProjectId(projectId: string | null): Promise<void> {
    await set(SETTINGS_KEYS.activeProjectId, projectId, settingsStore);
  }

  static async isLegacyMigrationDone(): Promise<boolean> {
    return (
      (await get<boolean>(SETTINGS_KEYS.migrationDone, settingsStore)) ?? false
    );
  }

  static async setLegacyMigrationDone(): Promise<void> {
    await set(SETTINGS_KEYS.migrationDone, true, settingsStore);
  }

  static async clearAll(): Promise<void> {
    const [projectEntries, snapshotEntries] = await Promise.all([
      getProjectsEntries(),
      getSnapshotsEntries(),
    ]);

    await Promise.all([
      ...projectEntries.map(([projectId]) => del(projectId, projectsStore)),
      ...snapshotEntries.map(([snapshotId]) => del(snapshotId, snapshotsStore)),
      del(SETTINGS_KEYS.activeProjectId, settingsStore),
      del(SETTINGS_KEYS.migrationDone, settingsStore),
    ]);

    this.localApiStatus = "unknown";
  }

  private static async assertNameIsUnique(
    name: string,
    ignoreProjectId?: string,
  ): Promise<void> {
    const normalizedName = normalizeForComparison(name);
    const allProjects = await this.listProjects();
    const hasDuplicate = allProjects.some((project) => {
      return (
        project.id !== ignoreProjectId &&
        normalizeForComparison(project.name) === normalizedName
      );
    });
    if (hasDuplicate) {
      throw new DuplicateProjectNameError(name);
    }
  }

  private static async pruneSnapshots(projectId: string): Promise<void> {
    const snapshots = await this.listSnapshots(projectId);
    const staleSnapshots = snapshots.slice(MAX_PROJECT_SNAPSHOTS);
    await Promise.all(
      staleSnapshots.map((snapshot) => del(snapshot.id, snapshotsStore)),
    );
  }
}
