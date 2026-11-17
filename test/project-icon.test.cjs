const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const React = require("react");
const { act, create } = require("react-test-renderer");
const { QueryClient, QueryClientProvider } = require("@tanstack/react-query");
const ts = require("typescript");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, modules) {
  const { outputText } = ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, Buffer, setTimeout, clearTimeout,
    require: (name) => name in modules ? modules[name] : require(name),
  });
  return exports;
}

const { createProjectIconReader, renderableIcon } = load("server/project-icon.ts", {});
const raster = { mimeType: "image/png", data: "aWNvbg==" };
const uri = "data:image/png;base64,aWNvbg==";

test("the icon reader shares its host connection and closes it on teardown", async () => {
  let connections = 0;
  let closed = 0;
  const ids = [];
  const reader = createProjectIconReader(async () => {
    connections++;
    return {
      getLastServerInfoMessage: () => ({ serverId: "host-a" }),
      getProjectIcon: async (id) => { ids.push(id); return { icon: raster }; },
      close: async () => closed++,
    };
  });
  const [first, second] = await Promise.all([
    reader.read({ hostId: "host-a", projectId: "one" }),
    reader.read({ hostId: "host-a", projectId: "two" }),
  ]);
  assert.equal(first.icon.uri, uri);
  assert.equal(second.icon.uri, uri);
  assert.equal(connections, 1);
  assert.deepEqual(ids, ["one", "two"]);
  await reader.close();
  assert.equal(closed, 1);
  assert.equal((await reader.read({ hostId: "host-a", projectId: "one" })).icon, null);
});

test("another host's project ID is never queried on the local daemon", async () => {
  let reads = 0;
  const reader = createProjectIconReader(async () => ({
    getLastServerInfoMessage: () => ({ serverId: "host-a" }),
    getProjectIcon: async () => { reads++; return { icon: raster }; },
    close: async () => {},
  }));
  assert.equal((await reader.read({ hostId: "host-b", projectId: "one" })).icon, null);
  assert.equal(reads, 0);
  await reader.close();
});

test("a failed connection is released and a later request can reconnect", async () => {
  let connections = 0;
  let closed = 0;
  const reader = createProjectIconReader(async () => {
    const failed = ++connections === 1;
    return {
      getLastServerInfoMessage: () => ({ serverId: "host" }),
      getProjectIcon: async () => ({ icon: failed ? null : raster, error: failed ? "unavailable" : null }),
      close: async () => closed++,
    };
  });
  await assert.rejects(reader.read({ hostId: "host", projectId: "one" }), /unavailable/);
  assert.equal(closed, 1);
  assert.equal((await reader.read({ hostId: "host", projectId: "one" })).icon.uri, uri);
  assert.equal(connections, 2);
  await reader.close();
});

test("missing images and unsupported or unsafe SVGs keep the folder fallback", () => {
  assert.equal(renderableIcon(null), null);
  assert.equal(renderableIcon({ ...raster, mimeType: "image/x-icon" }), null);
  for (const svg of [
    '<svg><script>alert(1)</script></svg>',
    '<svg><image href="https://example.com/icon.png" /></svg>',
    '<svg><style>.x{fill:red}</style></svg>',
  ]) {
    assert.equal(renderableIcon({ mimeType: "image/svg+xml", data: Buffer.from(svg).toString("base64") }), null);
  }
  const svg = '<svg viewBox="0 0 24 24"><path fill="red" d="M0 0h24v24H0z"/></svg>';
  const icon = renderableIcon({ mimeType: "image/svg+xml", data: Buffer.from(`<?xml version="1.0"?>${svg}`).toString("base64") });
  assert.equal(icon.kind, "svg");
  assert.equal(icon.svg, svg);
});

