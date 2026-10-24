import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import {
  archiveSelectedThreadEntries,
  partitionProjectThreadsForArchive,
} from "../components/Sidebar.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { SidebarThreadSummary } from "../types";

interface ProjectThreadScope {
  readonly displayName: string;
  readonly memberProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>;
}

type CommandResult = AtomCommandResult<unknown, unknown>;

function pluralThreads(count: number) {
  return `${count} thread${count === 1 ? "" : "s"}`;
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function partitionFor(project: ProjectThreadScope, threads: readonly SidebarThreadSummary[]) {
  return partitionProjectThreadsForArchive(
    threads,
    new Set(project.memberProjects.map((member) => `${member.environmentId}:${member.id}`)),
  );
}

/** Threads "Archive all threads" would take now, and running ones it would leave. */
export function countProjectThreadsToArchive(
  project: ProjectThreadScope,
  threads: readonly SidebarThreadSummary[],
) {
  const { archivable, runningCount } = partitionFor(project, threads);
  return { archivableCount: archivable.length, runningCount };
}

/** Restores threads one at a time and reports the first failure. */
export async function unarchiveThreads(
  threadRefs: ReadonlyArray<ScopedThreadRef>,
  unarchiveThread: (threadRef: ScopedThreadRef) => Promise<CommandResult>,
) {
  let restored = 0;
  for (const threadRef of threadRefs) {
    const result = await unarchiveThread(threadRef);
    if (result._tag === "Success") {
      restored += 1;
      continue;
    }
    if (!isAtomCommandInterrupted(result)) {
      failureToast(
        restored > 0
          ? `Unarchived ${pluralThreads(restored)}, then failed`
          : "Failed to unarchive threads",
        squashAtomCommandFailure(result),
      );
    }
    break;
  }
  return restored;
}

/**
 * Archives every idle top-level thread of a project (all its checkouts)
 * through the per-thread archive, so each one joins the sidebar Undo notice.
 * Running threads stay. Pass `unarchiveThread` on surfaces without that
 * notice to get a toast with Undo instead.
 */
export async function archiveProjectThreads(input: {
  readonly project: ProjectThreadScope;
  readonly threads: readonly SidebarThreadSummary[];
  readonly confirm: ((message: string) => Promise<boolean>) | null;
  readonly archiveThread: (
    threadRef: ScopedThreadRef,
    opts: { onArchived: () => void },
  ) => Promise<CommandResult>;
  readonly unarchiveThread?: (threadRef: ScopedThreadRef) => Promise<CommandResult>;
}): Promise<ReadonlyArray<ScopedThreadRef>> {
  const { project } = input;
  const { archivable, runningCount } = partitionFor(project, input.threads);
  if (archivable.length === 0) {
    toastManager.add({
      type: "info",
      title: "No threads to archive",
      description:
        runningCount > 0
          ? `${pluralThreads(runningCount)} in ${project.displayName} still running.`
          : `${project.displayName} has no active threads.`,
    });
    return [];
  }
  if (input.confirm) {
    const confirmed = await input.confirm(
      [
        `Archive ${pluralThreads(archivable.length)} in "${project.displayName}"?`,
        ...(runningCount > 0 ? [`${pluralThreads(runningCount)} still running will stay.`] : []),
      ].join("\n"),
    );
    if (!confirmed) return [];
  }

  const entries = archivable.map((thread) => {
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    return { threadKey: scopedThreadKey(threadRef), threadRef };
  });
  const outcome = await archiveSelectedThreadEntries({
    entries,
    archive: ({ threadRef }, onArchived) => input.archiveThread(threadRef, { onArchived }),
  });
  for (const failure of outcome.followupFailures) {
    if (isAtomCommandInterrupted(failure)) continue;
    failureToast("Thread archived, but navigation failed", squashAtomCommandFailure(failure));
  }
  if (outcome.mutationFailure && !isAtomCommandInterrupted(outcome.mutationFailure)) {
    failureToast(
      outcome.archivedThreadKeys.length > 0
        ? `Archived ${pluralThreads(outcome.archivedThreadKeys.length)}, then failed`
        : "Failed to archive threads",
      squashAtomCommandFailure(outcome.mutationFailure),
    );
  }

  const archivedKeys = new Set(outcome.archivedThreadKeys);
  const archivedRefs = entries
    .filter((entry) => archivedKeys.has(entry.threadKey))
    .map((entry) => entry.threadRef);
  const { unarchiveThread } = input;
  if (unarchiveThread && archivedRefs.length > 0) {
    const toastId = toastManager.add({
      type: "success",
      title: `Archived ${pluralThreads(archivedRefs.length)}`,
      description: "Find them in Settings → Archive.",
      timeout: 5_000,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void unarchiveThreads(archivedRefs, unarchiveThread);
        },
      },
      data: { hideCopyButton: true },
    });
  }
  return archivedRefs;
}
