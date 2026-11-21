import {
  useAgent,
  useWorkspace,
  type AgentRef,
  type PluginSidebarViewProps,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useT } from "./i18n";
import { useLook } from "./look";
import { relationshipRows, type AgentRelationships } from "./relationship-model";
import { RunningSpinner } from "./running-spinner";
import { StatusDot, WorkspaceRow, useRowStyles } from "./rows";
import { sidebarNavProps } from "./web";

export interface RelationshipActions {
  view: PluginSidebarViewProps;
  model: AgentRelationships;
  highlighted: ReadonlySet<string>;
  expanded: string | null;
  open(agent: AgentRef): void;
  toggle(key: string): void;
  hover(key: string | null): void;
  register(key: string, node: View | null): void;
  refresh(): void;
}

type Role = "parent" | "child" | "sibling";

function stopPress(event?: { stopPropagation?: () => void }) {
  event?.stopPropagation?.();
}

function isAgentSelected(sidebar: RelationshipActions, agent: AgentRef, singleWorkspace?: WorkspaceRef): boolean {
  const activeAgent = sidebar.view.active.agent;
  if (activeAgent && sidebar.model.agents.has(activeAgent.key)) {
    return activeAgent.key === agent.key;
  }
  return !!singleWorkspace && sidebar.view.active.workspace?.key === singleWorkspace.key;
}

function AgentLinkContent({
  agent,
  workspaceRef,
  title,
  running,
  role,
  sidebar,
  detail = false,
  primary = false,
  compactCue = false,
}: {
  agent: AgentRef;
  workspaceRef: WorkspaceRef;
  title: string | null;
  running: boolean;
  role?: Role;
  sidebar: RelationshipActions;
  detail?: boolean;
  primary?: boolean;
  compactCue?: boolean;
}) {
  const look = useLook();
  const workspace = useWorkspace(workspaceRef, (item) => ({
    name: (look.workspaceTitle === "branch" ? item.branch : null) ?? item.title ?? item.name,
    project: item.projectDisplayName,
  }));
  const t = useT();
  const { view } = sidebar;
  const theme = view.theme;
  const styles = useRowStyles(theme);
  const compact = view.layout.compact;
  const name = title ?? workspace?.name ?? agent.id;
  const fullLabel = role ? t(`relation.${role}`, { name }) : name;
  const textLabel = compactCue ? name : fullLabel;
  const active = isAgentSelected(sidebar, agent);
  const spinnerSize = Math.max(10, look.small - 1);

  if (detail) {
    return (
      <Pressable
        {...sidebarNavProps({ pgNav: "", pgAgent: agent.key })}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={workspace?.project ? `${name} (${workspace.project})` : t("workspace.open", { name })}
        onPress={(event) => {
          stopPress(event);
          sidebar.open(agent);
        }}
        onHoverIn={() => sidebar.hover(agent.key)}
        onHoverOut={() => sidebar.hover(null)}
        style={[
          {
            alignSelf: "stretch",
            minWidth: 0,
            minHeight: compact ? 40 : 34,
            justifyContent: "center",
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 5,
            gap: 2,
          },
          active ? styles.selected : null,
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 }}>
          {look.showStatusDots && running ? <RunningSpinner color={theme.colors.accent} size={spinnerSize} /> : null}
          <Text
            selectable={false}
            numberOfLines={1}
            style={[
              styles.detail,
              {
                flex: 1,
                minWidth: 0,
                color: theme.colors.foreground,
                fontWeight: active ? "600" : "500",
              },
            ]}
          >
            {name}
          </Text>
        </View>
        {workspace?.project ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 }}>
            <Icon name="Folder" size={Math.max(9, look.small - 1)} color={theme.colors.foregroundMuted} />
            <Text
              selectable={false}
              numberOfLines={2}
              style={[styles.detail, { flex: 1, minWidth: 0 }]}
            >
              {workspace.project}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  }

  const accentTone = primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={role ? fullLabel : t("workspace.open", { name })}
      hitSlop={4}
      onPress={(event) => {
        stopPress(event);
        sidebar.open(agent);
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        minWidth: 0,
        flexShrink: 1,
        maxWidth: "100%",
        gap: 4,
        minHeight: compactCue ? (compact ? 28 : 20) : compact ? 34 : 24,
        paddingHorizontal: compactCue ? 6 : compact ? 8 : 7,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: accentTone ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface0,
      }}
    >
      {role === "parent" ? (
        <Icon
          name="CornerUpLeft"
          size={Math.max(10, look.small - 1)}
          color={accentTone ? theme.colors.accent : theme.colors.foregroundMuted}
        />
      ) : null}
      {look.showStatusDots && running ? <RunningSpinner color={theme.colors.accent} size={spinnerSize} /> : null}
      <Text
        selectable={false}
        numberOfLines={1}
        style={[
          styles.detail,
          {
            flexShrink: 1,
            color: accentTone ? theme.colors.accent : theme.colors.foreground,
            fontWeight: accentTone ? "500" : "400",
          },
        ]}
      >
        {textLabel}
      </Text>
    </Pressable>
  );
}

