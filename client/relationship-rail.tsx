import type { AgentRef, PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Platform, View, type ScrollView } from "react-native";
import type { RelationshipFamily } from "./relationship-model";

type Anchor = { center: number; top: number; bottom: number };

export interface RailChildPoint {
  readonly key: string;
  readonly y: number;
}

export interface RailSegment {
  readonly parentKey: string;
  readonly parent: number;
  readonly children: readonly RailChildPoint[];
  readonly lane: number;
}

export interface RailLayout {
  readonly rails: readonly RailSegment[];
  readonly laneCount: number;
}

interface MeasurableNode {
  measureLayout?: (
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ) => void;
  measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
  getBoundingClientRect?: () => { top: number; height: number };
  querySelector?: (selector: string) => { focus?: (options?: { preventScroll?: boolean }) => void } | null;
  focus?: (options?: { preventScroll?: boolean }) => void;
}

const RAIL_BASE_X = 6;
const LANE_STEP = 5;
const MAX_LANES = 3;
const RAIL_STROKE = 1.5;
const RAIL_ELBOW_BASE_END = 17;
const RAIL_RADIUS = 5;
const LANE_GAP = 6;
const EPSILON = 0.5;
const SCROLL_MARGIN = 8;
const EMPTY_LAYOUT: RailLayout = { rails: [], laneCount: 0 };

type FrameHandle = { kind: "raf"; id: number } | { kind: "timer"; id: ReturnType<typeof setTimeout> };

function scheduleFrame(callback: () => void): FrameHandle {
  if (typeof requestAnimationFrame === "function") {
    return { kind: "raf", id: requestAnimationFrame(callback) };
  }
  return { kind: "timer", id: setTimeout(callback, 0) };
}

function cancelFrame(handle: FrameHandle) {
  if (handle.kind === "raf" && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle.id);
  } else if (handle.kind === "timer") {
    clearTimeout(handle.id);
  }
}

