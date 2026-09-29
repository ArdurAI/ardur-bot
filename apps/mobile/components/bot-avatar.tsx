import type { AvatarStyle } from "@ardurbot/contracts";
import type { SealBand, SealPhase } from "@ardurbot/core";
import {
  avatarIdentitySeed,
  avatarInitial,
  deriveSealPhase,
  organicAvatarPath,
  resolvePersonaColorDef,
  SEAL_PICTURE_BANDS,
  SHIPPED_BOT_AVATAR_CENTER,
  SHIPPED_BOT_AVATAR_VIEWBOX,
  sealInitial,
  sealLayers,
  sealScenePack,
} from "@ardurbot/core";
import { memo, useEffect } from "react";
import { Text, useColorScheme, View } from "react-native";
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
import Svg, { ClipPath, Defs, Ellipse, G, Path, Rect, Image as SvgImage } from "react-native-svg";
import { mobileTokens } from "../lib/appearance";
import { workingAvatarDuration, workingAvatarFrame } from "../lib/avatar-motion";
import { mobileBotAvatarPresentation, sealEdgePath } from "../lib/bot-avatar";
import { useI18n } from "../lib/i18n";
import { sealNativeColors } from "../lib/seal-scene";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";
import { SealLayers } from "./seal-layers";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** The four states the avatar exposed before phases, kept for its test id. */
const AVATAR_STATUS: Record<SealPhase, "running" | "waiting" | "paused" | "idle"> = {
  idle: "idle",
  starting: "running",
  thinking: "running",
  searching: "running",
  steps: "running",
  waiting: "waiting",
  paused: "paused",
  done: "idle",
  error: "idle",
};

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  phase: phaseProp,
  status,
  identity,
  label,
  variant,
  muted = false,
}: {
  color: string;
  size?: number;
  /** What the bot is doing; takes precedence over `status`. */
  phase?: SealPhase;
  /** A run status, mapped to a phase when `phase` is not given. */
  status?: string;
  identity?: string;
  /** Display name used for the seal initial; identity stays the hash seed. */
  label?: string;
  variant?: AvatarStyle;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const scheme = useColorScheme();
  const tokens = mobileTokens("system", scheme);

  const phase = phaseProp ?? deriveSealPhase({ status }).phase;
  const avatarStatus = AVATAR_STATUS[phase];

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
  const initial = avatarInitial(label ?? effectiveId);

  const reducedMotion = useReducedMotion();
  // A chosen picture keeps its pigment edge and shows only the ring and badge bands.
  const chosenPicture =
    (parsed.kind === "image" && Boolean(parsed.imageUrl)) || parsed.kind === "shape";
  const organic = !chosenPicture && (variant ?? avatarStyle) === "organic";
  const layers = organic
    ? []
    : sealLayers(sealScenePack(), phase, size, chosenPicture ? SEAL_PICTURE_BANDS : undefined);
  const colors = sealNativeColors(colorDef.hex, tokens.warning);
  const scene = (bands: readonly SealBand[]) => {
    const drawn = layers.filter((layer) => bands.includes(layer.band));
    return drawn.length > 0 ? (
      <SealLayers layers={drawn} size={size} colors={colors} moving={!reducedMotion} />
    ) : null;
  };

  const sealPath = sealEdgePath(size);
  const clipId = `seal-clip-${size}`;
  const initialRule = sealInitial(size);

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
        <Path d={sealPath} stroke={colorDef.hex} strokeWidth={2} fill="none" />
      </Svg>
    ) : parsed.kind === "shape" ? (
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Path d={sealPath} fill={tokens.card} />
        <Path d={sealPath} stroke={colorDef.hex} strokeWidth={2} fill="none" />
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
    ) : organic ? (
      <OrganicAvatar
        color={colorDef.hex}
        identity={identity}
        size={size}
        isWorking={avatarStatus !== "idle"}
      />
    ) : (
      // The seal: its pigment disc, then the scene, the initial and the ring.
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        <Svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          <Path d={sealPath} fill={colorDef.hex} />
        </Svg>
        {scene(["disc", "scene"])}
        <Text
          accessible={false}
          style={{
            color: colorDef.eyeColor,
            fontFamily: "Georgia",
            fontStyle: "italic",
            fontSize: Math.round((size * initialRule.size) / 100),
            includeFontPadding: false,
            transform: [{ translateY: ((initialRule.y - 50) * size) / 100 }],
          }}
        >
          {initial}
        </Text>
        {scene(["ring", "badge"])}
      </View>
    );

  return (
    <View
      testID={`bot-avatar-${avatarStatus}`}
      style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}
    >
      {picture}
      {chosenPicture ? scene(SEAL_PICTURE_BANDS) : null}
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
