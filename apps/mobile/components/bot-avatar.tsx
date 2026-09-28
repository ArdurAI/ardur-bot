import type { AvatarStyle } from "@ardurbot/contracts";
import {
  ACTIVE_RUN_STATUSES,
  avatarIdentitySeed,
  organicAvatarPath,
  resolvePersonaColorDef,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_VIEWBOX,
} from "@ardurbot/core";
import { memo, useEffect } from "react";
import { Image, Text, useColorScheme, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  Path,
  Rect,
  Image as SvgImage,
} from "react-native-svg";
import { mobileTokens } from "../lib/appearance";
import { workingAvatarDuration, workingAvatarFrame } from "../lib/avatar-motion";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * Generate an SVG path matching the hand-cut seal edge.
 * CSS: border-radius: 50% 48% 52% 50% / 49% 51% 49% 51%
 * Below 28 px the edge is a true circle, per the design canvas.
 */
function sealEdgePath(s: number): string {
  if (s < 28) {
    const r = s / 2;
    return `M${r},0A${r},${r},0,1,1,${r},${s}A${r},${r},0,1,1,${r},0Z`;
  }
  // Horizontal radii: TL=50%, TR=48%, BR=52%, BL=50%
  // Vertical radii:   TL=49%, TR=51%, BR=49%, BL=51%
  const hTL = s * 0.5;
  const vTL = s * 0.49;
  const hTR = s * 0.48;
  const vTR = s * 0.51;
  const hBR = s * 0.52;
  const vBR = s * 0.49;
  const hBL = s * 0.5;
  const vBL = s * 0.51;
  return [
    `M${hTL},0`,
    `L${s - hTR},0`,
    `A${hTR},${vTR},0,0,1,${s},${vTR}`,
    `L${s},${s - vBR}`,
    `A${hBR},${vBR},0,0,1,${s - hBR},${s}`,
    `L${hBL},${s}`,
    `A${hBL},${vBL},0,0,1,0,${s - vBL}`,
    `L0,${vTL}`,
    `A${hTL},${vTL},0,0,1,${hTL},0`,
    "Z",
  ].join("");
}

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  variant,
  muted = false,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  variant?: AvatarStyle;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const scheme = useColorScheme();
  const tokens = mobileTokens("system", scheme);

  const isRunning = status === "running" || status === "queued" || status === "leased";
  const isWaiting = status === "waiting_input";
  const isPaused = status === "waiting_takeover";
  const avatarStatus = isRunning ? "running" : isWaiting ? "waiting" : isPaused ? "paused" : "idle";

  const { avatarStyle } = useAvatarStyle();
  const parsed = mobileBotAvatarPresentation(color);

  const effectiveId =
    identity ||
    (parsed.kind === "shape" || parsed.kind === "color" ? parsed.color : color) ||
    "agent";
  const colorDef = resolvePersonaColorDef(
    effectiveId,
    parsed.kind === "shape" || parsed.kind === "color" ? parsed.color : color,
  );
  const initial = (effectiveId || "A")[0]!.toUpperCase();

  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (isRunning && !reducedMotion) {
      progress.value = withRepeat(
        withTiming(1, {
          duration: 1600,
          easing: Easing.linear,
        }),
        -1,
      );
    }
    return () => cancelAnimation(progress);
  }, [isRunning, progress, reducedMotion]);

  const ringStyle = useAnimatedStyle(() => {
    return {
      transform: [{ rotate: `${progress.value * 360 - 60}deg` }],
    };
  });

  const runningRing = isRunning ? (
    <Animated.View
      style={[
        { position: "absolute", top: -4, left: -4, width: size + 8, height: size + 8 },
        ringStyle,
      ]}
    >
      <Svg width={size + 8} height={size + 8} viewBox="0 0 56 56">
        <AnimatedCircle
          cx="28"
          cy="28"
          r="26"
          stroke={tokens.foreground}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="122 41"
        />
      </Svg>
    </Animated.View>
  ) : null;

  const warningDot = isWaiting ? (
    <View
      style={{
        position: "absolute",
        top: -size * 0.1,
        right: -size * 0.1,
        width: Math.max(8, size * 0.3),
        height: Math.max(8, size * 0.3),
        borderRadius: size,
        backgroundColor: tokens.warning,
        borderWidth: 3,
        borderColor: tokens.background,
      }}
    />
  ) : null;

  const sealPath = sealEdgePath(size);
  const runningSealSize = Math.round(size * 0.8);
  const runningSealPath = sealEdgePath(runningSealSize);
  const clipId = `seal-clip-${size}`;

  const picture =
    parsed.kind === "image" && parsed.imageUrl ? (
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Defs>
          <ClipPath id={clipId}>
            <Path d={sealPath} />
          </ClipPath>
        </Defs>
        <SvgImage
          x="0"
          y="0"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          href={parsed.imageUrl}
          clipPath={`url(#${clipId})`}
        />
        <Path
          d={sealPath}
          stroke={colorDef.hex}
          strokeWidth={2}
          strokeDasharray={isPaused ? "4 3" : undefined}
          fill="none"
        />
      </Svg>
    ) : parsed.kind === "shape" ? (
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Path d={sealPath} fill={tokens.card} />
        <Path
          d={sealPath}
          stroke={colorDef.hex}
          strokeWidth={2}
          strokeDasharray={isPaused ? "4 3" : undefined}
          fill="none"
        />
        <G transform={`translate(${size * 0.1},${size * 0.1}) scale(0.8)`}>
          <Svg viewBox={SHIPPED_BOT_AVATAR_VIEWBOX}>
            <Path d={parsed.shapePath} fill={colorDef.hex} />
            <G fill={colorDef.eyeColor}>
              <Ellipse
                cx={SHIPPED_BOT_AVATAR_CENTER - 29}
                cy={SHIPPED_BOT_AVATAR_CENTER - 8}
                rx={10}
                ry={7}
              />
              <Ellipse
                cx={SHIPPED_BOT_AVATAR_CENTER + 29}
                cy={SHIPPED_BOT_AVATAR_CENTER - 8}
                rx={10}
                ry={7}
              />
            </G>
          </Svg>
        </G>
      </Svg>
    ) : (variant ?? avatarStyle) === "organic" ? (
      <OrganicAvatar
        color={colorDef.hex}
        identity={identity}
        size={size}
        isWorking={isRunning || isWaiting || isPaused}
      />
    ) : (
      <View
        style={{
          width: isRunning ? runningSealSize : size,
          height: isRunning ? runningSealSize : size,
          margin: isRunning ? size * 0.1 : 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Svg
          width={isRunning ? runningSealSize : size}
          height={isRunning ? runningSealSize : size}
          viewBox={`0 0 ${isRunning ? runningSealSize : size} ${isRunning ? runningSealSize : size}`}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          <Path
            d={isRunning ? runningSealPath : sealPath}
            fill={colorDef.hex}
            stroke={isPaused ? tokens.background : undefined}
            strokeWidth={isPaused ? 2 : undefined}
            strokeDasharray={isPaused ? "4 3" : undefined}
          />
        </Svg>
        <Text
          style={{
            color: colorDef.eyeColor,
            fontFamily: "Georgia",
            fontStyle: "italic",
            fontSize: Math.round((isRunning ? runningSealSize : size) * 0.6),
            includeFontPadding: false,
          }}
        >
          {initial}
        </Text>
      </View>
    );

  return (
    <View
      testID={`bot-avatar-${avatarStatus}`}
      style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}
    >
      {runningRing}
      {picture}
      {warningDot}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: tokens.background,
            backgroundColor: tokens.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color={tokens.mutedForeground}
          />
        </View>
      ) : null}
    </View>
  );
});

