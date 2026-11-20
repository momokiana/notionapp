import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { previewQuoteText, type ReplyQuote } from "../lib/quote";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

/** Rendered inside a user bubble above the reply body when the message quotes an earlier turn. */
export function QuoteSnippet({ author, text, inverse }: { author?: string; text: string; inverse?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: inverse ? "rgba(255,255,255,0.65)" : p.accentText,
        backgroundColor: inverse ? "rgba(255,255,255,0.14)" : p.surface2,
        borderRadius: radius.xs,
        paddingHorizontal: space.sm,
        paddingVertical: 5,
        marginBottom: 6,
      }}
    >
      <Text numberOfLines={1} style={{ fontFamily: fonts.bodySemi, fontSize: 11, color: inverse ? "rgba(255,255,255,0.85)" : p.accentText }}>
        {author ? `引用 · ${author}` : "引用"}
      </Text>
      <Text numberOfLines={2} style={{ fontSize: 12, lineHeight: 17, color: inverse ? "rgba(255,255,255,0.9)" : p.muted }}>
        {text}
      </Text>
    </View>
  );
}

/** Compact one-tap copy & quote-reply pills tucked neatly under a message. */
export function MessageActions({
  onCopy,
  onQuote,
  align = "left",
}: {
  onCopy?: () => void;
  onQuote?: () => void;
  align?: "left" | "right";
}) {
  const p = usePalette();
  if (!onCopy && !onQuote) return null;
  const chip = (icon: "content-copy" | "reply-outline", label: string, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 3,
        paddingHorizontal: 6,
        minHeight: 22,
        borderRadius: radius.pill,
        backgroundColor: pressed ? p.surface2 : "transparent",
      })}
    >
      <MaterialCommunityIcons name={icon} size={12} color={p.faint} />
      <Text style={{ fontSize: 11, color: p.muted, fontFamily: fonts.bodySemi }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: align === "right" ? "flex-end" : "flex-start", gap: 6 }}>
      {onCopy ? chip("content-copy", "复制", onCopy) : null}
      {onQuote ? chip("reply-outline", "引用", onQuote) : null}
    </View>
  );
}

/** Preview chip seated above the composer input while replying to a quoted message. */
export function QuoteComposerBanner({ quote, onClear, inset = true }: { quote: ReplyQuote; onClear: () => void; inset?: boolean }) {
  const p = usePalette();
  return (
    <View
      style={{
        marginHorizontal: inset ? space.lg : 0,
        marginBottom: inset ? space.xs : 0,
        paddingLeft: space.md,
        paddingRight: space.xs,
        paddingVertical: 6,
        borderRadius: radius.md,
        backgroundColor: p.surface2,
        borderLeftWidth: 3,
        borderLeftColor: p.accentText,
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
      }}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 11.5, fontFamily: fonts.bodyBold, color: p.accentText }}>
          {`引用 · ${quote.author}`}
        </Text>
        <Text numberOfLines={2} style={{ fontSize: 12.5, lineHeight: 17, color: p.muted }}>
          {previewQuoteText(quote.text)}
        </Text>
      </View>
      <Pressable
        onPress={onClear}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="取消引用"
        style={({ pressed }) => ({
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? p.surface3 : "transparent",
        })}
      >
        <MaterialCommunityIcons name="close" size={16} color={p.muted} />
      </Pressable>
    </View>
  );
}
