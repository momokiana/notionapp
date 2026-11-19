"""Subset the site fonts to the glyphs the site and video actually use.

Run from apps/site:  python3 -I scripts/subset-fonts.py
Sources: Nunito and ZCOOL KuaiLe from the mobile app's @expo-google-fonts
packages (run `pnpm install` in apps/mobile first), Maple Mono from
apps/mobile/assets/fonts. Output: src/fonts/*.woff2 (all SIL OFL 1.1).
"""

import glob
import os
import pathlib
import subprocess
import sys

here = pathlib.Path(__file__).resolve().parent.parent
mobile = here.parent / "mobile"
gfonts = mobile / "node_modules" / "@expo-google-fonts"
out = here / "src" / "fonts"
out.mkdir(parents=True, exist_ok=True)

texts = []
for pattern in ("index.html", "src/**/*.ts", "video/src/**/*.tsx", "video/src/**/*.ts"):
    for p in glob.glob(str(here / pattern), recursive=True):
        texts.append(pathlib.Path(p).read_text(encoding="utf-8"))
alltext = "".join(texts)
cjk = sorted({c for c in alltext if ord(c) > 0x2E7F})

latin = "U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2190-2193,U+2122,U+00B7"
mono = latin + ",U+2500-257F,U+2580-259F,U+2713,U+2717,U+25B8,U+276F,U+2026"


def subset(src, dst, unicodes=None, text=None):
    cmd = [
        sys.executable,
        "-m",
        "fontTools.subset",
        str(src),
        f"--output-file={dst}",
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
    ]
    if unicodes:
        cmd.append(f"--unicodes={unicodes}")
    if text:
        tf = out / ".chars.txt"
        tf.write_text(text, encoding="utf-8")
        cmd.append(f"--text-file={tf}")
    subprocess.run(cmd, check=True)
    print(f"{dst.name}: {os.path.getsize(dst) // 1024} KB")


for w, name in (
    ("400Regular", "nunito-400"),
    ("700Bold", "nunito-700"),
    ("900Black", "nunito-900"),
):
    subset(
        gfonts / "nunito" / w / f"Nunito_{w}.ttf", out / f"{name}.woff2", unicodes=latin
    )

zcool_text = "".join(cjk) + "".join(chr(c) for c in range(0x20, 0x7F))
subset(
    gfonts / "zcool-kuaile" / "400Regular" / "ZCOOLKuaiLe_400Regular.ttf",
    out / "zcool-kuaile.woff2",
    text=zcool_text,
)
(out / ".chars.txt").unlink(missing_ok=True)

for w in ("Regular", "Bold"):
    subset(
        mobile / "assets" / "fonts" / f"MapleMono-{w}.ttf",
        out / f"maple-mono-{'400' if w == 'Regular' else '700'}.woff2",
        unicodes=mono,
    )

print(f"CJK glyphs: {len(cjk)}")