function AgentLink({
  agent,
  role,
  sidebar,
  detail = false,
  primary = false,
  compactCue = false,
}: {
  agent: AgentRef;
  role?: Role;
  sidebar: RelationshipActions;
  detail?: boolean;
  primary?: boolean;
  compactCue?: boolean;
}) {
  const snapshot = useAgent(agent, (item) => ({
    title: item.title,
    workspace: item.workspace,
    status: item.status,
  }));
  if (!snapshot) return null;
  return (
    <AgentLinkContent
      agent={agent}
      workspaceRef={snapshot.workspace}
      title={snapshot.title}
      running={snapshot.status === "running"}
      role={role}
      sidebar={sidebar}
      detail={detail}
      primary={primary}
      compactCue={compactCue}
    />
  );
}

function ChildCount({ agent, sidebar, count }: { agent: AgentRef; sidebar: RelationshipActions; count: number }) {
  const t = useT();
  const look = useLook();
  const theme = sidebar.view.theme;
  const styles = useRowStyles(theme);
  const expanded = sidebar.expanded === agent.key;
  const iconColor = expanded ? theme.colors.accentForeground : theme.colors.foregroundMuted;
  const textColor = expanded ? theme.colors.accentForeground : theme.colors.foregroundMuted;

  return (
    <Pressable
      {...sidebarNavProps({ pgFold: "" })}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={t("relation.children", { count })}
      onPress={(event) => {
        stopPress(event);
        sidebar.toggle(agent.key);
      }}
      hitSlop={4}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        flexShrink: 0,
        paddingHorizontal: 6,
        minHeight: sidebar.view.layout.compact ? 28 : 20,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: expanded ? theme.colors.accent : theme.colors.border,
        backgroundColor: expanded ? theme.colors.accent : theme.colors.surface0,
      }}
    >
      <Icon name="GitFork" size={Math.max(10, look.small - 1)} color={iconColor} />
      <Text selectable={false} numberOfLines={1} style={[styles.detail, { color: textColor, fontWeight: "500" }]}>
        {t("relation.count", { count })}
      </Text>
    </Pressable>
  );
}

