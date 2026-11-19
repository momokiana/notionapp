# 星海手写 · Xiaoai Starlight Hand

本字体是 [悠哉字体 Yozai Medium v0.868](https://github.com/lxgw/yozai-font/releases/tag/v0.868) 的轻量显示子集，保持可用字形不重绘；替换了发行/内部家族名和 PostScript 名。保留作者与授权，使用 [SIL Open Font License 1.1](<XiaoaiStarlightHand-OFL.txt>)；该授权仅适用于字体，不重新授权 App 源码或图片，也不代表原作者为此版本背书。

- 固定上游 `Yozai-Medium.ttf` SHA-256：`05f50f252b45197d0d6148a4abc3e37c7cd4cfdf03c955b57c25d53d924f835f`（[GitHub 版次记录](https://api.github.com/repos/lxgw/yozai-font/releases/246692462)）。
- [产物](<XiaoaiStarlightHand.ttf>) SHA-256：`f0fa4ae1a7b99dd62e2f5348ce814a14a380c964ac7eb2377f56ffd7cbdbd601`，4,004,636 字节。覆盖 GB2312 的 6763 个汉字，另有界面标点、数字和拉丁字母等，总计 7730 个 Unicode 码点映射。
- 可通过 [`subset-starlight-font.py`](<../../../../scripts/subset-starlight-font.py>) 和 FontTools 4.60.1 从对应发行版复现。APK 里的字体是 Android 本地资源，授权全文随包封装，无需联网加载。
- 用于标题、欢迎语、选项卡和主要按钮。长聊天正文、终端、命令和配对码保留清晰的原有正文或等宽字体。
