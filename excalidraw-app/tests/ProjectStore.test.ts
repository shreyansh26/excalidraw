import {
  DuplicateProjectNameError,
  MAX_PROJECT_SNAPSHOTS,
  ProjectStore,
} from "../data/ProjectStore";

describe("ProjectStore", () => {
  beforeEach(async () => {
    await ProjectStore.clearAll();
  });

  afterEach(async () => {
    await ProjectStore.clearAll();
  });

  it("creates projects and enforces unique names", async () => {
    const project = await ProjectStore.createProject("Roadmap");
    expect(project.name).toBe("Roadmap");

    await expect(ProjectStore.createProject(" roadmap ")).rejects.toThrow(
      DuplicateProjectNameError,
    );

    const projects = await ProjectStore.listProjects();
    expect(projects).toHaveLength(1);
  });

  it("renames project and blocks duplicate names", async () => {
    const alpha = await ProjectStore.createProject("Alpha");
    await ProjectStore.createProject("Beta");

    const renamed = await ProjectStore.renameProject(alpha.id, "Gamma");
    expect(renamed.name).toBe("Gamma");

    await expect(ProjectStore.renameProject(alpha.id, "beta")).rejects.toThrow(
      DuplicateProjectNameError,
    );
  });

  it("retains only the most recent snapshots per project", async () => {
    const project = await ProjectStore.createProject("Snapshots");

    for (let index = 0; index < MAX_PROJECT_SNAPSHOTS + 2; index++) {
      await ProjectStore.saveSnapshot(project.id, `snapshot-${index}`);
    }

    const snapshots = await ProjectStore.listSnapshots(project.id);
    expect(snapshots).toHaveLength(MAX_PROJECT_SNAPSHOTS);
    expect(snapshots[0].serialized).toBe(
      `snapshot-${MAX_PROJECT_SNAPSHOTS + 1}`,
    );
    expect(snapshots[snapshots.length - 1].serialized).toBe("snapshot-2");
  });

  it("deletes project and all related snapshots", async () => {
    const project = await ProjectStore.createProject("Delete me");
    await ProjectStore.saveSnapshot(project.id, "snapshot");

    await ProjectStore.deleteProject(project.id);

    expect(await ProjectStore.getProject(project.id)).toBeNull();
    expect(await ProjectStore.listSnapshots(project.id)).toHaveLength(0);
  });
});