function measureInWindowOf(node: MeasurableNode): Promise<{ y: number; height: number } | null> {
  if (typeof node.measureInWindow !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      node.measureInWindow!((_x, y, _width, height) => resolve({ y, height }));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Measure a row anchor relative to the scroll content container. Prefers `measureLayout`, then
 * falls back to `measureInWindow` deltas (native & web) and DOM rects (web) so measurement stays
 * reliable across React Native Paper/Fabric and react-native-web.
 */
async function measureRelative(node: MeasurableNode, container: MeasurableNode): Promise<Anchor | null> {
  if (typeof node.measureLayout === "function") {
    const layout = await new Promise<Anchor | null>((resolve) => {
      try {
        node.measureLayout!(
          container,
          (_x, y, _width, height) => {
            resolve(height > 0 ? { center: y + height / 2, top: y, bottom: y + height } : null);
          },
          () => resolve(null),
        );
      } catch {
        resolve(null);
      }
    });
    if (layout) return layout;
  }

  if (typeof node.measureInWindow === "function" && typeof container.measureInWindow === "function") {
    const [childRect, hostRect] = await Promise.all([measureInWindowOf(node), measureInWindowOf(container)]);
    if (childRect && hostRect && childRect.height > 0) {
      const top = childRect.y - hostRect.y;
      return { center: top + childRect.height / 2, top, bottom: top + childRect.height };
    }
  }

  if (typeof node.getBoundingClientRect === "function" && typeof container.getBoundingClientRect === "function") {
    const childRect = node.getBoundingClientRect();
    const hostRect = container.getBoundingClientRect();
    if (childRect.height > 0) {
      const top = childRect.top - hostRect.top;
      return { center: top + childRect.height / 2, top, bottom: top + childRect.height };
    }
  }

  return null;
}

/** Assign non-overlapping vertical lanes (capped at MAX_LANES to protect narrow mobile widths). */
function assignLanes(
  candidates: readonly { parentKey: string; parent: number; children: readonly RailChildPoint[]; top: number; bottom: number }[],
): RailLayout {
  if (!candidates.length) return EMPTY_LAYOUT;
  const sorted = [...candidates].sort(
    (a, b) => a.top - b.top || (a.bottom - a.top) - (b.bottom - b.top) || a.parentKey.localeCompare(b.parentKey),
  );
  const laneBottoms: number[] = [];
  const rails: RailSegment[] = [];
  for (const item of sorted) {
    let lane = laneBottoms.findIndex((end) => end + LANE_GAP < item.top);
    if (lane === -1) {
      if (laneBottoms.length < MAX_LANES) {
        lane = laneBottoms.length;
        laneBottoms.push(item.bottom);
      } else {
        // Reuse the lane whose span finished earliest.
        lane = 0;
        for (let index = 1; index < laneBottoms.length; index++) {
          if (laneBottoms[index] < laneBottoms[lane]) lane = index;
        }
        laneBottoms[lane] = Math.max(laneBottoms[lane], item.bottom);
      }
    } else {
      laneBottoms[lane] = item.bottom;
    }
    rails.push({ parentKey: item.parentKey, parent: item.parent, children: item.children, lane });
  }
  return { rails, laneCount: laneBottoms.length };
}

function sameLayout(left: RailLayout, right: RailLayout): boolean {
  if (left === right) return true;
  if (left.laneCount !== right.laneCount || left.rails.length !== right.rails.length) return false;
  for (let i = 0; i < left.rails.length; i++) {
    const a = left.rails[i];
    const b = right.rails[i];
    if (
      a.parentKey !== b.parentKey ||
      a.lane !== b.lane ||
      Math.abs(a.parent - b.parent) >= EPSILON ||
      a.children.length !== b.children.length
    ) {
      return false;
    }
    for (let j = 0; j < a.children.length; j++) {
      if (a.children[j].key !== b.children[j].key || Math.abs(a.children[j].y - b.children[j].y) >= EPSILON) {
        return false;
      }
    }
  }
  return true;
}

function focusAnchorOnWeb(node: MeasurableNode) {
  if (Platform.OS !== "web") return;
  const focusable = node.querySelector?.("[data-pg-nav]") ?? node;
  focusable.focus?.({ preventScroll: true });
}

/**
 * Compute the minimal scroll offset to bring `point` into `[scrollY, scrollY + viewportHeight]`,
 * or `null` when it is already visible inside the viewport.
 */
function minimalScrollTarget(point: Anchor, scrollY: number, viewportHeight: number, wasCollapsed: boolean): number | null {
  if (viewportHeight > 0) {
    if (point.top >= scrollY && point.bottom <= scrollY + viewportHeight) return null;
    if (point.top < scrollY) return Math.max(0, point.top - SCROLL_MARGIN);
    return Math.max(0, point.bottom - viewportHeight + SCROLL_MARGIN);
  }
  return wasCollapsed ? Math.max(0, point.top - SCROLL_MARGIN) : null;
}

export function useRelationshipRail(
  families: readonly RelationshipFamily[],
  content: RefObject<View | null>,
  scroll: RefObject<ScrollView | null>,
) {
  const nodes = useRef(new Map<string, View>());
  const focusTarget = useRef<{ key: string; focus: boolean; wasCollapsed: boolean; id: number } | null>(null);
  const frame = useRef<FrameHandle | null>(null);
  const request = useRef(0);
  const revealId = useRef(0);
  const mounted = useRef(true);
  const scrollYRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const familiesRef = useRef<readonly RelationshipFamily[]>(families);
  familiesRef.current = families;
  const trackedKeysRef = useRef<Set<string>>(new Set());
  const layoutRef = useRef<RailLayout>(EMPTY_LAYOUT);
  const [layout, setLayout] = useState<RailLayout>(EMPTY_LAYOUT);

  const tracked = new Set<string>();
  for (const family of families) {
    tracked.add(family.parent.key);
    for (const child of family.children) tracked.add(child.key);
  }
  trackedKeysRef.current = tracked;

  const updateLayout = useCallback((next: RailLayout) => {
    if (sameLayout(layoutRef.current, next)) return;
    layoutRef.current = next;
    setLayout(next);
  }, []);

  const measure = useCallback((agent: AgentRef | string): Promise<Anchor | null> => {
    const key = typeof agent === "string" ? agent : agent.key;
    const node = nodes.current.get(key) as MeasurableNode | undefined;
    const container = content.current as MeasurableNode | null;
    if (!node || !container) return Promise.resolve(null);
    return measureRelative(node, container);
  }, [content]);

  const refresh = useCallback(() => {
    if (frame.current !== null) cancelFrame(frame.current);
    const revision = ++request.current;
    frame.current = scheduleFrame(() => {
      frame.current = null;
      if (!mounted.current) return;
      const target = focusTarget.current;
      if (target) {
        void measure(target.key).then((point) => {
          if (!mounted.current || !point || focusTarget.current?.id !== target.id) return;
          focusTarget.current = null;
          const nextY = minimalScrollTarget(point, scrollYRef.current, viewportHeightRef.current, target.wasCollapsed);
          if (nextY !== null) {
            scroll.current?.scrollTo({ y: nextY, animated: false });
          }
          if (target.focus) {
            const node = nodes.current.get(target.key) as MeasurableNode | undefined;
            if (node) focusAnchorOnWeb(node);
          }
        });
      }
      const activeFamilies = familiesRef.current;
      if (!activeFamilies.length) {
        updateLayout(EMPTY_LAYOUT);
        return;
      }
      // Measure every referenced row anchor once per batched frame.
      const keys = new Set<string>();
      for (const family of activeFamilies) {
        keys.add(family.parent.key);
        for (const child of family.children) keys.add(child.key);
      }
      const keyList = [...keys];
      void Promise.all(keyList.map((key) => measure(key))).then((anchors) => {
        if (!mounted.current || request.current !== revision) return;
        const byKey = new Map<string, Anchor>();
        keyList.forEach((key, index) => {
          const anchor = anchors[index];
          if (anchor) byKey.set(key, anchor);
        });
        const candidates: {
          parentKey: string;
          parent: number;
          children: readonly RailChildPoint[];
          top: number;
          bottom: number;
        }[] = [];
        for (const family of activeFamilies) {
          const parentAnchor = byKey.get(family.parent.key);
          if (!parentAnchor) continue;
          const children = family.children.flatMap((child) => {
            const point = byKey.get(child.key);
            return point ? [{ key: child.key, y: point.center }] : [];
          });
          if (!children.length) continue;
          const ys = children.map((child) => child.y);
          candidates.push({
            parentKey: family.parent.key,
            parent: parentAnchor.center,
            children,
            top: Math.min(parentAnchor.center, ...ys),
            bottom: Math.max(parentAnchor.center, ...ys),
          });
        }
        updateLayout(assignLanes(candidates));
      });
    });
  }, [measure, scroll, updateLayout]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
      if (frame.current !== null) cancelFrame(frame.current);
      frame.current = null;
    };
  }, []);

  useEffect(() => {
    refresh();
  }, [families, refresh]);

  const register = useCallback((key: string, node: View | null) => {
    const had = nodes.current.has(key);
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
    const relevant = focusTarget.current?.key === key || trackedKeysRef.current.has(key);
    if (relevant && (node !== null || had)) refresh();
  }, [refresh]);

  const revealAgent = useCallback((key: string, options?: { focus?: boolean; wasCollapsed?: boolean }) => {
    focusTarget.current = {
      key,
      focus: options?.focus ?? false,
      wasCollapsed: options?.wasCollapsed ?? false,
      id: ++revealId.current,
    };
    refresh();
  }, [refresh]);

  const onScroll = useCallback((y: number) => {
    scrollYRef.current = y;
  }, []);

  const onViewportHeight = useCallback((height: number) => {
    viewportHeightRef.current = height;
  }, []);

  const gutterExtra = layout.laneCount > 1 ? (layout.laneCount - 1) * LANE_STEP : 0;

  return {
    register,
    refresh,
    revealAgent,
    onScroll,
    onViewportHeight,
    rails: families.length ? layout.rails : EMPTY_LAYOUT.rails,
    laneCount: families.length ? layout.laneCount : 0,
    gutterExtra: families.length ? gutterExtra : 0,
  };
}

