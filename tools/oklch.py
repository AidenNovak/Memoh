#!/usr/bin/env python3
"""把 Memoh 桌面端的 oklch 设计 token 转成 RN 能用的 sRGB hex。

## 为什么要转

桌面端（`@felinic/ui` 的 `style.css`）用 OKLCH 定义颜色，因为那是给浏览器用的
（支持相对颜色语法、感知均匀调色）。React Native **不认识 oklch**，只吃 `#RRGGBB`。

所以必须转，而且必须**转准**——否则 iOS 上的紫色和 Web 上的紫色不是同一个紫，
"对齐品牌色"这件事就落空了。

## 转换链路

OKLCH → OKLab → linear sRGB → sRGB（gamma 编码）。

公式来自 Björn Ottosson 的 oklab 定义。这里不用第三方库：转换只有十几行，
而依赖越少，这个脚本越可能在别人机器上直接跑起来。

## 用法

    python3 tools/oklch.py                    # 打印 Memoh 的核心 token 表
    python3 tools/oklch.py "#bd69ff"           # 反向：hex → oklch（核对用）
"""
import math
import sys

# ---------------------------------------------------------------- oklab 数学


def oklch_to_oklab(lightness, chroma, hue_degrees):
    hue = math.radians(hue_degrees)
    return lightness, chroma * math.cos(hue), chroma * math.sin(hue)


def oklab_to_linear_srgb(lightness, a, b):
    """OKLab → 线性 sRGB（Ottosson 的矩阵）。"""
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    return (
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )


def linear_to_srgb(value):
    """线性 → gamma 编码。"""
    if value <= 0.0031308:
        return 12.92 * value
    return 1.055 * (value ** (1 / 2.4)) - 0.055


def clamp01(value):
    return max(0.0, min(1.0, value))


def oklch_to_hex(lightness, chroma, hue, alpha=1.0):
    """OKLCH → `#RRGGBB` 或 `#RRGGBBAA`。

    超出 sRGB 色域的颜色会被 clamp（而不是拒绝）：设计 token 里有些值在 sRGB 边缘，
    Web 端显示器能显示更多色域，iOS 上落在边界内是正确行为。
    """
    oklab = oklch_to_oklab(lightness, chroma, hue)
    linear = oklab_to_linear_srgb(*oklab)
    channels = [round(clamp01(linear_to_srgb(value)) * 255) for value in linear]
    hex_value = '#%02X%02X%02X' % tuple(channels)
    if alpha < 1:
        hex_value += '%02X' % round(clamp01(alpha) * 255)
    return hex_value


def hex_to_oklch(hex_value):
    """反过来：hex → oklch。用来核对转换没有跑偏。"""
    raw = hex_value.lstrip('#')
    rgb = [int(raw[i : i + 2], 16) / 255 for i in (0, 2, 4)]

    def to_linear(value):
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = (to_linear(value) for value in rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = (value ** (1 / 3) if value >= 0 else -((-value) ** (1 / 3)) for value in (l, m, s))
    lightness = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    b_ = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    chroma = math.hypot(a, b_)
    hue = math.degrees(math.atan2(b_, a)) % 360
    return lightness, chroma, hue


# ---------------------------------------------------------------- Memoh token 表
#
# 全部取自 `@felinic/ui` 的 `src/style.css`（桌面端的唯一色值源）。
# 每行标注了它在桌面端的用途，免得转换之后不知道这个值该用在哪。

MEMOH_TOKENS = {
    # ---- 浅色 ----
    'background':       (0.981, 0.0026, 63),      # 页面底：暖白，不是纯白
    'backgroundChrome': (0.975, 0.0026, 63),      # 侧栏/顶栏，比页面低一档
    'foreground':       (0.21, 0.004, 95),        # 正文：暖黑
    'card':             (1.0, 0.0, 0),            # 卡片：纯白，浮在暖白页面上
    'muted':            (0.968, 0.0, 0),          # 下沉 chip/输入框底
    'mutedForeground':  (0.52, 0.006, 95),        # 次要文字
    'accentSurface':    (0.968, 0.0, 0),          # hover 底
    'border':           (0.915, 0.0045, 72),      # 描边/分隔线
    'brand':            (0.55, 0.22, 290),        # 品牌紫：唯一强调色
    'brandForeground':  (0.985, 0.001, 286),      # 压在品牌色上的文字
    'brandSoft':        (0.96, 0.025, 290),       # 品牌色的淡底
    'brandBorder':      (0.84, 0.08, 290),        # 品牌色的描边
    'brandHover':       (0.49, 0.23, 290),        # 品牌色按下
    'destructive':      (0.577, 0.245, 27.325),   # 危险
    # 用户气泡由品牌色派生（Web 用相对颜色语法 `oklch(from var(--brand) …)`）
    'userBubble':       (0.936, 0.035, 302),      # hue = 290 + 12
    'userBubbleForeground': (0.235, 0.04, 302),

    # ---- 深色 ----
    'backgroundDark':       (0.12212, 0.0, 0),
    'foregroundDark':       (0.90, 0.0, 0),
    'cardDark':             (0.21, 0.0, 0),
    'mutedDark':            (0.26, 0.0, 0),
    'mutedForegroundDark':  (0.70, 0.0, 0),
    'borderDark':           (1.0, 0.0, 0, 0.08),   # 白色 8%
    'brandDark':            (0.72, 0.16, 290),
    'brandSoftDark':        (0.30, 0.07, 290, 0.45),
    'brandBorderDark':      (0.72, 0.16, 290, 0.35),
    'brandHoverDark':       (0.78, 0.15, 290),
    'destructiveDark':      (0.704, 0.191, 22.216),
    'userBubbleDark':       (0.40, 0.15, 297),     # hue = 290 + 7
    'chromeDark':           (0.185, 0.0, 0),       # 侧栏
}


def main(argv):
    if argv and argv[0].startswith('#'):
        lightness, chroma, hue = hex_to_oklch(argv[0])
        print(f"{argv[0]} → oklch({lightness:.4f} {chroma:.4f} {hue:.1f})")
        round_trip = oklch_to_hex(lightness, chroma, hue)
        print(f"回到 hex：{round_trip}（应与输入一致）")
        return 0

    width = max(len(name) for name in MEMOH_TOKENS)
    print(f"{'token'.ljust(width)}  oklch                          → hex")
    print('-' * (width + 40))
    for name, values in MEMOH_TOKENS.items():
        lightness, chroma, hue = values[:3]
        alpha = values[3] if len(values) > 3 else 1.0
        oklch = f'oklch({lightness} {chroma} {hue})'
        if alpha < 1:
            oklch += f' / {alpha}'
        print(f'{name.ljust(width)}  {oklch.ljust(30)} → {oklch_to_hex(*values)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
