import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toastManager } from "../components/ui/toast";
import { makeThreadFixture } from "../test-fixtures";
import { archiveProjectThreads, unarchiveThreads } from "./projectThreadArchive";

const environmentId = EnvironmentId.make("environment-archive-all");
const projectId = ProjectId.make("project-archive-all");
const project = {
  displayName: "Track",
  memberProjects: [{ environmentId, id: projectId }],
};
const success = AsyncResult.success(undefined);
const failure = AsyncResult.failure(Cause.fail(new Error("offline")));

function idleThread(id: string) {
  return makeThreadFixture({ id: ThreadId.make(id), environmentId, projectId });
}

function runningThread(id: string) {
  const thread = idleThread(id);
  return { ...thread, runtime: { ...thread.runtime!, status: "running" as const } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archiveProjectThreads", () => {
  it("confirms with the count, archives idle threads, and Undo restores them", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => {});
    const confirm = vi.fn(async () => true);
    const archiveThread = vi.fn(async (_ref: unknown, opts: { onArchived: () => void }) => {
      opts.onArchived();
      return success;
    });
    const unarchiveThread = vi.fn(async () => success);

    const archived = await archiveProjectThreads({
      project,
      threads: [idleThread("one"), runningThread("busy"), idleThread("two")],
      confirm,
      archiveThread,
      unarchiveThread,
    });

    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      'Archive 2 threads in "Track"?\n1 thread still running will stay.',
    );
    expect(archived.map((ref) => ref.threadId)).toEqual(["one", "two"]);
    expect(archiveThread).toHaveBeenCalledTimes(2);
    const toast = add.mock.calls[0]![0] as {
      title: string;
      actionProps: { onClick: () => void };
    };
    expect(toast.title).toBe("Archived 2 threads");
    toast.actionProps.onClick();
    await vi.waitFor(() => expect(unarchiveThread).toHaveBeenCalledTimes(2));
  });

  it("archives nothing when the confirmation is declined", async () => {
    const archiveThread = vi.fn(async () => success);
    const archived = await archiveProjectThreads({
      project,
      threads: [idleThread("one")],
      confirm: async () => false,
      archiveThread,
    });
    expect(archived).toEqual([]);
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("stops at the first failed archive and keeps what already went through", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const archiveThread = vi
      .fn()
      .mockImplementationOnce(async (_ref: unknown, opts: { onArchived: () => void }) => {
        opts.onArchived();
        return success;
      })
      .mockResolvedValueOnce(failure);
    const archived = await archiveProjectThreads({
      project,
      threads: [idleThread("one"), idleThread("two"), idleThread("three")],
      confirm: null,
      archiveThread,
    });
    expect(archived.map((ref) => ref.threadId)).toEqual(["one"]);
    expect(archiveThread).toHaveBeenCalledTimes(2);
    // No Undo toast without unarchiveThread; only the failure is reported.
    expect(add).toHaveBeenCalledOnce();
  });
});

describe("unarchiveThreads", () => {
  it("stops at the first failure and counts what was restored", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const unarchiveThread = vi
      .fn()
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(success);
    const refs = ["one", "two", "three"].map((id) => ({
      environmentId,
      threadId: ThreadId.make(id),
    }));
    expect(await unarchiveThreads(refs, unarchiveThread)).toBe(1);
    expect(unarchiveThread).toHaveBeenCalledTimes(2);
  });
});