async function mountIcon(t, options = {}) {
  let revision = "revision-one";
  let calls = 0;
  let result = options.result ?? { icon: { kind: "image", uri } };
  const read = async () => {
    calls++;
    if (options.error) throw new Error("Host unavailable");
    return result;
  };
  const { ProjectIcon } = load("client/project-icon.tsx", {
    "@getpaseo/plugin/client": { useProject: (_ref, selector) => selector({ iconRevision: revision }), useRpc: () => read },
    "@getpaseo/plugin/client/ui": { Icon: "Icon" },
    "react-native": { Image: "Image" },
    "./decor": { DecorIcon: "DecorIcon" },
    "../shared/rpc": { projectIconRpc: {} },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let props = { reference: { hostId: "host", id: "one" }, icon: null, color: "#777777", size: 13, ...options.props };
  let renderer;
  const render = () => React.createElement(QueryClientProvider, { client }, React.createElement(ProjectIcon, props));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(() => { renderer = create(render()); });
  await settle();
  t.after(async () => { await act(() => renderer.unmount()); client.clear(); });
  return {
    renderer, client, calls: () => calls,
    async update(patch, nextRevision = revision, nextResult = result) {
      props = { ...props, ...patch }; revision = nextRevision; result = nextResult;
      await act(() => renderer.update(render()));
      await settle();
    },
  };
}

test("Paseo images retain their colors and fall back if image decoding fails", async (t) => {
  const { renderer } = await mountIcon(t);
  const image = renderer.root.findByType("Image");
  assert.equal(image.props.source.uri, uri);
  assert.equal(image.props.resizeMode, "contain");
  assert.equal(image.props.style.tintColor, undefined);
  await act(() => image.props.onError());
  assert.equal(renderer.root.findByType("DecorIcon").props.fallback, "Folder");
});

test("plugin overrides skip image requests and resetting restores Paseo's icon", async (t) => {
  const icon = await mountIcon(t, { props: { icon: "emoji:🚀" } });
  assert.equal(icon.calls(), 0);
  assert.equal(icon.renderer.root.findByType("DecorIcon").props.icon, "emoji:🚀");
  await icon.update({ icon: null });
  assert.equal(icon.calls(), 1);
  assert.equal(icon.renderer.root.findByType("Image").props.source.uri, uri);
});

test("icon revision changes fetch new images while ordinary renders use the cache", async (t) => {
  const icon = await mountIcon(t);
  await icon.update({ color: "#123456" });
  assert.equal(icon.calls(), 1);
  await icon.update({}, "revision-two", { icon: { kind: "image", uri: "data:image/png;base64,bmV3" } });
  assert.equal(icon.calls(), 2);
  assert.equal(icon.renderer.root.findByType("Image").props.source.uri, "data:image/png;base64,bmV3");
});

test("safe SVG icons use Paseo's native-capable SVG renderer", async (t) => {
  const svg = '<svg viewBox="0 0 24 24" />';
  const { renderer } = await mountIcon(t, { result: { icon: { kind: "svg", svg } } });
  assert.equal(renderer.root.findByType("Icon").props.icon.svg, svg);
});

test("missing icons and failed requests leave the project usable with a folder", async (t) => {
  for (const options of [{ result: { icon: null } }, { error: true }]) {
    const { renderer } = await mountIcon(t, options);
    assert.equal(renderer.root.findByType("DecorIcon").props.fallback, "Folder");
  }
});

test("project rows honor the icon visibility setting and keep overrides visible", async (t) => {
  let showProjectIcons = true;
  let override = null;
  const { ProjectBlock } = load("client/rows.tsx", {
    "@getpaseo/plugin/client": { useProject: (_ref, selector) => selector({ displayName: "Project" }), useWorkspaces: () => [] },
    "@getpaseo/plugin/client/ui": { Icon: "Icon" },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
    "./project-icon": { ProjectIcon: "ProjectIcon" },
    "./i18n": { useT: () => key => key },
    "./look": { useLook: () => ({ showProjectIcons, icon: 13 }) },
    "./decor": { useDecorations: () => ({ get: () => ({ icon: override, color: null }) }) },
    "./drag": { useDrag: () => ({ recentlyDropped: () => false }), useDragSlot: () => null, useDragHandle: () => ({}) },
  });
  const props = { reference: { key: "host:one", id: "one", hostId: "host" }, collapsed: true, view: { theme: { colors: {} }, layout: { compact: true }, navigation: {} } };
  let renderer;
  await act(() => { renderer = create(React.createElement(ProjectBlock, props)); });
  t.after(async () => act(() => renderer.unmount()));
  assert.equal(renderer.root.findByType("ProjectIcon").props.reference, props.reference);
  showProjectIcons = false;
  await act(() => renderer.update(React.createElement(ProjectBlock, props)));
  assert.equal(renderer.root.findAllByType("ProjectIcon").length, 0);
  override = "lucide:Rocket";
  await act(() => renderer.update(React.createElement(ProjectBlock, props)));
  assert.equal(renderer.root.findByType("ProjectIcon").props.icon, override);
});
