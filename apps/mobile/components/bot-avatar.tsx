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
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { mobileTokens } from "../lib/appearance";
import { workingAvatarDuration, workingAvatarFrame } from "../lib/avatar-motion";
import { mobileBotAvatarPresentation } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

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

  const sealRadius = size < 28 ? size / 2 : size * 0.45; // React Native doesn't support complex squircle border radii natively easily. Let's just use 50% for all for now, or just `borderRadius: size / 2` because complex border-radius strings like "50% 48%..." don't work in React Native StyleSheet.

  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (isRunning && !reducedMotion) {
      progress.value = withRepeat(
        withTiming(1, {
          duration: 3000,
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
          strokeDasharray={reducedMotion ? "none" : "122 41"}
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

  const picture =
    parsed.kind === "image" && parsed.imageUrl ? (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: colorDef.hex,
          overflow: "hidden",
        }}
      >
        <Image source={{ uri: parsed.imageUrl }} style={{ width: size, height: size }} />
      </View>
    ) : parsed.kind === "shape" ? (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 2,
          borderColor: colorDef.hex,
          backgroundColor: tokens.card,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Svg width={size * 0.8} height={size * 0.8} viewBox={SHIPPED_BOT_AVATAR_VIEWBOX}>
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
      </View>
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
          width: isRunning ? size * 0.8 : size,
          height: isRunning ? size * 0.8 : size,
          margin: isRunning ? size * 0.1 : 0,
          borderRadius: size / 2,
          backgroundColor: isPaused ? "transparent" : colorDef.hex,
          borderWidth: isPaused ? 2 : 0,
          borderStyle: isPaused ? "dashed" : "solid",
          borderColor: isPaused ? colorDef.hex : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: isPaused ? tokens.mutedForeground : colorDef.eyeColor,
            fontFamily: "Georgia", // 'Instrument Serif' may not be available on mobile, using serif fallback
            fontStyle: "italic",
            fontSize: Math.round((isRunning ? size * 0.8 : size) * 0.6),
            includeFontPadding: false,
          }}
        >
          {initial}
        </Text>
      </View>
    );

  return (
    <View style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}>
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
