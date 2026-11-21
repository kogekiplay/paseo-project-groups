import type { AgentRef, PluginSidebarViewProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Platform, View, type ScrollView } from "react-native";
import type { activeFamily } from "./relationship-model";

type Family = ReturnType<typeof activeFamily>;
type Anchor = { center: number; top: number };
export interface RailChildPoint {
  readonly key: string;
  readonly y: number;
}
export interface RailPoints {
  readonly family: Family;
  readonly parent: number;
  readonly children: readonly RailChildPoint[];
}

interface MeasurableNode {
  measureLayout?: (
    relativeTo: unknown,
    onSuccess: (x: number, y: number, width: number, height: number) => void,
    onFail?: () => void,
  ) => void;
  measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
  getBoundingClientRect?: () => { top: number; height: number };
  querySelector?: (selector: string) => { focus?: () => void } | null;
  focus?: () => void;
}

const RAIL_X = 6;
const RAIL_STROKE = 1.5;
const RAIL_ELBOW_WIDTH = 11;
const RAIL_RADIUS = 5;
const EPSILON = 0.5;

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
            resolve(height > 0 ? { center: y + height / 2, top: y } : null);
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
      return { center: top + childRect.height / 2, top };
    }
  }

  if (typeof node.getBoundingClientRect === "function" && typeof container.getBoundingClientRect === "function") {
    const childRect = node.getBoundingClientRect();
    const hostRect = container.getBoundingClientRect();
    if (childRect.height > 0) {
      const top = childRect.top - hostRect.top;
      return { center: top + childRect.height / 2, top };
    }
  }

  return null;
}

function sameFamily(left: Family, right: Family): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.parent.key !== right.parent.key || left.children.length !== right.children.length) return false;
  for (let index = 0; index < left.children.length; index++) {
    if (left.children[index].key !== right.children[index].key) return false;
  }
  return true;
}

function samePoints(left: RailPoints | null, right: RailPoints | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (!sameFamily(left.family, right.family)) return false;
  if (Math.abs(left.parent - right.parent) >= EPSILON) return false;
  if (left.children.length !== right.children.length) return false;
  for (let index = 0; index < left.children.length; index++) {
    const a = left.children[index];
    const b = right.children[index];
    if (a.key !== b.key || Math.abs(a.y - b.y) >= EPSILON) return false;
  }
  return true;
}

function focusAnchorOnWeb(node: MeasurableNode) {
  if (Platform.OS !== "web") return;
  const focusable = node.querySelector?.("[data-pg-nav]") ?? node;
  focusable.focus?.();
}

export function useRelationshipRail(
  family: Family,
  content: RefObject<View | null>,
  scroll: RefObject<ScrollView | null>,
) {
  const nodes = useRef(new Map<string, View>());
  const focusTarget = useRef<{ key: string; focus: boolean; id: number } | null>(null);
  const frame = useRef<FrameHandle | null>(null);
  const request = useRef(0);
  const revealId = useRef(0);
  const mounted = useRef(true);
  const familyRef = useRef<Family>(family);
  familyRef.current = family;
  const pointsRef = useRef<RailPoints | null>(null);
  const [points, setPoints] = useState<RailPoints | null>(null);

  const updatePoints = useCallback((next: RailPoints | null) => {
    if (samePoints(pointsRef.current, next)) return;
    pointsRef.current = next;
    setPoints(next);
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
          scroll.current?.scrollTo({ y: Math.max(0, point.top - 12), animated: false });
          if (target.focus) {
            const node = nodes.current.get(target.key) as MeasurableNode | undefined;
            if (node) focusAnchorOnWeb(node);
          }
        });
      }
      const active = familyRef.current;
      if (!active) {
        updatePoints(null);
        return;
      }
      void Promise.all([measure(active.parent), ...active.children.map(measure)]).then(([parent, ...children]) => {
        if (!mounted.current || request.current !== revision) return;
        const next: RailPoints | null = parent
          ? {
              family: active,
              parent: parent.center,
              children: active.children.flatMap((child, index) => {
                const point = children[index];
                return point ? [{ key: child.key, y: point.center }] : [];
              }),
            }
          : null;
        updatePoints(next);
      });
    });
  }, [measure, scroll, updatePoints]);

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
  }, [family, refresh]);

  const register = useCallback((key: string, node: View | null) => {
    const had = nodes.current.has(key);
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
    const current = familyRef.current;
    const relevant =
      focusTarget.current?.key === key ||
      current?.parent.key === key ||
      current?.children.some((child) => child.key === key);
    if (relevant && (node !== null || had)) refresh();
  }, [refresh]);

  const revealAgent = useCallback((key: string, options?: { focus?: boolean }) => {
    focusTarget.current = { key, focus: options?.focus ?? false, id: ++revealId.current };
    refresh();
  }, [refresh]);

  return { register, refresh, revealAgent, points: points && sameFamily(points.family, family) ? points : null };
}

export function RelationshipRail({
  points,
  theme,
}: {
  points: ReturnType<typeof useRelationshipRail>["points"];
  theme: PluginSidebarViewProps["theme"];
}) {
  if (!points?.children.length) return null;
  const { parent, children } = points;
  const childYs = children.map((child) => child.y);
  const top = Math.min(parent, ...childYs);
  const bottom = Math.max(parent, ...childYs);
  const topIsChild = top < parent;
  const bottomIsChild = bottom > parent;
  const trunkTop = topIsChild ? Math.min(parent, top + RAIL_RADIUS) : top;
  const trunkBottom = bottomIsChild ? Math.max(parent, bottom - RAIL_RADIUS) : bottom;
  const trunkHeight = Math.max(0, trunkBottom - trunkTop);
  const color = theme.colors.accent;
  const ringSize = 7;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: RAIL_X + RAIL_ELBOW_WIDTH + 2 }}
    >
      {trunkHeight > 0 ? (
        <View
          style={{
            position: "absolute",
            left: RAIL_X,
            top: trunkTop,
            height: trunkHeight,
            width: RAIL_STROKE,
            backgroundColor: color,
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
              left: RAIL_X,
              top: child.y - elbowHeight + RAIL_STROKE / 2,
              width: RAIL_ELBOW_WIDTH,
              height: elbowHeight,
              borderLeftWidth: RAIL_STROKE,
              borderBottomWidth: RAIL_STROKE,
              borderBottomLeftRadius: RAIL_RADIUS,
              borderColor: color,
            }}
          />
        ) : (
          <View
            key={child.key}
            style={{
              position: "absolute",
              left: RAIL_X,
              top: child.y - RAIL_STROKE / 2,
              width: RAIL_ELBOW_WIDTH,
              height: elbowHeight,
              borderLeftWidth: RAIL_STROKE,
              borderTopWidth: RAIL_STROKE,
              borderTopLeftRadius: RAIL_RADIUS,
              borderColor: color,
            }}
          />
        );
      })}
      <View
        style={{
          position: "absolute",
          left: RAIL_X - (ringSize - RAIL_STROKE) / 2,
          top: parent - ringSize / 2,
          width: ringSize,
          height: ringSize,
          borderWidth: RAIL_STROKE,
          borderRadius: ringSize / 2,
          borderColor: color,
          backgroundColor: theme.colors.surface0,
        }}
      />
    </View>
  );
}
