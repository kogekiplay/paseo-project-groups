const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const React = require("react");
const { act, create } = require("react-test-renderer");
const ts = require("typescript");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.join(__dirname, "..");

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f3f5f8",
    surface2: "#e6eaf0",
    border: "#d0d7de",
    foreground: "#1c2128",
    foregroundMuted: "#57606a",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    statusSuccess: "#1a7f37",
    statusWarning: "#bf8700",
    statusDanger: "#cf222e",
  },
};

function resolveTs(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
}

/**
 * Loads real plugin TypeScript modules in an isolated VM graph, substituting only
 * React Native primitives and the Paseo SDK hooks/UI.
 */
function createLoader(overrides = {}, globals = {}) {
  const cache = new Map();
  const load = (relPath) => {
    const abs = path.resolve(ROOT, relPath);
    if (cache.has(abs)) return cache.get(abs);
    const source = readFileSync(abs, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const module = { exports: {} };
    cache.set(abs, module.exports);
    const context = {
      exports: module.exports,
      module,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      ...globals,
      require(name) {
        if (name in overrides) return overrides[name];
        if (name === "react") return React;
        if (name === "react/jsx-runtime") return require("react/jsx-runtime");
        if (name === "zod") return require("zod");
        if (name.startsWith(".")) return load(resolveTs(abs, name));
        throw new Error(`Unexpected import: ${name} (from ${relPath})`);
      },
    };
    vm.runInNewContext(outputText, context);
    cache.set(abs, module.exports);
    return module.exports;
  };
  return load;
}

const ref = (kind, hostId, id) => ({ kind, hostId, id, key: `${hostId}:${id}` });

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  return (node.children ?? []).map(textOf).join("");
}

function flattenStyle(style) {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style;
}

