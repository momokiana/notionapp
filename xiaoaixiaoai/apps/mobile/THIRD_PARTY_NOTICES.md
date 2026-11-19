# Third-party notices: Android app

The 小爱小爱 Android app is licensed under AGPL-3.0-only (see `LICENSE` at the repository root). This file covers material in the app that comes from elsewhere and carries its own licence. npm dependencies keep the licences declared in their own packages.

## Harness brand glyphs (`src/lib/harnessIcons.ts`)

Small monochrome marks drawn in an agent's avatar circle when the app has no sticker for that harness. `scripts/harness-icons.mjs` generates the file from the harness icon sprite of [Uniflo](https://github.com/Crosery/uniflo) (MIT), which took the marks from the sources below. Changes from the originals: only path geometry is kept (`d`, `fill-rule`, `clip-rule`, `opacity`, `transform`), recoloured to a single fill and fitted to a 24x24 canvas.

Trademarks belong to their owners. A glyph only identifies the harness it stands for. It does not mean the product or its owner is affiliated with, or endorses, 小爱小爱.

| Glyphs | Source | Licence |
|---|---|---|
| antigravity, claude, cline, codebuddy, codex, commandcode, copilot, cursor, devin, dsh (DeepSeek), gemini, grok, hermes, kilo, kimi, kiro, mimocode (Xiaomi MiMo), minimax, opencode, openclaw, pi, qoder, qwen, roo, zcode (Z.ai) | [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons), npm `@lobehub/icons-static-svg` 1.95.1, monochrome variants | MIT, Copyright (c) 2023 LobeHub |
| omp | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) `assets/icon.svg`. Decorative dots removed, rounded corners squared, plug slots cut as holes | MIT, Copyright (c) 2025 Mario Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. |
| reasonix | [esengine/DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) `desktop/electron/assets/icon.svg`. Rounded backplate and gradient removed, keeping the R, the whale and its eye | MIT, Copyright (c) 2026 Reasonix Contributors |

Other harnesses get no bundled mark. Examples: workbuddy and factory, whose marks Uniflo copies from the vendors' websites without a licence, and craft, whose sprite symbol is only a filled square. For these the app shows a letter. If the computer's own Uniflo has a mark, the app asks for it at runtime (`harness.icons`, `src/lib/harnessRemote.ts`) and draws that instead. Those marks are never part of the app package.

### lobe-icons

```text
MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### oh-my-pi

```text
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### DeepSeek-Reasonix

```text
MIT License

Copyright (c) 2026 Reasonix Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
