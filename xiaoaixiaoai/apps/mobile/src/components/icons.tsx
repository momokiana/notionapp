/**
 * The app's own icons, drawn like the mascot stickers: chubby rounded strokes
 * in one ink colour with an optional soft fill, instead of thin system glyphs.
 * 24-unit grid, stroke 2.2, round caps and joins.
 */
import { memo } from "react";
import Svg, { Circle, G, Path, Rect } from "react-native-svg";

export type CuteIconName =
  | "back"
  | "send"
  | "mic"
  | "micOff"
  | "keyboard"
  | "keyboardDown"
  | "tune"
  | "hangup"
  | "chat"
  | "newChat"
  | "bell"
  | "plus"
  | "chevronRight"
  | "alert"
  | "pause"
  | "close"
  | "grid"
  | "screens"
  | "search"
  | "menu"
  | "terminal"
  | "copy"
  | "check"
  | "working"
  | "blocked"
  | "done"
  | "idle"
  | "chevronDown"
  | "captions"
  | "captionsOff"
  | "robot"
  | "laptop"
  | "gear"
  | "plane"
  | "image";

const S = { strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** A soft gear: eight rounded teeth around a ring. */
const GEAR = (() => {
  const pts: string[] = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 9 : 7.2;
    pts.push(`${(12 + r * Math.cos(a0)).toFixed(2)} ${(12 + r * Math.sin(a0)).toFixed(2)}`, `${(12 + r * Math.cos(a1)).toFixed(2)} ${(12 + r * Math.sin(a1)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
})();

function shape(name: CuteIconName, ink: string, fill: string, w: number) {
  const line = { ...S, stroke: ink, strokeWidth: w, fill: "none" };
  const body = { ...S, stroke: ink, strokeWidth: w, fill };
  switch (name) {
    case "back":
      return <Path d="M14.5 5.5 L8 12 L14.5 18.5" {...line} />;
    case "chevronDown":
      return <Path d="M6.5 9.5 L12 15 L17.5 9.5" {...line} />;
    case "chevronRight":
      return <Path d="M9.5 5.5 L16 12 L9.5 18.5" {...line} />;
    case "send":
      return (
        <G>
          <Path d="M12 19 V6.5" {...line} />
          <Path d="M6.5 11.5 L12 5.5 L17.5 11.5" {...line} />
        </G>
      );
    case "mic":
      return (
        <G>
          <Rect x={8.5} y={3.5} width={7} height={11} rx={3.5} {...body} />
          <Path d="M5.5 11.5 C5.5 15.2 8.4 17.8 12 17.8 C15.6 17.8 18.5 15.2 18.5 11.5" {...line} />
          <Path d="M12 18 V20.5" {...line} />
        </G>
      );
    case "micOff":
      return (
        <G>
          <Rect x={8.5} y={3.5} width={7} height={11} rx={3.5} {...body} />
          <Path d="M5.5 11.5 C5.5 15.2 8.4 17.8 12 17.8 C15.6 17.8 18.5 15.2 18.5 11.5" {...line} />
          <Path d="M12 18 V20.5" {...line} />
          <Path d="M4.5 4.5 L19.5 19.5" {...line} />
        </G>
      );
    case "keyboard":
      return (
        <G>
          <Rect x={3} y={6} width={18} height={12} rx={4} {...body} />
          <Path d="M7 10 h0.01 M10.3 10 h0.01 M13.7 10 h0.01 M17 10 h0.01 M9 14.2 h6" {...line} />
        </G>
      );
    case "keyboardDown":
      return (
        <G>
          <Rect x={3} y={3.5} width={18} height={11} rx={4} {...body} />
          <Path d="M7 7.5 h0.01 M10.3 7.5 h0.01 M13.7 7.5 h0.01 M17 7.5 h0.01 M9 11 h6" {...line} />
          <Path d="M9.5 18 L12 20.5 L14.5 18" {...line} />
        </G>
      );
    case "tune":
      return (
        <G>
          <Path d="M4.5 8 H19.5 M4.5 16 H19.5" {...line} />
          <Circle cx={9} cy={8} r={2.6} {...body} />
          <Circle cx={15} cy={16} r={2.6} {...body} />
        </G>
      );
    case "hangup":
      return (
        <Path
          d="M3.2 13.6 C3 12.6 3.4 11.7 4.3 11.1 C9.1 8 14.9 8 19.7 11.1 C20.6 11.7 21 12.6 20.8 13.6 L20.5 15 C20.3 15.9 19.4 16.4 18.5 16.2 L15.9 15.6 C15.2 15.4 14.7 14.8 14.7 14.1 V12.9 C12.9 12.3 11.1 12.3 9.3 12.9 V14.1 C9.3 14.8 8.8 15.4 8.1 15.6 L5.5 16.2 C4.6 16.4 3.7 15.9 3.5 15 Z"
          {...body}
        />
      );
    case "chat":
      return (
        <G>
          <Path d="M5 5.5 H19 C20.1 5.5 21 6.4 21 7.5 V15 C21 16.1 20.1 17 19 17 H11 L7 20 V17 H5 C3.9 17 3 16.1 3 15 V7.5 C3 6.4 3.9 5.5 5 5.5 Z" {...body} />
          <Path d="M8 11.3 h0.01 M12 11.3 h0.01 M16 11.3 h0.01" {...line} />
        </G>
      );
    case "bell":
      return (
        <G>
          <Path d="M6 16.5 V11 C6 7.7 8.7 5 12 5 C15.3 5 18 7.7 18 11 V16.5 L19.5 18 H4.5 Z" {...body} />
          <Path d="M10 20.5 C10.5 21.2 11.2 21.5 12 21.5 C12.8 21.5 13.5 21.2 14 20.5 M12 5 V3.5" {...line} />
        </G>
      );
    case "newChat":
      // A round speech bubble with a plus: start a new conversation.
      return (
        <G>
          <Path d="M12 3.5 C16.7 3.5 20.5 7 20.5 11.4 C20.5 15.8 16.7 19.3 12 19.3 C10.9 19.3 9.8 19.1 8.8 18.7 L4.5 20.4 L5.7 16.5 C4.3 15.1 3.5 13.3 3.5 11.4 C3.5 7 7.3 3.5 12 3.5 Z" {...body} />
          <Path d="M12 8.2 V14.6 M8.8 11.4 H15.2" {...line} />
        </G>
      );
    case "plus":
      return <Path d="M12 5.5 V18.5 M5.5 12 H18.5" {...line} />;
    case "alert":
      // A soft warning triangle: something went wrong.
      return (
        <G>
          <Path d="M10.3 4.8 C11.1 3.4 12.9 3.4 13.7 4.8 L20.6 16.8 C21.4 18.2 20.4 19.9 18.8 19.9 H5.2 C3.6 19.9 2.6 18.2 3.4 16.8 Z" {...body} />
          <Path d="M12 9.3 V13.2 M12 16.4 h0.01" {...line} />
        </G>
      );
    case "pause":
      return (
        <G>
          <Circle cx={12} cy={12} r={8.5} {...body} />
          <Path d="M10 9.3 V14.7 M14 9.3 V14.7" {...line} />
        </G>
      );
    case "close":
      return <Path d="M7 7 L17 17 M17 7 L7 17" {...line} />;
    case "grid":
      // Four soft tiles: every space.
      return (
        <G>
          <Rect x={4} y={4} width={7} height={7} rx={2.2} {...body} />
          <Rect x={13} y={4} width={7} height={7} rx={2.2} {...body} />
          <Rect x={4} y={13} width={7} height={7} rx={2.2} {...body} />
          <Rect x={13} y={13} width={7} height={7} rx={2.2} {...body} />
        </G>
      );
    case "screens":
      // Two screens, one behind the other: every computer.
      return (
        <G>
          <Path d="M7.5 6.5 V5.5 C7.5 4.4 8.4 3.5 9.5 3.5 H19 C20.1 3.5 21 4.4 21 5.5 V11.5 C21 12.6 20.1 13.5 19 13.5 H18" {...line} />
          <Rect x={3} y={7.5} width={14} height={9.5} rx={2.2} {...body} />
          <Path d="M7.5 20.5 H12.5 M10 17 V20.5" {...line} />
        </G>
      );
    case "search":
      return (
        <G>
          <Circle cx={10.5} cy={10.5} r={6} {...body} />
          <Path d="M15 15 L19.5 19.5" {...line} />
        </G>
      );
    case "menu":
      // Three even bars, like the design kit's header button.
      return <Path d="M5.5 6.5 H18.5 M5.5 12 H18.5 M5.5 17.5 H18.5" {...line} />;
    case "terminal":
      return (
        <G>
          <Rect x={3} y={4.5} width={18} height={15} rx={4} {...body} />
          <Path d="M7.5 10 L10.5 12.5 L7.5 15 M12.5 15.5 H16.5" {...line} />
        </G>
      );
    case "copy":
      return (
        <G>
          <Rect x={8.5} y={8.5} width={11} height={11} rx={3} {...body} />
          <Path d="M15.5 5.5 C15.3 4.4 14.4 3.5 13.2 3.5 H7 C5.6 3.5 4.5 4.6 4.5 6 V12.2 C4.5 13.4 5.4 14.3 6.5 14.5" {...line} />
        </G>
      );
    case "captions":
      return (
        <G>
          <Rect x={3} y={5.5} width={18} height={13} rx={4} {...body} />
          <Path d="M7 11 H11.5 M13.5 11 H17 M7 14.5 H9.5 M11.5 14.5 H17" {...line} />
        </G>
      );
    case "captionsOff":
      return (
        <G>
          <Rect x={3} y={5.5} width={18} height={13} rx={4} {...line} />
          <Path d="M7 11 H11.5 M13.5 11 H17 M7 14.5 H9.5 M11.5 14.5 H17" {...line} strokeOpacity={0.45} />
        </G>
      );
    case "robot":
      return (
        <G>
          <Rect x={4.5} y={7.5} width={15} height={12} rx={5} {...body} />
          <Path d="M12 7.5 V4.5 M2.8 12.5 V14.5 M21.2 12.5 V14.5 M9.3 13 h0.01 M14.7 13 h0.01 M10.3 16.3 C11.3 17 12.7 17 13.7 16.3" {...line} />
          <Circle cx={12} cy={3.6} r={1.1} fill={ink} />
        </G>
      );
    case "laptop":
      return (
        <G>
          <Rect x={4.5} y={5} width={15} height={10.5} rx={2.5} {...body} />
          <Path d="M2.5 18.5 H21.5" {...line} />
        </G>
      );
    case "gear":
      return (
        <G>
          <Path d={GEAR} {...body} />
          <Circle cx={12} cy={12} r={2.8} {...line} />
        </G>
      );
    case "plane":
      return <Path d="M20.5 3.8 L3.8 10.6 L10.4 13.4 L13.2 20.2 Z M10.4 13.4 L20.5 3.8" {...body} />;
    case "image":
      // A little photo: a sun over a soft hill, for attaching pictures.
      return (
        <G>
          <Rect x={3.5} y={4.5} width={17} height={15} rx={4} {...body} />
          <Circle cx={9} cy={9.6} r={1.7} {...line} />
          <Path d="M4.5 17.5 L9.6 13.2 C10.3 12.6 11.3 12.6 12 13.2 L14 15 L15.6 13.6 C16.3 13 17.3 13 18 13.6 L20 15.4" {...line} />
        </G>
      );
    case "check":
      return <Path d="M5.5 12.5 L10 17 L18.5 7.5" {...line} />;
    case "working":
      // A four-point sparkle: something being made.
      return (
        <G>
          <Path d="M12 3 C12.8 8.4 13.6 9.6 19 11 C13.6 12.4 12.8 13.6 12 19 C11.2 13.6 10.4 12.4 5 11 C10.4 9.6 11.2 8.4 12 3 Z" {...body} />
          <Path d="M18.5 17.5 h0.01 M5.5 18.5 h0.01" {...line} />
        </G>
      );
    case "blocked":
      // A raised hand: it is waiting for you.
      return (
        <Path
          d="M8 12.5 V6.5 C8 5.7 8.7 5 9.5 5 C10.3 5 11 5.7 11 6.5 V11 V5 C11 4.2 11.7 3.5 12.5 3.5 C13.3 3.5 14 4.2 14 5 V11 V6 C14 5.2 14.7 4.5 15.5 4.5 C16.3 4.5 17 5.2 17 6 V14 C17 18 14.8 20.5 11.5 20.5 C9.4 20.5 8 19.6 6.9 17.9 L4.9 14.7 C4.4 13.9 4.7 12.9 5.5 12.5 C6.3 12.1 7.2 12.4 7.6 13.1 L8 13.8"
          {...body}
        />
      );
    case "done":
      return (
        <G>
          <Circle cx={12} cy={12} r={8.5} {...body} />
          <Path d="M8.3 12.3 L11 15 L15.9 9.4" {...line} />
        </G>
      );
    case "idle":
      // A sleepy moon.
      return (
        <G>
          <Path d="M18.5 14.6 C17.6 14.9 16.7 15 15.8 15 C11.4 15 7.9 11.5 7.9 7.1 C7.9 6.2 8 5.3 8.3 4.5 C5.2 5.6 3 8.6 3 12 C3 16.4 6.6 20 11 20 C14.4 20 17.4 17.8 18.5 14.6 Z" {...body} />
          <Path d="M14.5 5 H17.5 L14.5 8.5 H17.5" {...line} />
        </G>
      );
  }
}

/** One icon. `fill` is the soft inner colour for duotone shapes; "none" keeps them outline-only. */
export const CuteIcon = memo(function CuteIcon({ name, size = 22, color, fill = "none", strokeWidth = 2.2 }: { name: CuteIconName; size?: number; color: string; fill?: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {shape(name, color, fill, strokeWidth)}
    </Svg>
  );
});