function makeHarness({
  platform = "web",
  compact = false,
  locale = "zh-CN",
  projects = [],
  workspaces = [],
  agents = [],
  groups = [],
  parents = {},
  collapsed = [],
  activeAgent = null,
  activeWorkspace = null,
} = {}) {
  const workspaceRefCalls = [];
  const openedAgents = [];
  const openedWorkspaces = [];
  const savedLayouts = [];
  const scrollCalls = [];

  let currentCollapsed = [...collapsed];
  let layoutRevision = 1;
  let listener = null;

  const projectMap = new Map(projects.map((p) => [p.ref.key, p]));
  const workspaceMap = new Map(workspaces.map((w) => [w.ref.key, w]));
  const agentMap = new Map(agents.map((a) => [a.ref.key, a]));

  function queryItems(list, query = {}) {
    let filtered = query.where ? list.filter(query.where) : [...list];
    if (query.orderBy) {
      if (typeof query.orderBy === "function") {
        filtered.sort(query.orderBy);
      } else if (Array.isArray(query.orderBy)) {
        const [field, dir] = query.orderBy;
        filtered.sort((a, b) => {
          const cmp = String(a[field] ?? "").localeCompare(String(b[field] ?? ""));
          return dir === "desc" ? -cmp : cmp;
        });
      } else {
        const field = query.orderBy;
        filtered.sort((a, b) => String(a[field] ?? "").localeCompare(String(b[field] ?? "")));
      }
    }
    if (!query.groupBy) return filtered.map((item) => item.ref);
    const grouped = new Map();
    for (const item of filtered) {
      const raw = query.groupBy(item);
      const keys = Array.isArray(raw) ? raw : [raw];
      for (const entry of keys) {
        const key = typeof entry === "string" ? entry : entry.key;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item.ref);
      }
    }
    return [...grouped.entries()].map(([key, items]) => ({ key, title: null, color: null, items }));
  }

  const AnimatedView = "AnimatedView";
  const rn = {
    Platform: { OS: platform },
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    TextInput: "TextInput",
    Image: "Image",
    ScrollView: "ScrollView",
    Easing: { linear: (v) => v },
    Animated: {
      View: AnimatedView,
      Value: class {
        constructor(v) { this.value = v; }
        interpolate() { return "0deg"; }
        setValue(v) { this.value = v; }
      },
      timing: () => ({ start() {}, stop() {} }),
      loop: () => ({ start() {}, stop() {} }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
  };

  const sdkClient = {
    defineTranslations: (config) => ({
      ...config,
      message: (key) => ({ key }),
    }),
    defineSettings: (config) => config,
    defineRpc: (config) => config,
    useTranslation: () => ({ locale }),
    useSettings: (doc) => {
      if (doc.id === "groups") {
        return {
          status: "ready",
          revision: "g1",
          values: { groups, parents },
          saving: false,
          saveError: null,
          save: async () => true,
          reset: async () => true,
          reload: async () => {},
        };
      }
      if (doc.id === "layout") {
        return {
          status: "ready",
          revision: `l${layoutRevision}`,
          values: { collapsed: currentCollapsed },
          saving: false,
          saveError: null,
          save: async (next) => {
            savedLayouts.push(next.collapsed);
            currentCollapsed = [...next.collapsed];
            layoutRevision += 1;
            listener?.();
            return true;
          },
          reset: async () => true,
          reload: async () => {},
        };
      }
      if (doc.id === "decorations") {
        return {
          status: "ready",
          revision: "d1",
          values: { groups: {}, projects: {}, workspaces: {} },
          saving: false,
          saveError: null,
          save: async () => true,
          reset: async () => true,
          reload: async () => {},
        };
      }
      return {
        status: "ready",
        revision: "a1",
        values: doc.schema.parse({}),
        saving: false,
        saveError: null,
        save: async () => true,
        reset: async () => true,
        reload: async () => {},
      };
    },
    useHosts: () => [
      { serverId: "host-a", label: "MacBook", status: "online" },
      { serverId: "host-b", label: "Linux Box", status: "online" },
    ],
    useProjects: (query) => queryItems(projects, query),
    useWorkspaces: (query) => queryItems(workspaces, query),
    useAgents: (query) => queryItems(agents, query),
    useProject: (projectRef, selector) => {
      const snap = projectMap.get(projectRef.key) ?? null;
      return snap && selector ? selector(snap) : snap;
    },
    useWorkspace: (wsRef, selector) => {
      workspaceRefCalls.push(wsRef);
      const key = typeof wsRef === "string" ? wsRef : wsRef.key;
      const snap = workspaceMap.get(key) ?? null;
      return snap && selector ? selector(snap) : snap;
    },
    useAgent: (agentRef, selector) => {
      const key = typeof agentRef === "string" ? agentRef : agentRef.key;
      const snap = agentMap.get(key) ?? null;
      return snap && selector ? selector(snap) : snap;
    },
    useRpc: () => async () => ({ serverId: "host-a", projectIds: [] }),
    usePaseo: () => ({}),
  };

  const sdkUi = {
    Icon: "Icon",
    ScrollView: "ScrollView",
    TextInput: "TextInput",
    Modal: Object.assign(({ children }) => React.createElement("Modal", null, children), {
      Content: ({ children }) => React.createElement("ModalContent", null, children),
    }),
    SettingsAction: "SettingsAction",
    SettingsCard: "SettingsCard",
    SettingsSection: "SettingsSection",
    SettingsSelect: "SettingsSelect",
    SettingsSwitch: "SettingsSwitch",
    useToast: () => ({ show() {}, error() {} }),
  };

  const load = createLoader({
    "react-native": rn,
    "@getpaseo/plugin": {
      defineSettings: (config) => config,
      defineRpc: (config) => config,
    },
    "@getpaseo/plugin/client": sdkClient,
    "@getpaseo/plugin/client/ui": sdkUi,
    "@tanstack/react-query": {
      useQuery: () => ({ data: undefined, isLoading: false, refetch: async () => {} }),
    },
  });

  const entry = load("index.client.tsx").default;
  let SidebarComponent = null;
  entry({
    openSettings() {},
    addSettingsScreen() { return () => {}; },
    addSidebarView(contribution) {
      SidebarComponent = contribution.Component;
      return () => {};
    },
  });
  assert.ok(SidebarComponent, "index.client.tsx should register the sidebar view");

  let viewProps = {
    theme,
    layout: { compact, platform },
    active: { workspace: activeWorkspace, agent: activeAgent },
    navigation: {
      openWorkspace: (r) => openedWorkspaces.push(r),
      openAgent: (r) => openedAgents.push(r),
      openTerminal: () => {},
      openProject: () => {},
    },
    dismiss: () => {},
  };

  let renderer;
  const createNodeMock = (element) => {
    if (element.type === "ScrollView") {
      return { scrollTo: (opts) => scrollCalls.push(opts) };
    }
    if (element.type === "View") {
      return {
        measureLayout: (_relative, onSuccess) => onSuccess(0, 40, 280, 28),
      };
    }
    return {};
  };

  const renderTree = () => React.createElement(SidebarComponent, viewProps);
  listener = () => {
    if (renderer) renderer.update(renderTree());
  };

  return {
    load,
    mount() {
      act(() => {
        renderer = create(renderTree(), { createNodeMock });
      });
      return renderer;
    },
    setActive(next) {
      viewProps = { ...viewProps, active: { ...viewProps.active, ...next } };
      act(() => renderer.update(renderTree()));
    },
    unmount() {
      act(() => renderer.unmount());
    },
    workspaceRefCalls,
    openedAgents,
    openedWorkspaces,
    savedLayouts,
    scrollCalls,
  };
}

function sampleCrossProjectData() {
  const pCli = ref("project", "host-a", "mom_cli");
  const pRep = ref("project", "host-a", "mom-reports");
  const pPerm = ref("project", "host-b", "mom-permission-workbench");
  const pGroups = ref("project", "host-a", "paseo-project-groups");

  const wCli = ref("workspace", "host-a", "ws-cli");
  const wRep = ref("workspace", "host-a", "ws-rep");
  const wPerm = ref("workspace", "host-b", "ws-perm");
  const wGroups = ref("workspace", "host-a", "ws-groups");

  const aCli = ref("agent", "host-a", "ag-cli");
  const aRep = ref("agent", "host-a", "ag-rep");
  const aPerm = ref("agent", "host-b", "ag-perm");
  const aGroups = ref("agent", "host-a", "ag-groups");

  const projects = [
    { ref: pCli, hostId: "host-a", displayName: "mom_cli", iconRevision: null },
    { ref: pRep, hostId: "host-a", displayName: "mom-reports", iconRevision: null },
    { ref: pPerm, hostId: "host-b", displayName: "mom-permission-workbench", iconRevision: null },
    { ref: pGroups, hostId: "host-a", displayName: "paseo-project-groups", iconRevision: null },
  ];

  const workspaces = [
    {
      ref: wCli, hostId: "host-a", project: pCli, pinnedAt: null, labels: [], background: false,
      branch: "main", createdAt: "2026-01-01T00:00:00Z", lastPromptAt: null, parentAgent: null,
      indicator: "done", indicatorLabel: null, id: "ws-cli", projectId: "mom_cli",
      projectDisplayName: "mom_cli", name: "MOM CLI", title: "MOM CLI", status: "done",
      statusEnteredAt: null, archivingAt: null, diffStat: null,
    },
    {
      ref: wRep, hostId: "host-a", project: pRep, pinnedAt: null, labels: [], background: false,
      branch: "feat/reports", createdAt: "2026-01-02T00:00:00Z", lastPromptAt: null, parentAgent: aCli,
      indicator: "done", indicatorLabel: null, id: "ws-rep", projectId: "mom-reports",
      projectDisplayName: "mom-reports", name: "MOM报表", title: "MOM报表", status: "done",
      statusEnteredAt: null, archivingAt: null, diffStat: { additions: 33537, deletions: 3767 },
    },
    {
      ref: wPerm, hostId: "host-b", project: pPerm, pinnedAt: null, labels: [], background: false,
      branch: "feat/perm", createdAt: "2026-01-03T00:00:00Z", lastPromptAt: null, parentAgent: aCli,
      indicator: "running", indicatorLabel: "运行中", id: "ws-perm", projectId: "mom-permission-workbench",
      projectDisplayName: "mom-permission-workbench", name: "MOM 权限工作台", title: "MOM 权限工作台",
      status: "running", statusEnteredAt: null, archivingAt: null, diffStat: null,
    },
    {
      ref: wGroups, hostId: "host-a", project: pGroups, pinnedAt: null, labels: [], background: false,
      branch: "main", createdAt: "2026-01-04T00:00:00Z", lastPromptAt: null, parentAgent: null,
      indicator: "done", indicatorLabel: null, id: "ws-groups", projectId: "paseo-project-groups",
      projectDisplayName: "paseo-project-groups", name: "项目分组插件", title: "项目分组插件",
      status: "done", statusEnteredAt: null, archivingAt: null, diffStat: { additions: 961, deletions: 63 },
    },
  ];

  const agents = [
    {
      ref: aCli, hostId: "host-a", workspace: wCli, parentAgent: null, id: "ag-cli", workspaceId: "ws-cli",
      status: "idle", background: false, createdAt: "2026-01-01T00:00:00Z", title: "MOM CLI",
      requiresAttention: false,
    },
    {
      ref: aRep, hostId: "host-a", workspace: wRep, parentAgent: aCli, id: "ag-rep", workspaceId: "ws-rep",
      status: "idle", background: false, createdAt: "2026-01-02T00:00:00Z", title: "MOM报表",
      requiresAttention: false,
    },
    {
      ref: aPerm, hostId: "host-b", workspace: wPerm, parentAgent: aCli, id: "ag-perm", workspaceId: "ws-perm",
      status: "running", background: false, createdAt: "2026-01-03T00:00:00Z", title: "MOM 权限工作台",
      requiresAttention: false,
    },
    {
      ref: aGroups, hostId: "host-a", workspace: wGroups, parentAgent: null, id: "ag-groups", workspaceId: "ws-groups",
      status: "idle", background: false, createdAt: "2026-01-04T00:00:00Z", title: "项目分组插件",
      requiresAttention: false,
    },
  ];

  const groups = [
    { id: "mom", name: "MOM", projects: [pCli.key, pRep.key, pPerm.key] },
    { id: "paseo", name: "paseo插件", projects: [pGroups.key] },
  ];

  return {
    refs: { pCli, pRep, pPerm, pGroups, wCli, wRep, wPerm, wGroups, aCli, aRep, aPerm, aGroups },
    projects, workspaces, agents, groups,
  };
}

test("relationship-model orders connected families before standalone agents and tracks multi-level guides", () => {
  const load = createLoader();
  const model = load("client/relationship-model.ts");
  const solo = ref("agent", "h1", "solo");
  const root = ref("agent", "h1", "root");
  const c1 = ref("agent", "h1", "c1");
  const c2 = ref("agent", "h1", "c2");
  const g1 = ref("agent", "h2", "g1");

  const rel = model.agentRelationships([
    { key: "w:h1:w-solo", items: [solo] },
    { key: "w:h1:w-root", items: [root] },
    { key: "w:h1:w-c1", items: [c1] },
    { key: "w:h1:w-c2", items: [c2] },
    { key: "w:h2:w-g1", items: [g1] },
    { key: `a:${root.key}`, items: [c1, c2] },
    { key: `a:${c1.key}`, items: [g1] },
  ]);

  const plain = (value) => JSON.parse(JSON.stringify(value));
  const rows = plain(model.relationshipRows(rel));
  assert.deepEqual(rows.map((r) => r.agent.id), ["root", "c1", "g1", "c2", "solo"]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2, 1, 0]);
  assert.deepEqual(rows.map((r) => r.last), [true, false, true, true, true]);
  assert.deepEqual(rows[2].guides, [true], "grandchild under non-last child keeps ancestor vertical guide");
  assert.equal(model.activeFamily(rel, c1.key).parent.key, root.key);
  assert.equal(model.activeFamily(rel, solo.key), null);
});

