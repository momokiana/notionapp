import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { ASTNode, RenderRules } from "react-native-markdown-display";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

/** Centered subtle date / time divider between conversation segments. */
export function TimeDividerChip({ label }: { label: string }) {
  const p = usePalette();
  return (
    <View style={{ alignItems: "center", paddingVertical: space.xs }}>
      <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: p.surface2 }}>
        <Text style={{ fontSize: 11, color: p.faint, fontFamily: fonts.bodySemi }}>{label}</Text>
      </View>
    </View>
  );
}

/** Code block with language header, 1-tap copy button, and smooth horizontal scroll. */
export function CodeFenceBlock({
  code,
  lang,
  onCopied,
}: {
  code: string;
  lang?: string;
  onCopied?: () => void;
}) {
  const p = usePalette();
  const [copied, setCopied] = useState(false);

  function copy() {
    Haptics.selectionAsync().catch(() => undefined);
    void Clipboard.setStringAsync(code).then(() => {
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <View
      style={{
        marginVertical: 4,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: p.divider,
        backgroundColor: p.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: space.md,
          paddingVertical: 5,
          borderBottomWidth: 1,
          borderBottomColor: p.divider,
          backgroundColor: p.surface,
        }}
      >
        <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, color: p.faint }}>
          {lang?.trim() || "代码"}
        </Text>
        <Pressable
          onPress={copy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="复制这段代码"
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: radius.pill,
            backgroundColor: pressed ? p.surface3 : "transparent",
          })}
        >
          <MaterialCommunityIcons name={copied ? "check" : "content-copy"} size={12.5} color={copied ? p.accentText : p.muted} />
          <Text style={{ fontSize: 11, color: copied ? p.accentText : p.muted, fontFamily: fonts.bodySemi }}>
            {copied ? "已复制" : "复制代码"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator contentContainerStyle={{ padding: space.md }}>
        <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19, color: p.ink }}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

/** Shared Markdown rules hook enabling scrollable copyable code fences across chats. */
export function useChatMarkdownRules(onCopied?: () => void): RenderRules {
  return useMemo(
    () => ({
      fence: (node) => {
        const raw = typeof node.content === "string" ? node.content : "";
        const code = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
        const lang = (node as ASTNode & { sourceInfo?: string }).sourceInfo;
        return <CodeFenceBlock key={node.key} code={code} lang={lang} onCopied={onCopied} />;
      },
    }),
    [onCopied],
  );
}