function OrganicAvatar({
  color,
  identity,
  size,
  isWorking,
}: {
  color: string;
  identity?: string;
  size: number;
  isWorking: boolean;
}) {
  const seed = avatarIdentitySeed(identity || color || "#8B5CF6");
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();
  const scheme = useColorScheme();
  const tokens = mobileTokens("system", scheme);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (isWorking && !reducedMotion) {
      progress.value = withRepeat(
        withTiming(1, {
          duration: workingAvatarDuration(seed),
          easing: Easing.linear,
        }),
        -1,
      );
    }
    return () => cancelAnimation(progress);
  }, [isWorking, progress, reducedMotion, seed]);

  const bodyStyle = useAnimatedStyle(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return {
      transform: [
        { translateX: (frame.translationX * size) / 120 },
        { translateY: (frame.translationY * size) / 120 },
        { rotate: `${frame.rotation}deg` },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
  });
  const leftEyeProps = useAnimatedProps(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return { x: -14 + frame.eyeOffsetX, y: -12 + frame.eyeOffsetY };
  });
  const rightEyeProps = useAnimatedProps(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return { x: 7 + frame.eyeOffsetX, y: -12 + frame.eyeOffsetY };
  });

  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
        <Svg width={size} height={size} viewBox="-60 -60 120 120">
          <Path d={organicAvatarPath(seed)} fill={color} />
          <G transform={`rotate(${(seed % 9) - 4})`}>
            <AnimatedRect
              animatedProps={leftEyeProps}
              width={7}
              height={24}
              rx={3.5}
              fill={tokens.background}
            />
            <AnimatedRect
              animatedProps={rightEyeProps}
              width={7}
              height={24}
              rx={3.5}
              fill={tokens.background}
            />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}
