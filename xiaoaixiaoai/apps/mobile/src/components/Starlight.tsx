import { View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import { usePalette } from "../theme/theme";
import { Mascot, type MascotMood } from "./Mascot";

const STAR = "M0 -8 Q1.3 -1.3 8 0 Q1.3 1.3 0 8 Q-1.3 1.3 -8 0 Q-1.3 -1.3 0 -8Z";

/** Static original vector ornament. Its wrapper must sit behind content. */
export function StarTrail({ width = 156, opacity = 0.58 }: { width?: number; opacity?: number }) {
  const p = usePalette();
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ opacity }}>
      <Svg width={width} height={width * 0.625} viewBox="0 0 160 100">
        <Path d="M4 55 C47 35 84 77 160 13" stroke={p.sky} strokeWidth={1.6} fill="none" strokeLinecap="round" />
        <Path d="M30 78 C80 71 102 52 159 36" stroke={p.primary} strokeWidth={1.6} fill="none" strokeLinecap="round" />
        <Path d={STAR} transform="translate(116 22)" fill={p.skyText} />
        <Path d={STAR} transform="translate(69 69) scale(.64)" fill={p.primary} />
        <Circle cx={138} cy={60} r={2.8} fill={p.lavender} />
        <Circle cx={40} cy={35} r={2.4} fill={p.sky} />
      </Svg>
    </View>
  );
}

/** The existing portrait in a pearl-edged frame with a small blue and pink orbit. */
export function StarlightPortrait({ size = 112, mood = "hello" }: { size?: number; mood?: MascotMood }) {
  const p = usePalette();
  const dimension = size + 36;
  return (
    <View style={{ width: dimension, height: dimension, alignItems: "center", justifyContent: "center" }}>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", inset: 0 }}>
        <Svg width={dimension} height={dimension} viewBox="0 0 160 160">
          <Ellipse cx={80} cy={80} rx={79} ry={34} rotation={-24} originX={80} originY={80} stroke={p.sky} strokeWidth={1.3} fill="none" />
          <Ellipse cx={80} cy={82} rx={77} ry={38} rotation={22} originX={80} originY={82} stroke={p.primary} strokeWidth={1.1} fill="none" />
        </Svg>
      </View>
      <LinearGradient colors={[p.sky, p.lavender, p.primary]} start={{ x: 0.1, y: 0.1 }} end={{ x: 0.9, y: 0.9 }} style={{ padding: 3, borderRadius: dimension / 2 }}>
        <View style={{ padding: 3, borderRadius: dimension / 2, backgroundColor: p.surface }}>
          <Mascot size={size} mood={mood} />
        </View>
      </LinearGradient>
      <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", inset: 0 }}>
        <Svg width={dimension} height={dimension} viewBox="0 0 160 160">
          <Path d={STAR} transform="translate(140 39) scale(1.1)" fill={p.skyText} />
          <Path d={STAR} transform="translate(18 116) scale(.85)" fill={p.accentText} />
          <Circle cx={151} cy={52} r={2.8} fill={p.lavender} />
        </Svg>
      </View>
    </View>
  );
}
