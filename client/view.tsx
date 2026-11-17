import {
  useProjects,
  useRpc,
  useSettings,
  useWorkspaces,
  type PluginSidebarViewProps,
  type ProjectRef,
  type WorkspaceRef,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { removeProjectRpc } from "../shared/rpc";
import {
  appearanceDocument,
  decorationsDocument,
  groupsDocument,
  layoutDocument,
  type Decoration,
  type DecorationKind,
  type DecorationsValues,
  type ProjectGroup,
} from "../shared/settings";
import {
  DecorateDialog,
  DecorationsContext,
  DecorIcon,
  EMPTY_DECORATION,
  isEmptyDecoration,
  useDecorations,
  type DecorateTarget,
  type Decorations,
} from "./decor";
import { DeleteGroupDialog, ProjectMenuDialog, RemoveProjectDialog, WorkspaceMenuDialog } from "./dialogs";
import { DragProvider, useDragController } from "./drag";
import type { Hit } from "./hit";
import { useT } from "./i18n";
import { DEFAULT_APPEARANCE, LookContext, lookFrom, useLook, useViewActions } from "./look";
import { ProjectIcon } from "./project-icon";
import {
  addGroup,
  moveGroup,
  moveProject,
  nextGroupName,
  removeGroup,
  renameGroup,
  type DragSubject,
  type DropTarget,
} from "./model";
import {
  EmptyGroupRow,
  GroupHeader,
  ProjectBlock,
  SectionHeading,
  TextButton,
  UngroupedHeader,
  WorkspaceRow,
  useRowStyles,
} from "./rows";

const UNGROUPED_KEY = "u";
const EMPTY_GROUPS: readonly ProjectGroup[] = [];
const EMPTY_KEYS: readonly string[] = [];
const EMPTY_DECORATIONS: DecorationsValues = { groups: {}, projects: {}, workspaces: {} };

type Theme = PluginSidebarViewProps["theme"];

type Dialog =
  | { kind: "project"; reference: ProjectRef }
  | { kind: "remove-project"; reference: ProjectRef }
  | { kind: "workspace"; reference: WorkspaceRef }
  | { kind: "delete-group"; group: ProjectGroup }
  | { kind: "decorate"; target: DecorateTarget };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function DropIndicator({ hit, theme }: { hit: Hit; theme: Theme }) {
  const indicator = hit.indicator;
  if (indicator.kind === "line") {
    return (
      <View
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          top: indicator.y - 1,
          height: 2,
          borderRadius: 1,
          backgroundColor: theme.colors.accent,
          pointerEvents: "none",
        }}
      />
    );
  }
  return (
    <View
      style={{
        position: "absolute",
        left: 4,
        right: 4,
        top: indicator.y,
        height: indicator.height,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: theme.colors.accent,
        pointerEvents: "none",
      }}
    />
  );
}

function Ghost({ subject, reference, y, theme }: {
  subject: DragSubject;
  reference?: ProjectRef;
  y: Animated.Value;
  theme: Theme;
}) {
  const look = useLook();
  const decoration = useDecorations().get(
    subject.kind === "group" ? "groups" : "projects",
    subject.kind === "group" ? subject.id : subject.key,
  );
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: 20,
        right: 8,
        top: 0,
        minHeight: look.row,
        // Opaque with a shadow so rows underneath never show through the dragged row.
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 6,
        paddingHorizontal: 10,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        pointerEvents: "none",
        transform: [{ translateY: y }],
      }}
    >
      {reference ? (
        <ProjectIcon
          reference={reference}
          icon={decoration.icon}
          color={decoration.color ?? theme.colors.foregroundMuted}
          size={look.icon}
        />
      ) : (
        <DecorIcon
          icon={decoration.icon}
          fallback={subject.kind === "group" ? "Layers" : "Folder"}
          color={decoration.color ?? theme.colors.foregroundMuted}
          size={look.icon}
        />
      )}
      <Text
        numberOfLines={1}
        style={{
          color: decoration.color ?? theme.colors.foreground,
          fontSize: look.text,
          lineHeight: look.line,
        }}
      >
        {subject.label}
      </Text>
    </Animated.View>
  );
}

