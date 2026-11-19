import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import * as SystemUI from "expo-system-ui";
import { useColorScheme } from "react-native";
import { MD3DarkTheme, MD3LightTheme, PaperProvider, type MD3Theme } from "react-native-paper";
import type { MD3Type } from "react-native-paper/lib/typescript/types";
import { useSettings } from "../lib/store";
import { fonts, makePalette, type Palette } from "./tokens";

const PaletteContext = createContext<Palette>(makePalette(false));

export function usePalette(): Palette {
  return useContext(PaletteContext);
}

function paperFonts(): MD3Theme["fonts"] {
  const base = MD3LightTheme.fonts;
  const scale = base as unknown as Record<string, MD3Type>;
  const f = (v: string, fontFamily: string): MD3Type => ({ ...scale[v]!, fontFamily, fontWeight: "400" });
  return {
    ...base,
    default: { ...base.default, fontFamily: fonts.body, fontWeight: "400" },
    displayLarge: f("displayLarge", fonts.cute),
    displayMedium: f("displayMedium", fonts.cute),
    displaySmall: f("displaySmall", fonts.cute),
    headlineLarge: f("headlineLarge", fonts.cute),
    headlineMedium: f("headlineMedium", fonts.cute),
    headlineSmall: f("headlineSmall", fonts.cute),
    titleLarge: f("titleLarge", fonts.cute),
    titleMedium: f("titleMedium", fonts.bodyBold),
    titleSmall: f("titleSmall", fonts.bodyBold),
    labelLarge: f("labelLarge", fonts.cute),
    labelMedium: f("labelMedium", fonts.bodySemi),
    labelSmall: f("labelSmall", fonts.bodySemi),
    bodyLarge: f("bodyLarge", fonts.body),
    bodyMedium: f("bodyMedium", fonts.body),
    bodySmall: f("bodySmall", fonts.body),
  };
}

function paperTheme(p: Palette): MD3Theme {
  const base = p.dark ? MD3DarkTheme : MD3LightTheme;
  return {
    ...base,
    dark: p.dark,
    roundness: 5,
    fonts: paperFonts(),
    colors: {
      ...base.colors,
      primary: p.primary,
      onPrimary: p.onPrimary,
      primaryContainer: p.accentContainer,
      onPrimaryContainer: p.accentText,
      secondary: p.skyText,
      onSecondary: p.dark ? p.onPrimary : p.surface,
      secondaryContainer: p.skyContainer,
      onSecondaryContainer: p.skyText,
      tertiary: p.dusk,
      onTertiary: p.dark ? p.onPrimary : p.surface,
      tertiaryContainer: p.lavenderContainer,
      onTertiaryContainer: p.dusk,
      background: p.page,
      onBackground: p.ink,
      surface: p.surface,
      onSurface: p.ink,
      surfaceVariant: p.surface2,
      onSurfaceVariant: p.muted,
      outline: p.outline,
      outlineVariant: p.divider,
      error: p.error,
      onError: p.dark ? p.onPrimary : p.surface,
      errorContainer: p.errorContainer,
      onErrorContainer: p.error,
      inverseSurface: p.ink,
      inverseOnSurface: p.surface,
      inversePrimary: makePalette(!p.dark).accentText,
      elevation: {
        level0: "transparent",
        level1: p.surface,
        level2: p.surface,
        level3: p.surface2,
        level4: p.surface2,
        level5: p.surface3,
      },
    },
  };
}

export function ThemeRoot({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const mode = useSettings((s) => s.themeMode);
  const dark = mode === "system" ? scheme === "dark" : mode === "dark";
  const palette = useMemo(() => makePalette(dark), [dark]);
  const theme = useMemo(() => paperTheme(palette), [palette]);
  useEffect(() => {
    // Window background shows behind the gesture bar on edge-to-edge Android.
    SystemUI.setBackgroundColorAsync(palette.page).catch(() => undefined);
  }, [palette.page]);
  return (
    <PaletteContext.Provider value={palette}>
      <PaperProvider theme={theme}>{children}</PaperProvider>
    </PaletteContext.Provider>
  );
}
