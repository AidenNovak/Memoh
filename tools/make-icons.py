#!/usr/bin/env python3
"""从 Memoh 的 logo.svg 生成 iOS app 图标与启动图。

## 为什么需要它

原来的 `assets/images/icon.png` 是 **Expo 默认模板的蓝色图标**（`#349AFB`）——
和 Memoh 一点关系都没有。桌面端的品牌色是紫色（`#bd69ff` / `#7948ff`），
图标不对齐的话，"对齐品牌"这件事在用户第一眼看到的地方就落空了。

## 为什么保留这个脚本

图标是**生成物**。直接放一张 PNG 进仓库，下次要改尺寸/底色/留白时就得重新找工具、
重新对 logo 比例。脚本让这件事可复现，也把"为什么这么排版"写下来。

## 一个坑

`qlmanage` 渲染 SVG 时**带不透明白底**（不是透明通道）。所以：

- 需要透明的地方（启动图、品牌标记）必须**把白底抠掉**——见 `key_out_white()`；
- 需要底色的地方（app 图标）无所谓，直接画在底色上即可。

用"抠白"而不是"换个渲染器"，是因为这台机器上只有 qlmanage 能渲染 SVG
（rsvg-convert / cairosvg / inkscape 都没装），而装一个只为生成图标不值得。
抠白对这份 logo 是安全的：它本身不含白色（只有 #7948FF 与 #BD69FF 两色）。

用法：
    python3 tools/make-icons.py            # 生成到 assets/images/
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = Path.home() / 'projects/reference/memoh/apps/web/public/logo.svg'
OUT = ROOT / 'apps/mobile/assets/images'

# Memoh 的品牌紫（取自 logo.svg）。核对它们没变——变了说明上游换了 logo。
EXPECTED_BRAND = {'#7948FF', '#BD69FF'}

# Memoh 的浅色页面底。图标用它而不是纯白——与 App 内页面同色，
# 图标和界面在心理上才是同一个产品。
LIGHT_BACKGROUND = (250, 248, 247, 255)


def render_logo(size):
    """用 macOS 的 Quick Look 把 SVG 渲染成 PNG（不需要额外依赖）。"""
    with tempfile.TemporaryDirectory() as temporary:
        subprocess.run(
            ['qlmanage', '-t', '-s', str(size), '-o', temporary, str(LOGO)],
            check=True, capture_output=True,
        )
        produced = next(Path(temporary).glob('*.png'))
        return Image.open(produced).convert('RGBA')


def key_out_white(image, threshold=245):
    """把近白像素变透明。

    qlmanage 给的是白底，而 logo 本身不含白色，所以"接近白"就等于"背景"。
    用阈值而不是精确匹配：抗锯齿会在边缘产生介于白与紫之间的像素，精确匹配会留下白边。
    """
    array = np.asarray(image).copy()
    rgb = array[:, :, :3].astype(int)
    is_white = rgb.min(axis=2) >= threshold
    array[is_white, 3] = 0
    return Image.fromarray(array, 'RGBA')


def trim(image):
    bounds = image.getbbox()
    return image.crop(bounds) if bounds else image


def check_brand_colors(image):
    """确认渲染出来的确实是 Memoh 的品牌紫。

    先排除近白像素再统计——渲染出来的是白底 + 紫色 logo，
    直接取"出现最多的颜色"永远会得到白色，那样这个检查就是空转。
    """
    array = np.asarray(image).reshape(-1, 4)
    opaque = array[array[:, 3] > 200]
    if opaque.size == 0:
        return
    colored = opaque[opaque[:, :3].min(axis=1) < 240]
    if colored.size == 0:
        print('  提示：渲染结果里没有非白像素，logo 可能没有画出来。', file=sys.stderr)
        return
    colors, counts = np.unique(colored[:, :3], axis=0, return_counts=True)
    hex_value = '#%02X%02X%02X' % tuple(int(v) for v in colors[counts.argmax()])
    if hex_value not in EXPECTED_BRAND:
        print(
            f'  提示：主色是 {hex_value}，不在预期的品牌色 {sorted(EXPECTED_BRAND)} 里。'
            f'上游可能换了 logo，值得确认。',
            file=sys.stderr,
        )


def place(logo, size, background, ratio=0.72):
    """把 logo 居中放进正方形画布，四周留白。

    `ratio` 约束的是**较长的那一边**（这份 logo 宽大于高，1024×902）。

    取 0.72 而不是 Apple 网格常说的 0.62–0.70：这份 logo 宽高比是 1.14，按宽度算
    0.62 时高度只剩 55%，在小尺寸下视觉重量明显偏轻。0.72 让内容占到 72% 宽 ×
    63% 高，与常见图标标记的观感一致，同时左右各留 14% 安全边距——
    水母最宽处在竖直中段，不会被 iOS 的圆角遮罩切到。
    """
    canvas = Image.new('RGBA', (size, size), background)
    graphic = trim(logo.copy())
    target = int(size * ratio)
    graphic.thumbnail((target, target), Image.LANCZOS)
    canvas.alpha_composite(graphic, ((size - graphic.width) // 2, (size - graphic.height) // 2))
    return canvas


def main():
    if not LOGO.exists():
        print(f'找不到 logo：{LOGO}', file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    rendered = render_logo(1024)
    check_brand_colors(rendered)
    transparent = key_out_white(rendered)

    # app 图标：暖白底 + 水母。与桌面端的用法一致——它在 Web 上也是画在浅底上的。
    for size in (1024, 180, 120):
        name = 'icon.png' if size == 1024 else f'icon-{size}.png'
        place(transparent, size, LIGHT_BACKGROUND).convert('RGB').save(OUT / name)
        print(f'  {name} ({size}×{size})')

    # 启动图：透明底，只放 logo。它画在启动屏背景色上，自带底色会与背景错位。
    splash = trim(transparent.copy())
    splash.thumbnail((1024, 1024), Image.LANCZOS)
    splash.save(OUT / 'splash-icon.png')
    print(f'  splash-icon.png ({splash.width}×{splash.height}, 透明底)')

    # 方形品牌标记（透明底 + 四周留白）：给登录页、Debug 页用。
    place(transparent, 512, (0, 0, 0, 0)).save(OUT / 'brand-mark.png')
    print('  brand-mark.png (512×512, 透明底)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
