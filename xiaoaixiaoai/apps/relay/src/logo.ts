// Inline only the compact user-selected portrait: pairing pages need no remote image request.
// Artwork rights remain separate from the code license; see ../assets/USER-ARTWORK.md.
import { readFileSync } from "node:fs";

const portrait = readFileSync(new URL("../assets/aimisi-avatar.jpg", import.meta.url)).toString("base64");
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="爱弥斯头像"><image width="256" height="256" href="data:image/jpeg;base64,${portrait}"/></svg>`;
