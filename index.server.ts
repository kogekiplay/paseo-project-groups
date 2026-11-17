import type { PluginServerContext } from "@getpaseo/plugin/server";
import { removeProject } from "./server/remove-project";
import { createProjectIconReader } from "./server/project-icon";
import { projectIconRpc, removeProjectRpc } from "./shared/rpc";
import { decorationsDocument, groupsDocument } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // Host-scoped documents are stored by the daemon, so the server entry registers them.
  server.registerSettings(groupsDocument);
  server.registerSettings(decorationsDocument);
  server.handle(removeProjectRpc, removeProject);
  const icons = createProjectIconReader();
  server.handle(projectIconRpc, icons.read);
  return () => icons.close();
}