function RailItem({
  rail,
  active,
  elbowEndX,
  theme,
}: {
  rail: RailSegment;
  active: boolean;
  elbowEndX: number;
  theme: PluginSidebarViewProps["theme"];
}) {
  const x = RAIL_BASE_X + rail.lane * LANE_STEP;
  const elbowWidth = Math.max(8, elbowEndX - x);
  const { parent, children } = rail;
  const childYs = children.map((child) => child.y);
  const top = Math.min(parent, ...childYs);
  const bottom = Math.max(parent, ...childYs);
  const topIsChild = top < parent;
  const bottomIsChild = bottom > parent;
  const trunkTop = topIsChild ? Math.min(parent, top + RAIL_RADIUS) : top;
  const trunkBottom = bottomIsChild ? Math.max(parent, bottom - RAIL_RADIUS) : bottom;
  const trunkHeight = Math.max(0, trunkBottom - trunkTop);
  const color = active ? theme.colors.accent : theme.colors.foregroundMuted;
  const lineOpacity = active ? 1 : 0.42;
  const ringSize = 7;

  return (
    <>
      {trunkHeight > 0 ? (
        <View
          style={{
            position: "absolute",
            left: x,
            top: trunkTop,
            height: trunkHeight,
            width: RAIL_STROKE,
            backgroundColor: color,
            opacity: lineOpacity,
          }}
        />
      ) : null}
      {children.map((child) => {
        const below = child.y >= parent;
        const elbowHeight = RAIL_RADIUS + RAIL_STROKE;
        return below ? (
          <View
            key={child.key}
            style={{
              position: "absolute",
              left: x,
              top: child.y - elbowHeight + RAIL_STROKE / 2,
              width: elbowWidth,
              height: elbowHeight,
              borderLeftWidth: RAIL_STROKE,
              borderBottomWidth: RAIL_STROKE,
              borderBottomLeftRadius: RAIL_RADIUS,
              borderColor: color,
              opacity: lineOpacity,
            }}
          />
        ) : (
          <View
            key={child.key}
            style={{
              position: "absolute",
              left: x,
              top: child.y - RAIL_STROKE / 2,
              width: elbowWidth,
              height: elbowHeight,
              borderLeftWidth: RAIL_STROKE,
              borderTopWidth: RAIL_STROKE,
              borderTopLeftRadius: RAIL_RADIUS,
              borderColor: color,
              opacity: lineOpacity,
            }}
          />
        );
      })}
      {/* Opaque backdrop hides the trunk inside the hollow parent ring without tinting the ring border. */}
      <View
        style={{
          position: "absolute",
          left: x - (ringSize - RAIL_STROKE) / 2,
          top: parent - ringSize / 2,
          width: ringSize,
          height: ringSize,
          borderRadius: ringSize / 2,
          backgroundColor: theme.colors.surface0,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: x - (ringSize - RAIL_STROKE) / 2,
          top: parent - ringSize / 2,
          width: ringSize,
          height: ringSize,
          borderWidth: RAIL_STROKE,
          borderRadius: ringSize / 2,
          borderColor: color,
          opacity: lineOpacity,
        }}
      />
    </>
  );
}

export function RelationshipRail({
  rails,
  laneCount = 1,
  activeParentKey = null,
  theme,
}: {
  rails: readonly RailSegment[];
  laneCount?: number;
  activeParentKey?: string | null;
  theme: PluginSidebarViewProps["theme"];
}) {
  if (!rails.length) return null;
  const extra = laneCount > 1 ? (laneCount - 1) * LANE_STEP : 0;
  const elbowEndX = RAIL_ELBOW_BASE_END + extra;
  // Draw muted rails first and the active/hovered accent rail on top.
  const ordered = activeParentKey
    ? [
        ...rails.filter((item) => item.parentKey !== activeParentKey),
        ...rails.filter((item) => item.parentKey === activeParentKey),
      ]
    : rails;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: elbowEndX + 2 }}
    >
      {ordered.map((rail) => (
        <RailItem
          key={rail.parentKey}
          rail={rail}
          active={rail.parentKey === activeParentKey}
          elbowEndX={elbowEndX}
          theme={theme}
        />
      ))}
    </View>
  );
}
