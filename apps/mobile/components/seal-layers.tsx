import type {
  SealColors,
  SealElementProps,
  SealLayer,
  SealMotion,
  SealMotionProperty,
} from "@ardurbot/core";
import { isSealTransformMotion, sealMotions, sealStillProps } from "@ardurbot/core";
import { useEffect } from "react";
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import type { SealCurve } from "../lib/seal-scene";
import { sealLayerGroups, sealStillValue, sealTimeline } from "../lib/seal-scene";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedLine = Animated.createAnimatedComponent(Line);
const AnimatedRect = Animated.createAnimatedComponent(Rect);

type ShapeMotionProperty = "opacity" | "fillOpacity" | "strokeOpacity" | "dashOffset";

function easing(curve: SealCurve) {
  return curve === "linear" ? Easing.linear : Easing.bezier(...curve);
}

/** Loops `value` through a motion's keyframes, or holds the still pose. */
function useMotion(
  value: SharedValue<number>,
  motion: SealMotion | undefined,
  still: number,
  moving: boolean,
) {
  useEffect(() => {
    cancelAnimation(value);
    value.value = still;
    if (!motion || !moving) return;
    const { delayMs, steps } = sealTimeline(motion);
    const [first, ...rest] = steps.map((step) =>
      withTiming(step.value, { duration: step.durationMs, easing: easing(step.curve) }),
    );
    // Like CSS fill-mode both, the first keyframe holds through the delay.
    value.value = steps[0]!.value;
    value.value = withDelay(delayMs, withRepeat(withSequence(first!, ...rest), -1));
    return () => cancelAnimation(value);
  }, [value, motion, still, moving]);
}

const PAINT_MOTIONS: readonly ShapeMotionProperty[] = [
  "opacity",
  "fillOpacity",
  "strokeOpacity",
  "dashOffset",
];

/** Draws a layer: its still pose, or its paint motions when motion is allowed. */
function SealShape({
  layer,
  size,
  colors,
  moving,
  withoutTransform = false,
}: {
  layer: SealLayer;
  size: number;
  colors: SealColors;
  moving: boolean;
  withoutTransform?: boolean;
}) {
  const still = sealStillProps(layer, size, colors);
  const props: SealElementProps = withoutTransform ? { ...still, transform: undefined } : still;
  const painted = sealMotions(layer).filter((motion) =>
    (PAINT_MOTIONS as readonly string[]).includes(motion.property),
  );
  return moving && painted.length > 0 ? (
    <MovingShape layer={layer} props={props} motions={painted} />
  ) : (
    <Shape props={props} />
  );
}

/** A plain shape, or an animated one when `live` carries animated props. */
function Shape({ props, live }: { props: SealElementProps; live?: object }) {
  switch (props.element) {
    case "circle": {
      const { element: _element, ...rest } = props;
      return live ? <AnimatedCircle {...rest} {...live} /> : <Circle {...rest} />;
    }
    case "path": {
      const { element: _element, ...rest } = props;
      return live ? <AnimatedPath {...rest} {...live} /> : <Path {...rest} />;
    }
    case "line": {
      const { element: _element, ...rest } = props;
      return live ? <AnimatedLine {...rest} {...live} /> : <Line {...rest} />;
    }
    case "rect": {
      const { element: _element, ...rest } = props;
      return live ? <AnimatedRect {...rest} {...live} /> : <Rect {...rest} />;
    }
  }
}

function MovingShape({
  layer,
  props,
  motions,
}: {
  layer: SealLayer;
  props: SealElementProps;
  motions: readonly SealMotion[];
}) {
  const motionFor = (property: ShapeMotionProperty) =>
    motions.find((motion) => motion.property === property);
  const opacity = useSharedValue(sealStillValue(layer, "opacity"));
  const fillOpacity = useSharedValue(sealStillValue(layer, "fillOpacity"));
  const strokeOpacity = useSharedValue(sealStillValue(layer, "strokeOpacity"));
  const dashOffset = useSharedValue(sealStillValue(layer, "dashOffset"));
  useMotion(opacity, motionFor("opacity"), sealStillValue(layer, "opacity"), true);
  useMotion(fillOpacity, motionFor("fillOpacity"), sealStillValue(layer, "fillOpacity"), true);
  useMotion(
    strokeOpacity,
    motionFor("strokeOpacity"),
    sealStillValue(layer, "strokeOpacity"),
    true,
  );
  useMotion(dashOffset, motionFor("dashOffset"), sealStillValue(layer, "dashOffset"), true);
  const animated = motions.map((motion) => motion.property);
  const animatedProps = useAnimatedProps(() => {
    const next: {
      opacity?: number;
      fillOpacity?: number;
      strokeOpacity?: number;
      strokeDashoffset?: number;
    } = {};
    if (animated.includes("opacity")) next.opacity = opacity.value;
    if (animated.includes("fillOpacity")) next.fillOpacity = fillOpacity.value;
    if (animated.includes("strokeOpacity")) next.strokeOpacity = strokeOpacity.value;
    if (animated.includes("dashOffset")) next.strokeDashoffset = dashOffset.value;
    return next;
  });
  return <Shape props={props} live={{ animatedProps }} />;
}

/** A layer that moves as a whole, on its own native view. */
function SealTransformLayer({
  layer,
  size,
  colors,
  moving,
}: {
  layer: SealLayer;
  size: number;
  colors: SealColors;
  moving: boolean;
}) {
  const motion = sealMotions(layer).find(isSealTransformMotion)!;
  const property: SealMotionProperty = motion.property;
  const still = sealStillValue(layer, property);
  const value = useSharedValue(still);
  useMotion(value, motion, still, moving);
  const unit = size / 100;
  const [originX, originY] = motion.origin ?? [50, 50];
  const style = useAnimatedStyle(() => {
    if (property === "rotate") return { transform: [{ rotate: `${value.value}deg` }] };
    if (property === "scale") return { transform: [{ scale: value.value }] };
    if (property === "translateX") return { transform: [{ translateX: value.value * unit }] };
    return { transform: [{ translateY: value.value * unit }] };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          width: size,
          height: size,
          transformOrigin: [originX * unit, originY * unit, 0],
        },
        style,
      ]}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <SealShape layer={layer} size={size} colors={colors} moving={moving} withoutTransform />
      </Svg>
    </Animated.View>
  );
}

/** Pack layers over a native seal, in drawing order. */
export function SealLayers({
  layers,
  size,
  colors,
  moving,
}: {
  layers: readonly SealLayer[];
  size: number;
  colors: SealColors;
  moving: boolean;
}) {
  return sealLayerGroups(layers).map((group) =>
    group.kind === "transform" ? (
      <SealTransformLayer
        key={group.layer.id}
        layer={group.layer}
        size={size}
        colors={colors}
        moving={moving}
      />
    ) : (
      <Svg
        key={group.layers.map((layer) => layer.id).join("+")}
        pointerEvents="none"
        width={size}
        height={size}
        viewBox="0 0 100 100"
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        {group.layers.map((layer) => (
          <SealShape key={layer.id} layer={layer} size={size} colors={colors} moving={moving} />
        ))}
      </Svg>
    ),
  );
}
