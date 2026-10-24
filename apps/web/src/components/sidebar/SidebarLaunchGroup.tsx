import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadGroupBlock, ThreadGroupRow } from "@t3tools/client-runtime/state/thread-groups";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  resolveSidebarThreadStatus,
  type SidebarSection,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

/** A launch block as rendered: `rows` drops what a folded group hides. */
export interface RenderedLaunchBlock {
  readonly block: ThreadGroupBlock<EnvironmentThreadShell, SidebarSection>;
  /** The launcher row always renders: it holds the fold toggle and footer. */
  readonly rows: readonly ThreadGroupRow<EnvironmentThreadShell, SidebarSection>[];
  readonly folded: boolean;
}

const sameLaunchRows = (
  left: readonly ThreadGroupRow<EnvironmentThreadShell, SidebarSection>[],
  right: readonly ThreadGroupRow<EnvironmentThreadShell, SidebarSection>[],
) =>
  left.length === right.length &&
  left.every(
    (row, index) =>
      row.thread === right[index]!.thread &&
      row.section === right[index]!.section &&
      row.rootKey === right[index]!.rootKey,
  );

/** True when a rebuilt group renders the same as before. */
export const sameRenderedLaunchBlock = (left: RenderedLaunchBlock, right: RenderedLaunchBlock) =>
  left.folded === right.folded &&
  left.block.leadKey === right.block.leadKey &&
  sameLaunchRows(left.block.rows, right.block.rows) &&
  sameLaunchRows(left.rows, right.rows);

// Where a row's list item sits in its launch group's box. The box is drawn
// on each row's list item so every row keeps its own drag handle. "only" is
// a folded group with just the launcher showing.
export type LaunchGroupPlace = "top" | "middle" | "bottom" | "only";

export function launchGroupBoxClassName(place: LaunchGroupPlace | null) {
  if (place === null) return null;
  return cn(
    // Rows touch so the list gap does not break the box sides.
    "overflow-hidden border-x border-sidebar-border py-0",
    place === "top" || place === "only"
      ? "mt-1 rounded-t-lg border-t"
      : "-mt-px border-t border-t-sidebar-border/60",
    (place === "bottom" || place === "only") && "mb-1 rounded-b-lg border-b",
  );
}

const launchGroupDotClassName: Record<SidebarThreadStatus, string> = {
  working: "bg-info",
  approval: "bg-warning",
  input: "bg-indigo-500 dark:bg-indigo-300",
  limited: "bg-warning",
  failed: "bg-error",
  waiting: "bg-muted-foreground/60",
  ready: "bg-muted-foreground/30",
};

// Strip under a folded launch group's launcher. It counts the launched
// threads with one dot per thread state. Click opens the group; right-click
// opens the group menu.
export function SidebarLaunchGroupFooter(props: {
  group: RenderedLaunchBlock;
  onToggle: (groupKey: string) => void;
  onContextMenu: (groupKey: string, position: { x: number; y: number }) => void;
}) {
  const { block } = props.group;
  const launched = block.rows.slice(1);
  return (
    <button
      type="button"
      data-testid="sidebar-launch-group-footer"
      aria-expanded={false}
      onClick={() => props.onToggle(block.key)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(block.key, { x: event.clientX, y: event.clientY });
      }}
      className="flex h-7 w-full cursor-pointer items-center gap-1 border-t border-sidebar-border/60 px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
      {launched.length} {launched.length === 1 ? "thread" : "threads"}
      <span aria-hidden className="ml-auto flex items-center gap-1">
        {launched.map((row) => (
          <span
            key={row.key}
            className={cn(
              "size-1.5 rounded-full",
              launchGroupDotClassName[resolveSidebarThreadStatus(row.thread)],
            )}
          />
        ))}
      </span>
    </button>
  );
}