test("cross-project parent-child, drawer full project names, and real cross-host WorkspaceRef subscriptions", (t) => {
  const data = sampleCrossProjectData();
  const harness = makeHarness({
    projects: data.projects,
    workspaces: data.workspaces,
    agents: data.agents,
    groups: data.groups,
    activeAgent: data.refs.aRep,
    activeWorkspace: data.refs.wRep,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  // Every useWorkspace call must receive a real WorkspaceRef object (never a composite key string).
  assert.ok(harness.workspaceRefCalls.length > 0);
  for (const call of harness.workspaceRefCalls) {
    assert.equal(typeof call, "object", `useWorkspace received string instead of WorkspaceRef: ${String(call)}`);
    assert.equal(call.kind, "workspace");
    assert.ok(call.hostId && call.id && call.key);
  }
  assert.ok(
    harness.workspaceRefCalls.some((r) => r.hostId === "host-b" && r.id === "ws-perm"),
    "cross-host child workspace subscribed via host-b WorkspaceRef",
  );

  // Selected child row renders quick-jump buttons for parent and cross-host sibling,
  // while unselected child row shows a quiet trailing parent cue ("MOM CLI").
  const parentButtons = renderer.root.findAllByProps({ accessibilityLabel: "父 MOM CLI", accessibilityRole: "button" });
  assert.equal(parentButtons.length, 2, "quick-jump on selected child + quiet parent cue on unselected sibling");
  const parentJump = parentButtons.find((btn) => textOf(btn) === "父 MOM CLI");
  const quietParentCue = parentButtons.find((btn) => textOf(btn) === "MOM CLI");
  assert.ok(parentJump, "selected row shows full parent jump label");
  assert.ok(quietParentCue, "unselected sibling shows compact parent cue");
  const siblingJump = renderer.root.findByProps({ accessibilityLabel: "同父 MOM 权限工作台", accessibilityRole: "button" });
  assert.equal(flattenStyle(parentJump.props.style).borderColor, theme.colors.accent);
  assert.equal(flattenStyle(quietParentCue.props.style).borderColor, theme.colors.border);
  assert.equal(flattenStyle(siblingJump.props.style).borderColor, theme.colors.border);

  // Clicking parent subcount pill opens drawer with full readable project names (not truncated to 45%).
  const subcountBtn = renderer.root.findByProps({ accessibilityLabel: "2 个子 Agent", accessibilityRole: "button" });
  assert.equal(subcountBtn.props.accessibilityState.expanded, false);
  act(() => subcountBtn.props.onPress({ stopPropagation() {} }));

  const expandedBtn = renderer.root.findByProps({ accessibilityLabel: "2 个子 Agent", accessibilityRole: "button" });
  assert.equal(expandedBtn.props.accessibilityState.expanded, true);
  assert.equal(flattenStyle(expandedBtn.props.style).backgroundColor, theme.colors.accent);

  const drawerItem = renderer.root.findByProps({
    accessibilityLabel: "MOM 权限工作台 (mom-permission-workbench)",
    accessibilityRole: "button",
  });
  assert.ok(textOf(drawerItem).includes("mom-permission-workbench"));
  act(() => drawerItem.props.onPress({ stopPropagation() {} }));
  assert.deepEqual(harness.openedAgents, [data.refs.aPerm]);
});

test("jumping to a parent or sibling inside a collapsed group and project unfolds them automatically", async (t) => {
  const data = sampleCrossProjectData();
  const harness = makeHarness({
    projects: data.projects,
    workspaces: data.workspaces,
    agents: data.agents,
    groups: [
      { id: "parent-grp", name: "Parent Group", projects: [data.refs.pCli.key] },
      { id: "child-grp", name: "Child Group", projects: [data.refs.pRep.key, data.refs.pPerm.key] },
    ],
    // Parent group, parent project, and sibling's project are all collapsed!
    collapsed: ["g:parent-grp", `p:${data.refs.pCli.key}`, `p:${data.refs.pPerm.key}`],
    activeAgent: data.refs.aRep,
    activeWorkspace: data.refs.wRep,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  const parentJump = renderer.root.findByProps({ accessibilityLabel: "父 MOM CLI", accessibilityRole: "button" });
  await act(async () => {
    parentJump.props.onPress({ stopPropagation() {} });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });

  assert.deepEqual(harness.openedAgents, [data.refs.aCli]);
  assert.equal(harness.savedLayouts.length, 1);
  assert.deepEqual(harness.savedLayouts[0], [`p:${data.refs.pPerm.key}`], "both parent group and parent project unfolded");
  assert.ok(
    renderer.root.findByProps({ accessibilityLabel: "打开MOM CLI", accessibilityRole: "button" }),
    "unfolded parent workspace row is now mounted",
  );
  assert.ok(harness.scrollCalls.length >= 1, "jumping reveals the target row in the scroll view");
});

test("same-workspace subagent tabs are hidden from both views, counts, quick-jump, rail, and keyboard nav", (t) => {
  const pGroups = ref("project", "host-a", "paseo-project-groups");
  const pCross = ref("project", "host-b", "cross-project");
  const wMain = ref("workspace", "host-a", "ws-1");
  // Same opaque workspace ID ("ws-1") on a different host must stay distinct!
  const wOtherHost = ref("workspace", "host-b", "ws-1");

  const aRoot = ref("agent", "host-a", "ag-root");
  const aTabChild = ref("agent", "host-a", "ag-tab-child");
  const aTabGrandchild = ref("agent", "host-a", "ag-tab-grandchild");
  const aCrossHostChild = ref("agent", "host-b", "ag-cross-host-child");

  const harness = makeHarness({
    projects: [
      { ref: pGroups, hostId: "host-a", displayName: "paseo-project-groups", iconRevision: null },
      { ref: pCross, hostId: "host-b", displayName: "cross-project", iconRevision: null },
    ],
    workspaces: [
      {
        ref: wMain, hostId: "host-a", project: pGroups, pinnedAt: null, labels: [], background: false,
        branch: "main", createdAt: "2026-01-01T00:00:00Z", lastPromptAt: null, parentAgent: null,
        indicator: "done", indicatorLabel: null, id: "ws-1", projectId: "paseo-project-groups",
        projectDisplayName: "paseo-project-groups", name: "项目分组插件", title: "项目分组插件",
        status: "done", statusEnteredAt: null, archivingAt: null, diffStat: { additions: 961, deletions: 63 },
      },
      {
        ref: wOtherHost, hostId: "host-b", project: pCross, pinnedAt: null, labels: [], background: false,
        branch: "main", createdAt: "2026-01-02T00:00:00Z", lastPromptAt: null, parentAgent: aRoot,
        indicator: "running", indicatorLabel: "运行中", id: "ws-1", projectId: "cross-project",
        projectDisplayName: "cross-project", name: "远端跨工作区子 Agent", title: "远端跨工作区子 Agent",
        status: "running", statusEnteredAt: null, archivingAt: null, diffStat: null,
      },
    ],
    agents: [
      { ref: aRoot, hostId: "host-a", workspace: wMain, parentAgent: null, id: "ag-root", workspaceId: "ws-1", status: "idle", background: false, createdAt: "2026-01-01T00:00:00Z", title: "项目分组插件", requiresAttention: false },
      { ref: aTabChild, hostId: "host-a", workspace: wMain, parentAgent: aRoot, id: "ag-tab-child", workspaceId: "ws-1", status: "running", background: false, createdAt: "2026-01-02T00:00:00Z", title: "同窗口子标签", requiresAttention: false },
      { ref: aTabGrandchild, hostId: "host-a", workspace: wMain, parentAgent: aTabChild, id: "ag-tab-grandchild", workspaceId: "ws-1", status: "idle", background: false, createdAt: "2026-01-03T00:00:00Z", title: "同窗口孙标签", requiresAttention: false },
      { ref: aCrossHostChild, hostId: "host-b", workspace: wOtherHost, parentAgent: aRoot, id: "ag-cross-host-child", workspaceId: "ws-1", status: "running", background: false, createdAt: "2026-01-04T00:00:00Z", title: "远端跨工作区子 Agent", requiresAttention: false },
    ],
    groups: [{ id: "g1", name: "paseo插件", projects: [pGroups.key, pCross.key] }],
    activeAgent: aRoot,
    activeWorkspace: wMain,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  // Project view: no duplicate parent row, same-workspace subagent tabs never appear,
  // and child count only counts the cross-host/cross-workspace child (1, not 3!).
  const projectText = textOf(renderer.toJSON());
  assert.ok(!projectText.includes("同窗口子标签"), "same-workspace subagent tab must not appear in project view");
  assert.ok(!projectText.includes("同窗口孙标签"), "same-workspace grandchild tab must not appear in project view");
  assert.equal(
    renderer.root.findAllByProps({ accessibilityLabel: "打开项目分组插件", accessibilityRole: "button" }).length,
    1,
    "workspace row must not duplicate its parent agent underneath",
  );
  const subcount = renderer.root.findByProps({ accessibilityLabel: "1 个子 Agent", accessibilityRole: "button" });
  assert.equal(textOf(subcount), "1 子");
  assert.ok(
    renderer.root.findByProps({ accessibilityLabel: "子 远端跨工作区子 Agent", accessibilityRole: "button" }),
    "same workspace ID on another host stays a cross-workspace child",
  );

  // Opening drawer also excludes same-workspace tabs.
  act(() => subcount.props.onPress({ stopPropagation() {} }));
  assert.ok(!textOf(renderer.toJSON()).includes("同窗口子标签"));

  // Switch to "按关系" view: same-workspace subagent tabs remain absent; cross-host child stays linked.
  const relToggle = renderer.root.findByProps({ accessibilityLabel: "按关系", accessibilityRole: "button" });
  act(() => relToggle.props.onPress());
  const relText = textOf(renderer.toJSON());
  assert.ok(!relText.includes("同窗口子标签"), "same-workspace subagent tab must not appear in relation view");
  assert.ok(!relText.includes("同窗口孙标签"));
  assert.ok(relText.includes("项目分组插件"));
  assert.ok(relText.includes("远端跨工作区子 Agent"));
});

test("same workspace with multiple true root agents keeps a single workspace row and missing parents fabricate no link", (t) => {
  const p1 = ref("project", "host-a", "monorepo");
  const w1 = ref("workspace", "host-a", "ws-multi-root");
  const wOrphan = ref("workspace", "host-a", "ws-orphan");

  const aRoot1 = ref("agent", "host-a", "ag-root-1");
  const aRoot2 = ref("agent", "host-a", "ag-root-2");
  const aTabOfRoot1 = ref("agent", "host-a", "ag-tab-1");
  const aMissingParent = ref("agent", "host-a", "ag-archived-parent");
  const aOrphan = ref("agent", "host-a", "ag-orphan");

  const harness = makeHarness({
    projects: [{ ref: p1, hostId: "host-a", displayName: "monorepo", iconRevision: null }],
    workspaces: [
      {
        ref: w1, hostId: "host-a", project: p1, pinnedAt: null, labels: [], background: false,
        branch: "main", createdAt: "2026-01-01T00:00:00Z", lastPromptAt: null, parentAgent: null,
        indicator: "done", indicatorLabel: null, id: "ws-multi-root", projectId: "monorepo",
        projectDisplayName: "monorepo", name: "Multi Root WS", title: "Multi Root WS",
        status: "done", statusEnteredAt: null, archivingAt: null, diffStat: null,
      },
      {
        ref: wOrphan, hostId: "host-a", project: p1, pinnedAt: null, labels: [], background: false,
        branch: "fix/orphan", createdAt: "2026-01-02T00:00:00Z", lastPromptAt: null, parentAgent: aMissingParent,
        indicator: "done", indicatorLabel: null, id: "ws-orphan", projectId: "monorepo",
        projectDisplayName: "monorepo", name: "Orphan WS", title: "Orphan WS",
        status: "done", statusEnteredAt: null, archivingAt: null, diffStat: null,
      },
    ],
    agents: [
      { ref: aRoot1, hostId: "host-a", workspace: w1, parentAgent: null, id: "ag-root-1", workspaceId: "ws-multi-root", status: "idle", background: false, createdAt: "2026-01-01T00:00:00Z", title: "Root One", requiresAttention: false },
      { ref: aRoot2, hostId: "host-a", workspace: w1, parentAgent: null, id: "ag-root-2", workspaceId: "ws-multi-root", status: "idle", background: false, createdAt: "2026-01-02T00:00:00Z", title: "Root Two", requiresAttention: false },
      { ref: aTabOfRoot1, hostId: "host-a", workspace: w1, parentAgent: aRoot1, id: "ag-tab-1", workspaceId: "ws-multi-root", status: "running", background: false, createdAt: "2026-01-03T00:00:00Z", title: "Inner Tab", requiresAttention: false },
      { ref: aOrphan, hostId: "host-a", workspace: wOrphan, parentAgent: aMissingParent, id: "ag-orphan", workspaceId: "ws-orphan", status: "idle", background: false, createdAt: "2026-01-04T00:00:00Z", title: "Orphan Agent", requiresAttention: false },
    ],
    groups: [{ id: "g1", name: "Work", projects: [p1.key] }],
    activeAgent: aOrphan,
    activeWorkspace: wOrphan,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  // Multi-root workspace renders exactly one WorkspaceRow with default workspace navigation.
  const multiWsBtn = renderer.root.findByProps({ accessibilityLabel: "打开Multi Root WS", accessibilityRole: "button" });
  assert.equal(renderer.root.findAllByProps({ accessibilityLabel: "打开Root One", accessibilityRole: "button" }).length, 0);
  assert.equal(renderer.root.findAllByProps({ accessibilityLabel: "打开Root Two", accessibilityRole: "button" }).length, 0);
  assert.ok(!textOf(renderer.toJSON()).includes("Inner Tab"));
  act(() => multiWsBtn.props.onPress());
  assert.deepEqual(harness.openedWorkspaces, [w1]);

  // Agent whose parent is absent from visible agents keeps its normal WorkspaceRow and default navigation (no fabricated parent).
  const orphanWsBtn = renderer.root.findByProps({ accessibilityLabel: "打开Orphan WS", accessibilityRole: "button" });
  assert.equal(
    renderer.root.findAll((n) => n.props?.accessibilityRole === "button" && String(n.props.accessibilityLabel ?? "").startsWith("父 ")).length,
    0,
    "missing parent must not render a fabricated parent jump button",
  );
  act(() => orphanWsBtn.props.onPress());
  assert.deepEqual(harness.openedWorkspaces, [w1, wOrphan]);
  assert.deepEqual(harness.openedAgents, []);
});

test("By relation view displays tree hierarchy with full readable project names and single-agent active fallback", (t) => {
  const data = sampleCrossProjectData();
  const harness = makeHarness({
    projects: data.projects,
    workspaces: data.workspaces,
    agents: data.agents,
    groups: data.groups,
    // Simulate host providing active.workspace without active.agent on a single-agent workspace.
    activeAgent: null,
    activeWorkspace: data.refs.wRep,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  // Single-agent workspace fallback still renders the quick-jump strip!
  const parentButtons = renderer.root.findAllByProps({ accessibilityLabel: "父 MOM CLI", accessibilityRole: "button" });
  assert.ok(parentButtons.some((btn) => textOf(btn) === "父 MOM CLI"));

  // Switch to "按关系" view.
  const relToggle = renderer.root.findByProps({ accessibilityLabel: "按关系", accessibilityRole: "button" });
  act(() => relToggle.props.onPress());

  const treeText = textOf(renderer.toJSON());
  assert.ok(treeText.includes("MOM CLI"));
  assert.ok(treeText.includes("MOM报表"));
  assert.ok(treeText.includes("MOM 权限工作台"));
  assert.ok(treeText.includes("mom-permission-workbench"), "full project name visible in relation tree");
  assert.ok(treeText.includes("+33537"), "diff stats visible in relation tree");
});

test("useRelationshipRail supports measureLayout, measureInWindow fallback, measurement stability, and web focus", async (t) => {
  const load = createLoader({
    "react-native": { Platform: { OS: "web" }, View: "View" },
  });
  const { useRelationshipRail, RelationshipRail } = load("client/relationship-rail.tsx");

  const parent = ref("agent", "h1", "p");
  const childAbove = ref("agent", "h1", "c-above");
  const childBelow = ref("agent", "h1", "c-below");
  const family = { parent, children: [childAbove, childBelow] };

  let renders = 0;
  let hookApi;
  let useFallback = false;
  let focused = 0;
  const scrolled = [];

  const contentRef = {
    current: {
      measureInWindow: (cb) => cb(0, 100, 280, 400),
    },
  };
  const scrollRef = {
    current: {
      scrollTo: (opts) => scrolled.push(opts),
    },
  };

  function Harness({ activeFamily }) {
    renders += 1;
    hookApi = useRelationshipRail(activeFamily, contentRef, scrollRef);
    return React.createElement(RelationshipRail, { points: hookApi.points, theme });
  }

  let renderer;
  await act(async () => {
    renderer = create(React.createElement(Harness, { activeFamily: family }));
  });
  t.after(() => act(() => renderer.unmount()));

  const makeNode = (relY, height = 28) => ({
    measureLayout: (_container, onOk, onFail) => {
      if (useFallback) return onFail();
      onOk(0, relY, 260, height);
    },
    measureInWindow: (cb) => cb(0, 100 + relY, 260, height),
    querySelector: () => ({ focus: () => { focused += 1; } }),
  });

  await act(async () => {
    hookApi.register(parent.key, makeNode(80));
    hookApi.register(childAbove.key, makeNode(20));
    hookApi.register(childBelow.key, makeNode(160));
    await new Promise((r) => setTimeout(r, 15));
  });

  assert.equal(hookApi.points.parent, 94);
  assert.deepEqual(
    hookApi.points.children.map((c) => [c.key, c.y]),
    [[childAbove.key, 34], [childBelow.key, 174]],
  );

  // Stability check: repeated refreshes with identical layout produce ZERO extra renders.
  const settledRenders = renders;
  await act(async () => {
    hookApi.refresh();
    await new Promise((r) => setTimeout(r, 15));
    hookApi.refresh();
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.equal(renders, settledRenders, "identical measurements must not trigger re-renders");

  // Fallback check: when measureLayout fails, measureInWindow delta produces the exact same points.
  useFallback = true;
  await act(async () => {
    hookApi.register(childBelow.key, makeNode(180));
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.equal(hookApi.points.children[1].y, 194);

  // revealAgent scrolls and focuses on web.
  await act(async () => {
    hookApi.revealAgent(childBelow.key, { focus: true });
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.equal(scrolled.at(-1).y, 168);
  assert.equal(scrolled.at(-1).animated, false);
  assert.equal(focused, 1);

  // Zero-height (hidden/collapsed) nodes are excluded rather than drawing dangling elbows.
  await act(async () => {
    hookApi.register(childAbove.key, makeNode(20, 0));
    hookApi.register(childBelow.key, makeNode(180, 0));
    await new Promise((r) => setTimeout(r, 15));
  });
  assert.equal(hookApi.points.children.length, 0);
  assert.equal(renderer.toJSON(), null);
});

test("bindSidebarKeys handles Arrow nav, AgentRow fold lookup, P/[/], and ignores IME & text inputs", () => {
  const load = createLoader({ "react-native": { Platform: { OS: "web" } } });
  const { bindSidebarKeys } = load("client/web.ts");

  let handler = null;
  let focusedItem = null;
  let foldClicks = 0;
  const jumps = [];

  const foldBtn = {
    getAttribute: (attr) => (attr === "aria-expanded" ? "false" : null),
    click: () => { foldClicks += 1; },
  };
  const row1 = {
    getAttribute: (attr) => (attr === "data-pg-agent" ? "h1:a1" : null),
    getClientRects: () => [{}],
    focus: () => { focusedItem = "row1"; },
    querySelector: () => null,
    closest: (sel) => (sel === "[data-pg-nav]" ? row1 : sel === "[data-pg-row]" ? { querySelector: () => foldBtn } : null),
  };
  const row2 = {
    getAttribute: (attr) => (attr === "data-pg-agent" ? "h1:a2" : null),
    getClientRects: () => [{}],
    focus: () => { focusedItem = "row2"; },
    querySelector: () => null,
    closest: (sel) => (sel === "[data-pg-nav]" ? row2 : null),
  };
  const root = {
    addEventListener: (_type, fn) => { handler = fn; },
    removeEventListener: () => { handler = null; },
    querySelectorAll: () => [row1, row2],
  };

  const cleanup = bindSidebarKeys(root, (agent, direction) => {
    jumps.push([agent, direction]);
    return true;
  });

  const fire = (overrides) => {
    let prevented = false;
    handler({
      target: row1,
      key: "",
      isComposing: false,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
      ...overrides,
    });
    return prevented;
  };

  assert.equal(fire({ key: "ArrowDown" }), true);
  assert.equal(focusedItem, "row2");

  // ArrowRight finds sibling [data-pg-fold] inside [data-pg-row] (AgentRow layout).
  assert.equal(fire({ key: "ArrowRight" }), true);
  assert.equal(foldClicks, 1);

  // P / [ / ] jump actions
  assert.equal(fire({ key: "p" }), true);
  assert.equal(fire({ key: "]" }), true);
  assert.equal(fire({ key: "[" }), true);
  assert.deepEqual(jumps, [["h1:a1", "parent"], ["h1:a1", "next"], ["h1:a1", "previous"]]);

  // IME composition events and input fields are never intercepted.
  assert.equal(fire({ key: "p", isComposing: true }), false);
  assert.equal(fire({ key: "Process" }), false);
  assert.equal(fire({ key: "p", keyCode: 229 }), false);
  const inputTarget = { closest: (sel) => (sel.includes("input") ? {} : row1) };
  assert.equal(fire({ key: "ArrowDown", target: inputTarget }), false);
  assert.equal(jumps.length, 3);

  cleanup();
  assert.equal(handler, null);
});

test("compact mobile layout (375px) enforces touch targets, wrap/shrink safety, and iOS pill spinner alignment", (t) => {
  const data = sampleCrossProjectData();
  const harness = makeHarness({
    platform: "ios",
    compact: true,
    projects: data.projects,
    workspaces: data.workspaces,
    agents: data.agents,
    groups: data.groups,
    activeAgent: data.refs.aRep,
    activeWorkspace: data.refs.wRep,
  });
  const renderer = harness.mount();
  t.after(() => harness.unmount());

  // Quick-jump buttons have touch-friendly minHeight >= 34 and flexShrink + maxWidth: 100%.
  const siblingJump = renderer.root.findByProps({ accessibilityLabel: "同父 MOM 权限工作台", accessibilityRole: "button" });
  const jumpStyle = flattenStyle(siblingJump.props.style);
  assert.ok(jumpStyle.minHeight >= 34, `expected compact minHeight >= 34, got ${jumpStyle.minHeight}`);
  assert.equal(jumpStyle.flexShrink, 1);
  assert.equal(jumpStyle.maxWidth, "100%");
  assert.equal(jumpStyle.minWidth, 0);

  // Compact jump pill uses RunningSpinner directly (no iOS translateY: -3 wrapper from StatusDot).
  const shiftedWrappers = siblingJump.findAll(
    (node) => node.type === "View" && flattenStyle(node.props.style).transform?.some?.((item) => item.translateY === -3),
  );
  assert.equal(shiftedWrappers.length, 0, "compact pill spinner must not inherit StatusDot's iOS translateY(-3)");

  // Child count pill has compact touch height >= 28.
  const subcountBtn = renderer.root.findByProps({ accessibilityLabel: "2 个子 Agent", accessibilityRole: "button" });
  assert.ok(flattenStyle(subcountBtn.props.style).minHeight >= 28);
});
