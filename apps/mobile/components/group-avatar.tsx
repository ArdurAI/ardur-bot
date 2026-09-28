import { memo } from "react";
import { StyleSheet, Text, useColorScheme, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { native, useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  status?: string;
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 54,
}: {
  members: GroupAvatarMember[];
  size?: number;
}) {
  const styles = useThemedStyles(createGroupAvatarStyles);
  const scheme = useColorScheme();
  const tokens = mobileTokens("system", scheme);

  const firstMember = members[0];
  if (!firstMember) {
    return (
      <View
        style={[
          styles.fallback,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
          },
        ]}
      >
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.35) }]}>👥</Text>
      </View>
    );
  }

  if (members.length === 1) {
    return (
      <BotAvatar
        color={firstMember.color}
        identity={firstMember.botId ?? firstMember.name}
        label={firstMember.name}
        size={size}
        status={firstMember.status}
      />
    );
  }

  const overlap = Math.round(size / 3);
  const visibleMembers = members.slice(0, members.length > 3 ? 2 : members.length);

  return (
    <View style={{ height: size, flexDirection: "row", alignItems: "center" }}>
      {visibleMembers.map((member, index) => (
        <View
          key={member.botId ?? index}
          style={{
            marginLeft: index === 0 ? 0 : -overlap,
            zIndex: index + 1,
            width: size,
            height: size,
          }}
        >
          <View
            style={{
              position: "absolute",
              top: -2,
              left: -2,
              width: size + 4,
              height: size + 4,
              borderRadius: (size + 4) / 2,
              backgroundColor: tokens.background,
            }}
          />
          <BotAvatar
            color={member.color}
            identity={member.botId ?? member.name}
            label={member.name}
            size={size}
            status={member.status}
          />
        </View>
      ))}
      {members.length > 3 ? (
        <View
          style={{
            marginLeft: -overlap,
            width: size,
            height: size,
            zIndex: members.length + 1,
          }}
        >
          <View
            style={{
              position: "absolute",
              top: -2,
              left: -2,
              width: size + 4,
              height: size + 4,
              borderRadius: (size + 4) / 2,
              backgroundColor: tokens.background,
            }}
          />
          <View
            style={{
              flex: 1,
              borderRadius: size / 2,
              backgroundColor: native.fillPressed,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{ color: native.label, fontSize: Math.round(size * 0.3), fontWeight: "600" }}
            >
              +{members.length - 2}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
});

function createGroupAvatarStyles() {
  return StyleSheet.create({
    fallback: {
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    fallbackText: {
      color: native.secondaryLabel,
    },
  });
}