function RelationDetails({
  agent,
  sidebar,
  indent,
  showDrawer,
  selected,
}: {
  agent: AgentRef;
  sidebar: RelationshipActions;
  indent: number;
  showDrawer: boolean;
  selected: boolean;
}) {
  const t = useT();
  const theme = sidebar.view.theme;
  const styles = useRowStyles(theme);
  const parent = sidebar.model.parents.get(agent.key);
  const children = sidebar.model.children.get(agent.key);
  const siblings = parent
    ? sidebar.model.children.get(parent.key)?.filter((item) => item.key !== agent.key)
    : undefined;
  const drawer = Boolean(showDrawer && children?.length && sidebar.expanded === agent.key);
  const showQuickJump = selected && (Boolean(parent) || Boolean(siblings?.length) || (!drawer && Boolean(children?.length)));
  if (!drawer && !showQuickJump) return null;

  const leftMargin = Math.max(8, indent - 2);
  return (
    <View style={{ marginLeft: leftMargin, marginRight: 6, marginTop: 2, marginBottom: 4, gap: 4 }}>
      {showQuickJump ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            paddingLeft: 8,
            paddingVertical: 3,
            borderLeftWidth: 2,
            borderLeftColor: theme.colors.accent,
          }}
        >
          {parent ? <AgentLink agent={parent} role="parent" sidebar={sidebar} primary /> : null}
          {siblings?.map((item) => (
            <AgentLink key={item.key} agent={item} role="sibling" sidebar={sidebar} />
          ))}
          {!drawer
            ? children?.map((item, index) => (
                <AgentLink
                  key={item.key}
                  agent={item}
                  role="child"
                  sidebar={sidebar}
                  primary={!parent && index === 0}
                />
              ))
            : null}
        </View>
      ) : null}
      {drawer && children ? (
        <View
          style={{
            paddingLeft: 6,
            paddingRight: 4,
            paddingVertical: 4,
            borderLeftWidth: 1.5,
            borderLeftColor: theme.colors.accent,
            backgroundColor: theme.colors.surface1,
            borderTopRightRadius: 6,
            borderBottomRightRadius: 6,
            gap: 2,
          }}
        >
          <Text
            selectable={false}
            numberOfLines={1}
            style={[styles.detail, { paddingHorizontal: 8, paddingVertical: 2 }]}
          >
            {t("relation.children", { count: children.length })}
          </Text>
          {children.map((child) => (
            <AgentLink key={child.key} agent={child} sidebar={sidebar} detail />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RelationAnchor({
  agent,
  sidebar,
  children,
}: {
  agent: AgentRef;
  sidebar: RelationshipActions;
  children: ReactNode;
}) {
  const register = sidebar.register;
  const ref = useCallback((node: View | null) => register(agent.key, node), [agent.key, register]);
  return (
    <View ref={ref} collapsable={false} onLayout={sidebar.refresh}>
      {children}
    </View>
  );
}

function TreeGuides({
  depth,
  last,
  guides,
  step,
  baseIndent,
  color,
}: {
  depth: number;
  last: boolean;
  guides: readonly boolean[];
  step: number;
  baseIndent: number;
  color: string;
}) {
  if (depth <= 0) return null;
  const visibleDepth = Math.min(4, depth);
  const elbowX = baseIndent + (visibleDepth - 1) * step + 3;
  return (
    <>
      {guides.slice(0, visibleDepth - 1).map((active, level) =>
        active ? (
          <View
            key={level}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: baseIndent + level * step + 3,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: color,
            }}
          />
        ) : null,
      )}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: elbowX,
          top: 0,
          height: last ? "50%" : "100%",
          width: 1,
          backgroundColor: color,
        }}
      />
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: elbowX,
          top: "50%",
          width: Math.max(6, step - 5),
          height: 1,
          backgroundColor: color,
        }}
      />
    </>
  );
}

