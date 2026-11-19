#!/usr/bin/env python3
"""Reproduce the OFL-licensed Xiaoai Starlight Hand display font with FontTools 4.60.1.

Fetch exactly Yozai Medium v0.868 (URL in the app font notice), then run:
  python3 scripts/subset-starlight-font.py Yozai-Medium.ttf path/to/XiaoaiStarlightHand.ttf
"""
import hashlib
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

RELEASE_SHA = "05f50f252b45197d0d6148a4abc3e37c7cd4cfdf03c955b57c25d53d924f835f"
FAMILY = "Xiaoai Starlight Hand"
POSTSCRIPT = "XiaoaiStarlightHand"
ESSENTIAL = set("小爱弥斯海星蓝粉助理设置欢迎配对设备你好早安午晚提醒后聊天连接重新历史时间今天星期文字更新文件状态准备开始。？0123456789Agents…·—→")


def gb2312():
    points = set()
    for first in range(0xa1, 0xf8):
        for second in range(0xa1, 0xff):
            try:
                points.add(ord(bytes((first, second)).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    return points


def make_font(source: Path, output: Path):
    if output.exists():
        raise ValueError(f"Use a fresh output path: {output.name}")
    if hashlib.sha256(source.read_bytes()).hexdigest() != RELEASE_SHA:
        raise ValueError("Unexpected upstream Yozai Medium file")
    with TTFont(source, recalcTimestamp=False) as font:
        gb = gb2312()
        cmap = font.getBestCmap()
        # Require the full GB2312 Hanzi repertoire; include non-Hanzi symbols
        # wherever the upstream font actually has them (e.g. not U+02C9).
        required = {c for c in gb if 0x4e00 <= c <= 0x9fff} | set(map(ord, ESSENTIAL))
        missing = required.difference(cmap)
        if missing:
            raise ValueError("Missing source glyphs: " + " ".join(f"U+{c:X}" for c in sorted(missing)))
        requested = gb | required | set(range(0x20, 0x100)) | set(range(0x2000, 0x2070)) | set(range(0xff00, 0xffef))
        opts = subset.Options()
        opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 16, 17]
        opts.name_legacy = True
        opts.name_languages = ["*"]
        opts.recalc_timestamp = False
        job = subset.Subsetter(options=opts)
        job.populate(unicodes=requested.intersection(cmap))
        job.subset(font)
        names = font["name"]
        # This is a modified font. Replace family, full and PostScript names,
        # retaining the upstream copyright, contributors and license metadata.
        custom = {1: FAMILY, 2: "Regular", 3: POSTSCRIPT + "-v0.868-subset1", 4: FAMILY,
                  6: POSTSCRIPT, 16: FAMILY, 17: "Regular"}
        for name_id in custom:
            names.removeNames(nameID=name_id)
        for name_id, value in custom.items():
            names.setName(value, name_id, 3, 1, 0x0409)
            names.setName(value, name_id, 1, 0, 0)
        font.save(output, reorderTables=False)
    with TTFont(output) as check:
        kept = check.getBestCmap()
        assert required.issubset(kept)
        assert check["name"].getDebugName(1) == FAMILY and check["name"].getDebugName(6) == POSTSCRIPT
        assert "LXGW" in (check["name"].getDebugName(0) or "")
        print(f"{len(kept)} Unicode mappings; GB2312 and App title samples covered; {output.stat().st_size} bytes.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Expected original font and output font paths")
    make_font(Path(sys.argv[1]), Path(sys.argv[2]))
