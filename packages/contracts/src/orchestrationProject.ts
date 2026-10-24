import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectScript, ReceivedProjectIcon } from "./project.ts";

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ReceivedProjectIcon)),
  scripts: Schema.Array(ProjectScript),
  // Pinned projects lead every project picker, ordered by pinOrderKey (a
  // fractional index, like a thread's). Optional so older servers decode.
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Archived projects leave the pickers and their threads leave thread lists.
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;
