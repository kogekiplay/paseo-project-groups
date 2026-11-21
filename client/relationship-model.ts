import type { AgentRef } from "@getpaseo/plugin/client";

interface AgentGroup {
  readonly key: string;
  readonly items: readonly AgentRef[];
}

export function agentRelationships(groups: readonly AgentGroup[]) {
  const agents = new Map<string, AgentRef>();
  const workspaces = new Map<string, string>();
  const byWorkspace = new Map<string, readonly AgentRef[]>();
  for (const group of groups) {
    if (!group.key.startsWith("w:")) continue;
    const key = group.key.slice(2);
    byWorkspace.set(key, group.items);
    for (const agent of group.items) {
      agents.set(agent.key, agent);
      workspaces.set(agent.key, key);
    }
  }

  const parents = new Map<string, AgentRef>();
  const children = new Map<string, AgentRef[]>();
  for (const group of groups) {
    if (!group.key.startsWith("a:")) continue;
    const parent = agents.get(group.key.slice(2));
    if (!parent) continue;
    for (const child of group.items) {
      if (child.key === parent.key || !agents.has(child.key)) continue;
      parents.set(child.key, parent);
      const siblings = children.get(parent.key);
      if (siblings) siblings.push(child);
      else children.set(parent.key, [child]);
    }
  }

  return { agents, workspaces, byWorkspace, parents, children };
}

export type AgentRelationships = ReturnType<typeof agentRelationships>;

/** Show the selected agent's parent and siblings, or its own children if it is a root. */
export function activeFamily(relationships: AgentRelationships, key: string | null) {
  if (!key) return null;
  const parent = relationships.parents.get(key) ?? relationships.agents.get(key);
  const children = parent && relationships.children.get(parent.key);
  return parent && children?.length ? { parent, children } : null;
}

export interface RelationshipRow {
  readonly agent: AgentRef;
  readonly depth: number;
  readonly last: boolean;
  /** For each ancestor depth < `depth`, true when that ancestor has later siblings needing a vertical guide. */
  readonly guides: readonly boolean[];
}

/** Flatten the tree for rendering, putting connected families first and surviving stale links. */
export function relationshipRows(relationships: AgentRelationships): RelationshipRow[] {
  const rows: RelationshipRow[] = [];
  const seen = new Set<string>();
  const visit = (agent: AgentRef, depth: number, last: boolean, guides: readonly boolean[]) => {
    if (seen.has(agent.key)) return;
    seen.add(agent.key);
    rows.push({ agent, depth, last, guides });
    const children = relationships.children.get(agent.key) ?? [];
    const nextGuides = depth === 0 ? guides : [...guides, !last];
    children.forEach((child, index) => visit(child, depth + 1, index === children.length - 1, nextGuides));
  };
  const roots: AgentRef[] = [];
  for (const agent of relationships.agents.values()) {
    if (!relationships.parents.has(agent.key)) roots.push(agent);
  }
  for (const agent of roots) {
    if ((relationships.children.get(agent.key)?.length ?? 0) > 0) visit(agent, 0, true, []);
  }
  for (const agent of roots) visit(agent, 0, true, []);
  // Stale or inconsistent parent links must not hide an agent or recurse forever.
  for (const agent of relationships.agents.values()) visit(agent, 0, true, []);
  return rows;
}