function StatusMessage({
  message,
  view,
  actions,
}: {
  message: string;
  view: PluginSidebarViewProps;
  actions?: { label: string; icon: string; onPress: () => void }[];
}) {
  const styles = useRowStyles(view.theme);
  return (
    <View style={{ padding: 12, gap: 4 }}>
      <Text style={styles.detail}>{message}</Text>
      {actions?.map((action) => (
        <TextButton
          key={action.label}
          icon={action.icon}
          label={action.label}
          view={view}
          onPress={action.onPress}
        />
      ))}
    </View>
  );
}

function ToolbarRow({ view, onCreateGroup }: { view: PluginSidebarViewProps; onCreateGroup: () => void }) {
  const t = useT();
  const look = useLook();
  const actions = useViewActions();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingTop: 4,
        paddingBottom: 4,
        borderBottomWidth: 1,
        borderBottomColor: view.theme.colors.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <TextButton icon="FolderPlus" label={t("sidebar.newGroup")} view={view} onPress={onCreateGroup} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.appearance")}
        hitSlop={4}
        onPress={actions.openAppearanceSettings}
        style={{ padding: 6, marginRight: 6, borderRadius: 6 }}
      >
        <Icon name="SlidersHorizontal" size={look.icon} color={view.theme.colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

export function GroupsView(view: PluginSidebarViewProps) {
  const appearance = useSettings(appearanceDocument);
  const look = useMemo(
    () => lookFrom(appearance.status === "ready" ? appearance.values : DEFAULT_APPEARANCE),
    [appearance],
  );
  return (
    <LookContext.Provider value={look}>
      <GroupsList {...view} />
    </LookContext.Provider>
  );
}

function GroupsList(view: PluginSidebarViewProps) {
  const groupsState = useSettings(groupsDocument);
  const layoutState = useSettings(layoutDocument);
  const decorationsState = useSettings(decorationsDocument);
  const removeProjectCall = useRpc(removeProjectRpc);
  const toast = useToast();
  const t = useT();
  const look = useLook();
  const styles = useRowStyles(view.theme);

  // Optimistic copies make drops and folding feel instant; they clear when the saved
  // revision arrives or the save fails.
  const [pendingGroups, setPendingGroups] = useState<ProjectGroup[] | null>(null);
  const [pendingCollapsed, setPendingCollapsed] = useState<string[] | null>(null);
  const groupsRevision = groupsState.status === "ready" ? groupsState.revision : null;
  const layoutRevision = layoutState.status === "ready" ? layoutState.revision : null;
  useEffect(() => setPendingGroups(null), [groupsRevision]);
  useEffect(() => setPendingCollapsed(null), [layoutRevision]);
  const [pendingDecorations, setPendingDecorations] = useState<DecorationsValues | null>(null);
  const decorationsRevision = decorationsState.status === "ready" ? decorationsState.revision : null;
  useEffect(() => setPendingDecorations(null), [decorationsRevision]);
  const decorationValues: DecorationsValues =
    pendingDecorations ?? (decorationsState.status === "ready" ? decorationsState.values : EMPTY_DECORATIONS);

  const groups: readonly ProjectGroup[] =
    pendingGroups ?? (groupsState.status === "ready" ? groupsState.values.groups : EMPTY_GROUPS);
  const collapsedList: readonly string[] =
    pendingCollapsed ?? (layoutState.status === "ready" ? layoutState.values.collapsed : EMPTY_KEYS);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null);
  renamingRef.current = renamingId;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [removing, setRemoving] = useState(false);
  const closeDialog = useCallback(() => setDialog(null), []);

  const projects = useProjects({ orderBy: "displayName" });
  const pinned = useWorkspaces({
    where: (item) => look.showPinned && !!item.pinnedAt && !item.background && !item.archivingAt,
    orderBy: "pinnedAt",
  });
  const byKey = useMemo(() => new Map(projects.map((project) => [project.key, project])), [projects]);
  const ungrouped = useMemo(() => {
    const grouped = new Set(groups.flatMap((group) => group.projects));
    return projects.filter((project) => !grouped.has(project.key));
  }, [groups, projects]);

  const saveGroups = useCallback(
    async (next: ProjectGroup[]) => {
      if (groupsState.status !== "ready") return;
      setPendingGroups(next);
      const saved = await groupsState.save({ groups: next }, groupsState.revision);
      if (!saved) {
        setPendingGroups(null);
        toast.error(t("toast.groupsSaveFailed"));
      }
    },
    [groupsState, t, toast],
  );

  const saveDecorations = useCallback(
    async (next: DecorationsValues) => {
      if (decorationsState.status !== "ready") {
        toast.error(t("toast.looksNotLoaded"));
        return;
      }
      setPendingDecorations(next);
      const saved = await decorationsState.save(next, decorationsState.revision);
      if (!saved) {
        setPendingDecorations(null);
        toast.error(t("toast.looksSaveFailed"));
      }
    },
    [decorationsState, t, toast],
  );

  /** Returns the document with one entry replaced, or removed when it is back to defaults. */
  const withDecoration = useCallback(
    (kind: DecorationKind, key: string, decoration: Decoration | null): DecorationsValues | null => {
      const bucket = { ...decorationValues[kind] };
      const had = key in bucket;
      if (!decoration || isEmptyDecoration(decoration)) {
        if (!had) return null;
        delete bucket[key];
      } else {
        bucket[key] = decoration;
      }
      return { ...decorationValues, [kind]: bucket };
    },
    [decorationValues],
  );

  /** Drops looks whose items are gone, so the stored document does not keep stale keys. */
  const withoutDecorations = useCallback(
    (removals: readonly [DecorationKind, readonly string[]][]): DecorationsValues | null => {
      let changed = false;
      const next = { ...decorationValues };
      for (const [kind, keys] of removals) {
        const bucket = { ...next[kind] };
        for (const key of keys) {
          if (!(key in bucket)) continue;
          delete bucket[key];
          changed = true;
        }
        next[kind] = bucket;
      }
      return changed ? next : null;
    },
    [decorationValues],
  );

  const decorations = useMemo<Decorations>(
    () => ({
      values: decorationValues,
      get: (kind, key) => decorationValues[kind][key] ?? EMPTY_DECORATION,
      open: (target) => setDialog({ kind: "decorate", target }),
    }),
    [decorationValues],
  );

  const toggle = useCallback(
    (key: string) => {
      if (layoutState.status !== "ready") return;
      const next = collapsed.has(key)
        ? collapsedList.filter((item) => item !== key)
        : [...collapsedList, key];
      setPendingCollapsed(next);
      void layoutState.save({ collapsed: next }, layoutState.revision).then((saved) => {
        if (!saved) setPendingCollapsed(null);
      });
    },
    [collapsed, collapsedList, layoutState],
  );
  const toggleGroup = useCallback((id: string) => toggle(`g:${id}`), [toggle]);
  const toggleProject = useCallback((key: string) => toggle(`p:${key}`), [toggle]);
  const toggleUngrouped = useCallback(() => toggle(UNGROUPED_KEY), [toggle]);

  const onDrop = useCallback(
    (subject: DragSubject, target: DropTarget) => {
      const next =
        subject.kind === "project"
          ? moveProject(groups, subject.key, target)
          : target.kind === "group-at"
            ? moveGroup(groups, subject.id, target.index)
            : null;
      if (next) void saveGroups(next);
    },
    [groups, saveGroups],
  );

  const viewportRef = useRef<View>(null);
  const scrollRef = useRef<NativeScrollView>(null);
  const drag = useDragController(viewportRef, scrollRef, onDrop);

  const createGroup = useCallback(() => {
    const created = addGroup(
      groups,
      nextGroupName(groups, (number) => t("group.defaultName", { number })),
    );
    setRenamingId(created.id);
    void saveGroups(created.groups);
  }, [groups, saveGroups, t]);

  const rename = useCallback(
    (id: string, name: string) => {
      // Submit and blur both arrive; only the first one counts.
      if (renamingRef.current !== id) return;
      renamingRef.current = null;
      setRenamingId(null);
      const next = renameGroup(groups, id, name);
      if (next) void saveGroups(next);
    },
    [groups, saveGroups],
  );
  const cancelRename = useCallback(() => {
    renamingRef.current = null;
    setRenamingId(null);
  }, []);

  const requestDelete = useCallback(
    (id: string) => {
      const group = groups.find((item) => item.id === id);
      if (!group) return;
      if (group.projects.some((key) => byKey.has(key))) {
        setDialog({ kind: "delete-group", group });
        return;
      }
      void saveGroups(removeGroup(groups, id));
      const cleaned = withDecoration("groups", id, null);
      if (cleaned) void saveDecorations(cleaned);
    },
    [byKey, groups, saveDecorations, saveGroups, withDecoration],
  );

  const openProjectMenu = useCallback(
    (reference: ProjectRef) => setDialog({ kind: "project", reference }),
    [],
  );
  const openWorkspaceMenu = useCallback(
    (reference: WorkspaceRef) => setDialog({ kind: "workspace", reference }),
    [],
  );

  const chooseGroup = useCallback(
    (reference: ProjectRef, groupId: string | null) => {
      setDialog(null);
      const next = moveProject(
        groups,
        reference.key,
        groupId === null ? { kind: "ungroup" } : { kind: "into-group", groupId },
      );
      if (next) void saveGroups(next);
    },
    [groups, saveGroups],
  );

  const confirmRemoveProject = useCallback(
    async (reference: ProjectRef, workspaceKeys: readonly string[]) => {
      setRemoving(true);
      try {
        const result = await removeProjectCall({ projectId: reference.id });
        setDialog(null);
        toast.show(
          result.removedWorkspaceIds.length
            ? t("project.removedWithWorkspaces", { count: result.removedWorkspaceIds.length })
            : t("project.removed"),
        );
        // Drop the removed project from its group and its look so no stale key stays behind.
        const next = moveProject(groups, reference.key, { kind: "ungroup" });
        if (next) void saveGroups(next);
        const cleaned = withoutDecorations([
          ["projects", [reference.key]],
          ["workspaces", workspaceKeys],
        ]);
        if (cleaned) void saveDecorations(cleaned);
      } catch (error) {
        toast.error(t("project.removeFailed", { reason: errorText(error) }));
      } finally {
        setRemoving(false);
      }
    },
    [groups, removeProjectCall, saveDecorations, saveGroups, t, toast, withoutDecorations],
  );

  if (groupsState.status === "loading" || layoutState.status === "loading") {
    return <StatusMessage message={t("sidebar.loading")} view={view} />;
  }
  if (groupsState.status === "error") {
    return (
      <StatusMessage
        message={t("sidebar.loadFailed", { reason: groupsState.error })}
        view={view}
        actions={[{ label: t("common.reload"), icon: "RefreshCw", onPress: () => void groupsState.reload() }]}
      />
    );
  }
  if (groupsState.status === "invalid") {
    return (
      <StatusMessage
        message={t("sidebar.invalid", { reason: groupsState.error })}
        view={view}
        actions={[
          { label: t("common.reload"), icon: "RefreshCw", onPress: () => void groupsState.reload() },
          { label: t("sidebar.resetGroups"), icon: "RotateCcw", onPress: () => void groupsState.reset() },
        ]}
      />
    );
  }

  const draggingKey =
    drag.subject?.kind === "project"
      ? drag.subject.key
      : drag.subject?.kind === "group"
        ? drag.subject.id
        : null;

  const projectBlock = (reference: ProjectRef, groupId: string | null) => (
    <ProjectBlock
      key={reference.key}
      reference={reference}
      groupId={groupId}
      collapsed={collapsed.has(`p:${reference.key}`)}
      dragging={draggingKey === reference.key}
      view={view}
      onToggle={toggleProject}
      onMenu={openProjectMenu}
      onWorkspaceMenu={openWorkspaceMenu}
    />
  );

  return (
    <DecorationsContext.Provider value={decorations}>
      <DragProvider value={drag.controller}>
        <View style={{ flex: 1 }}>
          <ToolbarRow view={view} onCreateGroup={createGroup} />
          <View ref={viewportRef} {...drag.surfaceHandlers} style={{ flex: 1 }}>
            <ScrollView
              ref={scrollRef}
              scrollEnabled={!drag.scrollLocked}
              scrollEventThrottle={16}
              onScroll={(event) => drag.controller.onScroll(event.nativeEvent.contentOffset.y)}
              onContentSizeChange={(_width, height) => drag.controller.onContentHeight(height)}
              contentContainerStyle={{ paddingBottom: 24 }}
            >
              {pinned.length ? (
                <View>
                  <SectionHeading title={t("sidebar.pinned")} view={view} />
                  {pinned.map((reference) => (
                    <WorkspaceRow
                      key={reference.key}
                      reference={reference}
                      indent={12}
                      view={view}
                      onMenu={openWorkspaceMenu}
                    />
                  ))}
                </View>
              ) : null}

              {groups.length === 0 ? (
                <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
                  <Text style={styles.detail}>{t("sidebar.emptyHint")}</Text>
                </View>
              ) : null}

              {groups.map((group, index) => {
                const members = group.projects
                  .map((key) => byKey.get(key))
                  .filter((reference): reference is ProjectRef => reference !== undefined);
                const folded = collapsed.has(`g:${group.id}`);
                return (
                  <Fragment key={group.id}>
                    {index > 0 || pinned.length ? <View style={{ height: look.groupGap }} /> : null}
                    <GroupHeader
                      group={group}
                      count={members.length}
                      collapsed={folded}
                      renaming={renamingId === group.id}
                      dragging={draggingKey === group.id}
                      view={view}
                      onToggle={toggleGroup}
                      onStartRename={setRenamingId}
                      onRename={rename}
                      onCancelRename={cancelRename}
                      onDelete={requestDelete}
                    />
                    {folded ? null : members.length ? (
                      members.map((reference) => projectBlock(reference, group.id))
                    ) : (
                      <EmptyGroupRow groupId={group.id} view={view} />
                    )}
                  </Fragment>
                );
              })}

              {groups.length || pinned.length ? <View style={{ height: look.groupGap }} /> : null}
              <UngroupedHeader
                count={ungrouped.length}
                collapsed={collapsed.has(UNGROUPED_KEY)}
                view={view}
                onToggle={toggleUngrouped}
              />
              {collapsed.has(UNGROUPED_KEY)
                ? null
                : ungrouped.map((reference) => projectBlock(reference, null))}

              {drag.hit ? <DropIndicator hit={drag.hit} theme={view.theme} /> : null}
            </ScrollView>
            {drag.subject ? (
              <Ghost
                subject={drag.subject}
                reference={drag.subject.kind === "project" ? byKey.get(drag.subject.key) : undefined}
                y={drag.ghostY}
                theme={view.theme}
              />
            ) : null}
          </View>
        </View>

        {dialog?.kind === "project" ? (
          <ProjectMenuDialog
            reference={dialog.reference}
            groups={groups}
            theme={view.theme}
            onChooseGroup={(groupId) => chooseGroup(dialog.reference, groupId)}
            onNewWorkspace={() => {
              setDialog(null);
              view.navigation.openProject(dialog.reference);
            }}
            onDecorate={(name) =>
              setDialog({ kind: "decorate", target: { kind: "projects", key: dialog.reference.key, name } })
            }
            onRemove={() => setDialog({ kind: "remove-project", reference: dialog.reference })}
            onClose={closeDialog}
          />
        ) : null}
        {dialog?.kind === "remove-project" ? (
          <RemoveProjectDialog
            reference={dialog.reference}
            theme={view.theme}
            busy={removing}
            onConfirm={(workspaceKeys) => void confirmRemoveProject(dialog.reference, workspaceKeys)}
            onClose={closeDialog}
          />
        ) : null}
        {dialog?.kind === "workspace" ? (
          <WorkspaceMenuDialog
            reference={dialog.reference}
            theme={view.theme}
            onDecorate={(name) =>
              setDialog({ kind: "decorate", target: { kind: "workspaces", key: dialog.reference.key, name } })
            }
            onArchived={() => {
              const cleaned = withoutDecorations([["workspaces", [dialog.reference.key]]]);
              if (cleaned) void saveDecorations(cleaned);
            }}
            onClose={closeDialog}
          />
        ) : null}
        {dialog?.kind === "decorate" ? (
          <DecorateDialog
            target={dialog.target}
            initial={decorations.get(dialog.target.kind, dialog.target.key)}
            theme={view.theme}
            onSave={(decoration) => {
              const target = dialog.target;
              setDialog(null);
              const next = withDecoration(target.kind, target.key, decoration);
              if (next) void saveDecorations(next);
            }}
            onClose={closeDialog}
          />
        ) : null}
        {dialog?.kind === "delete-group" ? (
          <DeleteGroupDialog
            group={dialog.group}
            count={dialog.group.projects.filter((key) => byKey.has(key)).length}
            theme={view.theme}
            onConfirm={() => {
              const id = dialog.group.id;
              setDialog(null);
              void saveGroups(removeGroup(groups, id));
              const cleaned = withDecoration("groups", id, null);
              if (cleaned) void saveDecorations(cleaned);
            }}
            onClose={closeDialog}
          />
        ) : null}
      </DragProvider>
    </DecorationsContext.Provider>
  );
}