function AgentRowContent({
  agent,
  workspaceRef,
  title: agentTitle,
  status,
  requiresAttention,
  indent,
  sidebar,
  tree = false,
  last = false,
  branchDepth = 0,
  guides = [],
  treeStep = 14,
  treeBase = 12,
}: {
  agent: AgentRef;
  workspaceRef: WorkspaceRef;
  title: string | null;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  requiresAttention: boolean;
  indent: number;
  sidebar: RelationshipActions;
  tree?: boolean;
  last?: boolean;
  branchDepth?: number;
  guides?: readonly boolean[];
  treeStep?: number;
  treeBase?: number;
}) {
  const look = useLook();
  const workspace = useWorkspace(workspaceRef, (item) => ({
    title: (look.workspaceTitle === "branch" ? item.branch : null) ?? item.title ?? item.name,
    project: item.projectDisplayName,
    additions: item.diffStat?.additions ?? 0,
    deletions: item.diffStat?.deletions ?? 0,
  }));
  const [hovered, setHovered] = useState(false);
  const { view, model } = sidebar;
  const theme = view.theme;
  const t = useT();
  const styles = useRowStyles(theme);

  const title = agentTitle ?? workspace?.title ?? agent.id;
  const active = isAgentSelected(sidebar, agent);
  const count = model.children.get(agent.key)?.length ?? 0;
  const parent = model.parents.get(agent.key);
  const running = status === "running";
  const indicator = running
    ? theme.colors.accent
    : status === "error"
      ? theme.colors.statusDanger
      : requiresAttention
        ? theme.colors.statusWarning
        : "transparent";
  const showDiff = tree && look.trailing === "diff" && ((workspace?.additions ?? 0) > 0 || (workspace?.deletions ?? 0) > 0);
  const lineColor = sidebar.highlighted.has(agent.key) ? theme.colors.accent : theme.colors.border;

  return (
    <>
      <RelationAnchor agent={agent} sidebar={sidebar}>
        <View
          {...sidebarNavProps({ pgRow: "" })}
          style={[
            styles.rounded,
            active
              ? styles.selected
              : sidebar.highlighted.has(agent.key)
                ? { backgroundColor: theme.colors.surface1 }
                : null,
            {
              flexDirection: "row",
              alignItems: "center",
              paddingLeft: indent,
              paddingRight: 8,
              gap: 5,
            },
          ]}
        >
          {tree ? (
            <TreeGuides
              depth={branchDepth}
              last={last}
              guides={guides}
              step={treeStep}
              baseIndent={treeBase}
              color={lineColor}
            />
          ) : null}
          <Pressable
            {...sidebarNavProps({ pgNav: "", pgAgent: agent.key })}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t("workspace.open", { name: title })}
            onPress={() => sidebar.open(agent)}
            onHoverIn={() => {
              setHovered(true);
              sidebar.hover(agent.key);
            }}
            onHoverOut={() => {
              setHovered(false);
              sidebar.hover(null);
            }}
            style={{
              flex: 1,
              flexDirection: "row",
              minWidth: 0,
              alignItems: "center",
              minHeight: look.row,
              paddingVertical: tree && workspace?.project ? 3 : 0,
              gap: 5,
            }}
          >
            {look.showStatusDots ? <StatusDot color={indicator} running={running} /> : null}
            <View style={{ flex: 1, minWidth: 0, gap: tree && workspace?.project ? 1 : 0 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
                <Text
                  selectable={false}
                  numberOfLines={1}
                  style={[
                    styles.workspaceName,
                    active ? { opacity: 1, fontWeight: "600" } : hovered ? { opacity: 1 } : null,
                  ]}
                >
                  {title}
                </Text>
                {showDiff && workspace ? (
                  <Text selectable={false} numberOfLines={1} style={[styles.detail, { flexShrink: 0 }]}>
                    <Text style={{ color: theme.colors.statusSuccess }}>+{workspace.additions}</Text>{" "}
                    <Text style={{ color: theme.colors.statusDanger }}>−{workspace.deletions}</Text>
                  </Text>
                ) : null}
              </View>
              {tree && workspace?.project ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 }}>
                  <Icon name="Folder" size={Math.max(9, look.small - 1)} color={theme.colors.foregroundMuted} />
                  <Text
                    selectable={false}
                    numberOfLines={2}
                    style={[styles.detail, { flex: 1, minWidth: 0 }]}
                  >
                    {workspace.project}
                  </Text>
                </View>
              ) : null}
            </View>
          </Pressable>
          {!tree && count > 0 ? <ChildCount agent={agent} count={count} sidebar={sidebar} /> : null}
          {!tree && !active && parent ? (
            <View style={{ maxWidth: view.layout.compact ? 88 : 96, flexShrink: 1, minWidth: 0 }}>
              <AgentLink agent={parent} role="parent" sidebar={sidebar} compactCue />
            </View>
          ) : null}
        </View>
      </RelationAnchor>
      <RelationDetails agent={agent} sidebar={sidebar} indent={indent} showDrawer={!tree} selected={active} />
    </>
  );
}

