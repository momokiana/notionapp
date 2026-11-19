/** Starlight: ice blue, cherry pink, a hint of lilac and deep slate ink. */
export const brand = {
  pink: "#F3AFD0",
  blush: "#F9C8DF",
  sky: "#93D6F5",
  lavender: "#C5B8F1",
  plum: "#30344E",
} as const;

export interface Palette {
  dark: boolean;
  pageTop: string;
  pageBottom: string;
  page: string;
  surface: string;
  surface2: string;
  surface3: string;
  ink: string;
  muted: string;
  faint: string;
  divider: string;
  outline: string;
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  accentText: string;
  accentContainer: string;
  sky: string;
  skyText: string;
  skyContainer: string;
  lavender: string;
  lavenderContainer: string;
  onLavender: string;
  bubble: string;
  reply: string;
  glass: string;
  shadow: string;
  error: string;
  errorContainer: string;
  dusk: string;
  duskContainer: string;
}

const light: Palette = {
  dark: false,
  pageTop: "#E5F5FF",
  page: "#F5F6FE",
  pageBottom: "#FDEAF4",
  surface: "#FFFFFF",
  surface2: "#F6FAFF",
  surface3: "#EDF3FA",
  ink: brand.plum,
  muted: "#565E77",
  faint: "#606984",
  divider: "#DBE6F3",
  outline: "#7989A4",
  primary: brand.pink,
  primaryPressed: "#ED9EC4",
  onPrimary: "#43253E",
  accentText: "#87305A",
  accentContainer: "#FBE3F0",
  sky: brand.sky,
  skyText: "#255C83",
  skyContainer: "#DDF2FF",
  lavender: brand.lavender,
  lavenderContainer: "#EFE9FC",
  onLavender: brand.plum,
  bubble: "#FBE3F0",
  reply: "#EAF7FF",
  glass: "#FFFFFF",
  shadow: "#7597BC",
  error: "#A32648",
  errorContainer: "#FFE6EB",
  dusk: "#6045A2",
  duskContainer: "#F0EAFC",
};

const night: Palette = {
  dark: true,
  pageTop: "#111F33",
  page: "#1B2236",
  pageBottom: "#2C2034",
  surface: "#222D43",
  surface2: "#27344C",
  surface3: "#303D58",
  ink: "#F4F4FC",
  muted: "#CCD5EC",
  faint: "#A9B8D7",
  divider: "#394862",
  outline: "#889CBB",
  primary: "#F4A8CC",
  primaryPressed: "#FAC2DD",
  onPrimary: "#38223B",
  accentText: "#FAC0DD",
  accentContainer: "#482D46",
  sky: "#7ECFF6",
  skyText: "#BCE8FF",
  skyContainer: "#254459",
  lavender: "#CABDF6",
  lavenderContainer: "#373553",
  onLavender: "#F4F4FC",
  bubble: "#462D46",
  reply: "#263E54",
  glass: "#222D43",
  shadow: "#0D1424",
  error: "#FFABBA",
  errorContainer: "#492832",
  dusk: "#D2C4FD",
  duskContainer: "#383451",
};

export function makePalette(dark: boolean): Palette {
  return dark ? night : light;
}
