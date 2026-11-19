import { useEffect, useRef, useState } from "react";
import { BackHandler, PanResponder, Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import * as Haptics from "expo-haptics";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useSettings } from "../lib/store";
import { clampPadRow, PAD_PAGES, PAD_SNIPPETS, padChar, padSpecial, type PadKey } from "../lib/termpad";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

const GAP = 4;
const ROWS = 5;

/**
 * The phone's own keyboard for the terminal: about two thirds of the system
 * keyboard's height (drag the handle to change it), so the terminal stays in
 * view. Keys go out as bytes through `onSend`; "中文键盘" hands over to the
 * system input method for Chinese. Back closes it.
 */
export function TermKeyboard({ onSend, onSystem, onClose }: { onSend: (data: string) => void; onSystem: () => void; onClose: () => void }) {
  const p = usePalette();
  const row = clampPadRow(useSettings((x) => x.termPadRow));
  const setRow = (v: number) => useSettings.getState().set({ termPadRow: clampPadRow(v) });
  const [page, setPage] = useState<"letters" | "symbols">("letters");
  const [shift, setShift] = useState<"off" | "once" | "lock">("off");
  const [ctrl, setCtrl] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const size = drag ?? row;
  const repeat = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);
  useEffect(() => {
    const timer = repeat;
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  // Drag up for taller keys, down for shorter; saved when let go.
  const [pan] = useState(() => {
    let from = 0;
    let last = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        from = clampPadRow(useSettings.getState().termPadRow);
        last = from;
        setDrag(from);
      },
      onPanResponderMove: (_e, g) => {
        last = clampPadRow(from - g.dy / ROWS);
        setDrag(last);
      },
      onPanResponderRelease: () => {
        setDrag(null);
        useSettings.getState().set({ termPadRow: last });
      },
      onPanResponderTerminate: () => {
        setDrag(null);
        useSettings.getState().set({ termPadRow: last });
      },
    });
  });

  function stopRepeat() {
    if (repeat.current) clearInterval(repeat.current);
    repeat.current = null;
  }

  function tap() {
    Haptics.selectionAsync().catch(() => undefined);
  }

  /** Sends what the key types and drops the one-shot modifiers. */
  function hit(k: PadKey) {
    tap();
    if (k.kind === "shift") return setShift((s) => (s === "off" ? "once" : s === "once" ? "lock" : "off"));
    if (k.kind === "ctrl") return setCtrl((v) => !v);
    if (k.kind === "page") return setPage((x) => (x === "letters" ? "symbols" : "letters"));
    const mods = { ctrl, shift: shift !== "off" };
    onSend(k.kind === "char" ? padChar(k.ch, mods) : padSpecial(k.key, mods));
    setCtrl(false);
    if (shift === "once") setShift("off");
  }

  const font = Math.round(Math.min(17, Math.max(12.5, size * 0.44)));
  const keyBorder = p.dark ? p.surface3 : "#F6DDE8";

  function renderKey(k: PadKey, i: number) {
    let label: string;
    let icon: string | undefined;
    let a11y: string;
    let on = false;
    let mono = false;
    if (k.kind === "char") {
      const up = shift !== "off" && page === "letters";
      label = k.ch === " " ? "空格" : up ? k.ch.toUpperCase() : k.ch;
      a11y = k.ch === " " ? "空格" : up ? `大写 ${k.ch}` : k.ch;
      mono = k.ch !== " ";
    } else if (k.kind === "special") {
      label = k.label;
      icon = k.icon;
      a11y = k.a11y;
      mono = /^[A-Za-z]/.test(k.label);
    } else if (k.kind === "shift") {
      label = "Shift";
      icon = shift === "lock" ? "apple-keyboard-caps" : "apple-keyboard-shift";
      a11y = shift === "off" ? "Shift，下一个字母大写" : shift === "once" ? "Shift 已按下，再按一次锁定大写" : "大写已锁定，再按一次取消";
      on = shift !== "off";
    } else if (k.kind === "ctrl") {
      label = "Ctrl";
      a11y = ctrl ? "Ctrl 已按下，再按下一个键，比如 C" : "Ctrl，和下一个键一起按";
      on = ctrl;
      mono = true;
    } else {
      label = page === "letters" ? "符" : "ABC";
      a11y = page === "letters" ? "换到符号和方向键" : "换回字母";
    }
    const strong = shift === "lock" && k.kind === "shift";
    const held = k.kind === "special" && k.repeat ? k.key : null;
    return (
      <Pressable
        key={i}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={on ? { selected: true } : undefined}
        onPress={() => hit(k)}
        delayLongPress={350}
        onLongPress={
          held
            ? () => {
                stopRepeat();
                repeat.current = setInterval(() => onSend(padSpecial(held, {})), 70);
              }
            : undefined
        }
        onPressOut={held ? stopRepeat : undefined}
        style={({ pressed }) => ({
          flex: k.w ?? 1,
          height: size,
          borderRadius: radius.xs,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: on ? p.primary : keyBorder,
          backgroundColor: strong ? p.primary : pressed || on ? p.accentContainer : k.kind === "char" ? p.surface : p.surface2,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        {icon ? (
          <MaterialCommunityIcons name={icon as never} size={font + 3} color={strong ? p.onPrimary : on ? p.accentText : p.ink} />
        ) : (
          <Text style={{ fontFamily: mono ? fonts.mono : fonts.bodySemi, fontSize: label.length > 2 ? font - 2.5 : font, color: on ? p.accentText : p.ink }}>{label}</Text>
        )}
      </Pressable>
    );
  }

  return (
    <View
      style={{
        marginTop: space.xs,
        paddingHorizontal: space.sm,
        paddingTop: 2,
        paddingBottom: space.xs,
        gap: GAP,
        borderTopLeftRadius: radius.md,
        borderTopRightRadius: radius.md,
        backgroundColor: p.dark ? p.surface2 : "#FFF4F8",
        borderTopWidth: 1,
        borderColor: keyBorder,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, height: 30 }}>
        <View
          {...pan.panHandlers}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="键盘高度，上下拖动调整"
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(e) => setRow(row + (e.nativeEvent.actionName === "increment" ? 3 : -3))}
          hitSlop={6}
          style={{ width: 34, height: 30, borderRadius: radius.xs, alignItems: "center", justifyContent: "center", backgroundColor: drag != null ? p.accentContainer : "transparent" }}
        >
          <MaterialCommunityIcons name="drag-horizontal-variant" size={20} color={drag != null ? p.accentText : p.faint} />
        </View>
        <ScrollView horizontal style={{ flex: 1 }} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, alignItems: "center" }}>
          {PAD_SNIPPETS.map((s) => (
            <Pressable
              key={s}
              accessibilityRole="button"
              accessibilityLabel={`输入 ${s}`}
              onPress={() => {
                tap();
                onSend(s);
                setCtrl(false);
                if (shift === "once") setShift("off");
              }}
              style={({ pressed }) => ({
                height: 28,
                paddingHorizontal: 11,
                borderRadius: radius.pill,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: keyBorder,
                backgroundColor: pressed ? p.accentContainer : p.surface,
              })}
            >
              <Text style={{ fontFamily: /^[\x20-\x7e]+$/.test(s) ? fonts.mono : fonts.bodySemi, fontSize: 12.5, color: p.ink }}>{s}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="换成系统键盘，可以打中文"
          onPress={() => {
            tap();
            onSystem();
          }}
          style={({ pressed }) => ({
            height: 28,
            paddingHorizontal: 11,
            borderRadius: radius.pill,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            backgroundColor: pressed ? p.primaryPressed : p.accentContainer,
          })}
        >
          <MaterialCommunityIcons name="translate" size={15} color={p.accentText} />
          <Text style={{ fontFamily: fonts.bodySemi, fontSize: 12.5, color: p.accentText }}>中文键盘</Text>
        </Pressable>
      </View>
      {PAD_PAGES[page].map((keys, r) => (
        <View key={`${page}${r}`} style={{ flexDirection: "row", gap: GAP }}>
          {keys.map(renderKey)}
        </View>
      ))}
    </View>
  );
}
