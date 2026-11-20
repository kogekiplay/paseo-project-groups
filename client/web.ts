import { Platform } from "react-native";

interface AnimatableView {
  animate(
    keyframes: { transform: string }[],
    options: { duration: number; iterations: number },
  ): { startTime: number | null; cancel(): void };
}

export function animateSpinnerOnWeb(view: unknown, duration: number): (() => void) | undefined {
  if (Platform.OS !== "web") return;
  const element = view as Partial<AnimatableView> | null;
  if (typeof element?.animate !== "function") return;

  const animation = element.animate(
    [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
    { duration, iterations: Infinity },
  );
  // Anchor every ring to the document timeline, including rings mounted later.
  animation.startTime = 0;
  return () => animation.cancel();
}
