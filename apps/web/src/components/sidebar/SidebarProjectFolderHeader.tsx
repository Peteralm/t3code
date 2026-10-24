import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { type SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenInbox: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenInbox } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const folderDot = collapsed
    ? resolveSidebarFolderDot(
        hiddenInbox.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
          ),
        })),
      )
    : null;
  return (
    <li className="group/project-folder relative mt-1 list-none first:mt-0">
      <button
        type="button"
        aria-expanded={!collapsed}
        data-testid="sidebar-project-folder"
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 pr-9 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
            !collapsed && "rotate-90",
          )}
        />
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {folderDot ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[folderDot])}
          />
        ) : null}
        {collapsed && hiddenInbox.length > 0 ? (
          <span className="shrink-0 text-xs text-secondary-label tabular-nums">
            {hiddenInbox.length}
          </span>
        ) : null}
      </button>
      <span className="absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`New thread in ${group.displayName}`}
          onClick={() => props.onNewThread(group)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </span>
    </li>
  );
});
