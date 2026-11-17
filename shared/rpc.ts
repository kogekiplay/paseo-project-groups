import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Removes a project from Paseo through the CLI on the daemon host, because the plugin SDK has
 * no project removal call. Paseo archives the project's workspaces; files on disk stay.
 */
export const removeProjectRpc = defineRpc({
  name: "project.remove",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({ removedWorkspaceIds: z.array(z.string()) }),
});

/** Paseo's uploaded or discovered icon. SVGs use the host renderer on native clients too. */
export const projectIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), uri: z.string() }),
  z.object({ kind: z.literal("svg"), svg: z.string() }),
]);

export type ProjectIcon = z.infer<typeof projectIconSchema>;

export const projectIconRpc = defineRpc({
  name: "project.icon",
  input: z.object({ hostId: z.string().min(1), projectId: z.string().min(1) }),
  output: z.object({ icon: projectIconSchema.nullable() }),
});
