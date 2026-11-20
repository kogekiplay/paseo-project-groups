import { useEffect } from "react";
import { Animated, Easing, Platform, View } from "react-native";

const progress = new Animated.Value(0);
const rotation = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
let spinnerCount = 0;
let animation: Animated.CompositeAnimation | null = null;

export function RunningSpinner({ color, size }: { color: string; size: number }) {
  useEffect(() => {
    spinnerCount += 1;
    if (spinnerCount === 1) {
      progress.setValue(0);
      animation = Animated.loop(
        Animated.timing(progress, {
          toValue: 1,
          duration: 800,
          easing: Easing.linear,
          isInteraction: false,
          useNativeDriver: Platform.OS !== "web",
        }),
      );
      animation.start();
    }
    return () => {
      spinnerCount -= 1;
      if (spinnerCount === 0) {
        animation?.stop();
        animation = null;
      }
    };
  }, []);

  const ring = { width: size, height: size, borderRadius: size / 2, borderWidth: size / 8 };
  return (
    <View accessible={false} pointerEvents="none" style={{ width: size, height: size }}>
      <View style={{ ...ring, position: "absolute", borderColor: color, opacity: 0.2 }} />
      <Animated.View
        style={{ ...ring, borderColor: "transparent", borderTopColor: color, transform: [{ rotate: rotation }] }}
      />
    </View>
  );
}