function AgentRow({
  agent,
  indent,
  sidebar,
  tree = false,
  last = false,
  branchDepth = 0,
  guides,
  treeStep,
  treeBase,
}: {
  agent: AgentRef;
  indent: number;
  sidebar: RelationshipActions;
  tree?: boolean;
  last?: boolean;
  branchDepth?: number;
  guides?: readonly boolean[];
  treeStep?: number;
  treeBase?: number;
}) {
  const info = useAgent(agent, (item) => ({
    title: item.title,
    workspace: item.workspace,
    status: item.status,
    requiresAttention: item.requiresAttention,
  }));
  if (!info) return null;
  return (
    <AgentRowContent
      agent={agent}
      workspaceRef={info.workspace}
      title={info.title}
      status={info.status}
      requiresAttention={info.requiresAttention}
      indent={indent}
      sidebar={sidebar}
      tree={tree}
      last={last}
      branchDepth={branchDepth}
      guides={guides}
      treeStep={treeStep}
      treeBase={treeBase}
    />
  );
}

export function RelationshipWorkspace({
  reference,
  indent,
  sidebar,
  onMenu,
}: {
  reference: WorkspaceRef;
  indent: number;
  sidebar: RelationshipActions;
  onMenu: (ref: WorkspaceRef) => void;
}) {
  const { model, view } = sidebar;
  const agents = model.byWorkspace.get(reference.key) ?? [];
  const related = agents.filter((agent) => model.parents.has(agent.key) || model.children.has(agent.key));
  if (!related.length) {
    return <WorkspaceRow reference={reference} indent={indent} view={view} onMenu={onMenu} />;
  }
  // Keep a single WorkspaceRow per workspace (never duplicate a parent/subagent row underneath).
  // When multiple root agents coexist in the same workspace, prefer the active related root and
  // preserve default workspace navigation on the row itself.
  const singleRoot = agents.length === 1;
  const agent = related.find((item) => view.active.agent?.key === item.key) ?? related[0];
  const count = model.children.get(agent.key)?.length ?? 0;
  const parent = model.parents.get(agent.key);
  const selected = isAgentSelected(sidebar, agent, singleRoot ? reference : undefined);

  return (
    <>
      <RelationAnchor agent={agent} sidebar={sidebar}>
        <WorkspaceRow
          reference={reference}
          indent={indent}
          view={view}
          onMenu={onMenu}
          relation={{
            key: agent.key,
            highlighted: sidebar.highlighted.has(agent.key),
            open: singleRoot ? () => sidebar.open(agent) : () => view.navigation.openWorkspace(reference),
            onHover: (hover) => sidebar.hover(hover ? agent.key : null),
            trailing: (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 }}>
                {count > 0 ? <ChildCount agent={agent} count={count} sidebar={sidebar} /> : null}
                {!selected && parent ? (
                  <View style={{ maxWidth: view.layout.compact ? 88 : 96, flexShrink: 1, minWidth: 0 }}>
                    <AgentLink agent={parent} role="parent" sidebar={sidebar} compactCue />
                  </View>
                ) : null}
              </View>
            ),
          }}
        />
      </RelationAnchor>
      <RelationDetails agent={agent} sidebar={sidebar} indent={indent} showDrawer selected={selected} />
    </>
  );
}

export function RelationshipsList({ sidebar }: { sidebar: RelationshipActions }) {
  const { theme, layout } = sidebar.view;
  const styles = useRowStyles(theme);
  const t = useT();
  const nodes = relationshipRows(sidebar.model);
  if (!nodes.length) return <Text style={[styles.detail, { padding: 12 }]}>{t("relation.empty")}</Text>;
  const base = layout.compact ? 10 : 12;
  const step = layout.compact ? 12 : 14;
  return (
    <View style={{ paddingTop: 4, gap: 2 }}>
      {nodes.map(({ agent, depth, last, guides }) => (
        <AgentRow
          key={agent.key}
          agent={agent}
          sidebar={sidebar}
          indent={base + Math.min(4, depth) * step}
          tree
          last={last}
          branchDepth={depth}
          guides={guides}
          treeStep={step}
          treeBase={base}
        />
      ))}
    </View>
  );
}
