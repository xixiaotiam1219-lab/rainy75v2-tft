"""Bake a locally supplied Mver keyboard skin for the native 320x172 panel."""
import json
import numpy as np
from PIL import Image, ImageDraw, ImageChops
from assets import rgb565


def rle(cells):
    runs = []
    at = 0

    while at < len(cells):
        n = 1

        while n < 16 and at + n < len(cells) and cells[at + n] == cells[at]:
            n += 1

        runs.append(((n - 1) << 4) | cells[at])
        at += n

    return runs


def compress(raw):
    raw = bytes(raw)
    out = bytearray()
    at = 0

    while at < len(raw):
        flag_at = len(out)
        out.append(0)
        flags = 0

        for bit in range(8):
            if at >= len(raw):
                break

            length = 0
            distance = 0
            last = at

            for _ in range(20):
                candidate = raw.rfind(raw[at : at + 3], max(0, at - 1024), last)

                if candidate < 0 or len(raw) - at < 3:
                    break

                n = 3

                while (
                    n < 18 and at + n < len(raw) and raw[candidate + n] == raw[at + n]
                ):
                    n += 1

                if n > length:
                    length = n
                    distance = at - candidate

                last = candidate

            if length >= 3:
                d = distance - 1
                out.extend([((length - 3) << 4) | (d >> 8), d & 255])
                at += length

            else:
                flags |= 1 << bit
                out.append(raw[at])
                at += 1

        out[flag_at] = flags

    return out


def render(model, desk_image, out):
    p = model / "img/standard"
    q = model / "img/keyboard"

    def rgba(path):
        with Image.open(path) as image:
            if image.size != (612, 354):
                raise ValueError(f"Expected 612x354: {path.name}")
            return image.convert("RGBA")

    cat = rgba(p / "cat默认.png")
    leftup = rgba(q / "righthand/rightup默认.png")
    rightup = rgba(p / "up默认猫左爪.png")
    desk = rgba(desk_image)
    size = (320, 172)
    scaled = lambda im: im.resize(size, Image.Resampling.LANCZOS)

    def reduced(im):
        return scaled(im).convert("RGB")

    config = json.loads((p.parents[1] / "config.json").read_text())["standard"]
    assert config["hand"] == config["keyboard"]
    special = {
        192: 53,
        191: 56,
        27: 41,
        46: 76,
        8: 42,
        13: 40,
        32: 44,
        164: 226,
        160: 225,
        162: 224,
        20: 57,
        9: 43,
        91: 227,
        163: 228,
        161: 229,
        165: 230,
    }

    def hid(v):
        if 65 <= v <= 90:
            return v - 65 + 4
        if 48 <= v <= 57:
            return 39 if v == 48 else 30 + v - 49
        if 112 <= v <= 123:
            return 58 + v - 112
        return special[v]

    # Render a single slanted keyboard and its hit masks from identical key geometry.
    unit = 64
    W = 16.3
    H = 6.32
    board = Image.new("RGBA", (int(W * unit), int(H * unit)))
    layout = ImageDraw.Draw(board)
    layout.rounded_rectangle(
        (0, 0, board.width - 1, board.height - 1),
        radius=14,
        fill="#ededed",
        outline="#161616",
        width=4,
    )
    caps = {}
    keys = {}
    hands = {}
    legend = {}
    labels = {}

    def row(y, items):
        x = 0.1
        for code, label, width in items:
            if code is not None:
                box = tuple(
                    round(v * unit)
                    for v in (x + 0.035, y + 0.025, x + width - 0.035, y + 0.93)
                )
                layout.rounded_rectangle(
                    box, radius=7, fill="white", outline="#252525", width=5
                )
                labels[code] = label
                # Labels are rasterized after projection at panel resolution.
                legend[code] = box
            x += width

    def key(k, v, w=1):
        return (k, v, w)

    def letters(word):
        return [key(ord(c) - 65 + 4, c) for c in word]

    row(
        0.08,
        [key(41, "Esc"), (None, "", 0.42)]
        + [key(57 + i, "F" + str(i)) for i in range(1, 13)]
        + [(None, "", 0.55), key(70, "Prt"), key(76, "Del")],
    )
    row(
        1.16,
        [key(53, "`")]
        + [key(30 + i, str((i + 1) % 10)) for i in range(10)]
        + [key(45, "-"), key(46, "="), key(42, "Bksp", 2), key(74, "Hm")],
    )
    row(
        2.16,
        [key(43, "Tab", 1.5)]
        + letters("QWERTYUIOP")
        + [key(47, "["), key(48, "]"), key(49, "\\", 1.5), key(75, "PgU")],
    )
    row(
        3.16,
        [key(57, "Caps", 1.75)]
        + letters("ASDFGHJKL")
        + [key(51, ";"), key(52, "'"), key(40, "Enter", 2.25), key(78, "PgD")],
    )
    row(
        4.16,
        [key(225, "Shift", 2.25)]
        + letters("ZXCVBNM")
        + [
            key(54, ","),
            key(55, "."),
            key(56, "/"),
            key(229, "Shift", 2.75),
            key(77, "End"),
        ],
    )
    row(
        5.16,
        [
            key(224, "Ctrl", 1.25),
            key(227, "Win", 1.25),
            key(226, "Alt", 1.25),
            key(44, "Space", 6.25),
            key(230, "Alt", 1.25),
            key(401, "Fn", 1.25),
            key(228, "Ctrl", 1.25),
            (None, "", 1.25),
            key(73, "Ins"),
        ],
    )
    # Top-left in the cat's view is the bottom-right corner in the viewer's view.
    corners = [(542, 352), (134, 289), (221, 193), (606, 264)]
    plane = [(0, 0), (board.width, 0), (board.width, board.height), (0, board.height)]
    matrix = []
    rhs = []
    for (x, y), (u, v) in zip(corners, plane):
        matrix.extend(
            [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        )
        rhs.extend([u, v])
    coeff = np.linalg.solve(matrix, rhs)

    def project(im):
        return im.transform(
            (612, 354), Image.Transform.PERSPECTIVE, coeff, Image.Resampling.BICUBIC
        )

    scene = Image.new("RGBA", (612, 354), "white")
    scene.alpha_composite(cat)
    keep = Image.new("L", scene.size)
    dr = ImageDraw.Draw(keep)
    dr.polygon([(0, 147), (611, 254), (611, 266), (0, 160)], fill=255)

    scene.alpha_composite(Image.composite(desk, Image.new("RGBA", scene.size), keep))
    scene.alpha_composite(project(board))
    original = {}
    for i, (v,) in enumerate(config["hand"]):
        mask = (
            scaled(Image.open(p / "keyboard" / f"{i}.png").convert("RGBA"))
            .getchannel("A")
            .point(lambda v: 255 if v > 100 else 0)
        )
        a, b, c, d = mask.getbbox()
        original[hid(v)] = (
            (a + c) / 2,
            (b + d) / 2,
            scaled(Image.open(p / "hand" / f"{i}.png").convert("RGBA")),
        )
    for code, box in legend.items():
        mask = Image.new("L", board.size)
        ImageDraw.Draw(mask).rounded_rectangle(box, radius=7, fill=255)
        mask = scaled(project(mask)).point(lambda v: 255 if v >= 125 else 0)
        a, b, c, d = mask.getbbox()
        caps[code] = mask
        keys[code] = (a, b, c - 1, d - 1)
        tx = (a + c) / 2
        ty = (b + d) / 2
        sx, sy, hand = original.get(
            code,
            min(
                original.values(),
                key=lambda item: (item[0] - tx) ** 2 + (item[1] - ty) ** 2,
            ),
        )
        anchor = 74
        # Keep the shoulder in place while moving the paw tip to the new key center.
        sy_scale = (sy - anchor) / (ty - anchor)
        shear = (sx - tx) / (ty - anchor)
        hands[code] = hand.transform(
            size,
            Image.Transform.AFFINE,
            (1, shear, -shear * anchor, 0, sy_scale, anchor * (1 - sy_scale)),
            Image.Resampling.BICUBIC,
        )
    idle = scene.copy()
    idle.alpha_composite(leftup)
    idle.alpha_composite(rightup)
    cleanleft = scene.copy()
    cleanleft.alpha_composite(rightup)
    cleanright = scene.copy()
    cleanright.alpha_composite(leftup)
    blink = idle.copy()
    dr = ImageDraw.Draw(blink)
    for x, y in [(242, 133), (359, 168)]:
        dr.rectangle((x - 11, y - 12, x + 11, y + 12), fill="white")
        dr.line((x - 8, y - 1, x + 7, y + 2), fill="black", width=4)
    backgrounds = list(map(reduced, [idle, cleanleft, cleanright, blink]))

    def arrow_paw(x, y):
        # Scaled silhouette reaches from the left shoulder to the exact cap.
        im = Image.new("RGBA", size)
        d = ImageDraw.Draw(im)
        ax, ay = 86, 60
        dx, dy = x - ax, y - ay
        length = (dx * dx + dy * dy) ** 0.5
        nx, ny = -dy / length, dx / length

        def edge(t, w):
            return (round(ax + t * dx + nx * w), round(ay + t * dy + ny * w))

        poly = [
            edge(0, 9),
            edge(0.32, 9),
            edge(0.75, 6),
            edge(0.96, 4),
            edge(1, 1),
            edge(1, -1),
            edge(0.96, -4),
            edge(0.75, -6),
            edge(0.32, -9),
            edge(0, -9),
        ]
        d.polygon(poly, fill="white")
        d.line(poly, width=2, fill="black", joint="curve")
        return im

    # Each hex digit is one three-pixel row of the key legend.
    glyph = dict(
        zip(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "25755 65656 34443 65556 74647 74644 34553 55755 72227 11152 55655 44447 57755 57775 25552 65644 25573 65655 34216 72222 55557 55552 55775 55255 55222 71247".split(),
        )
    )
    glyph.update(
        zip(
            "0123456789",
            "75557 26227 61247 61216 55711 74616 34652 71222 25252 25316".split(),
        )
    )
    glyph.update(
        {
            "-": "00070",
            "=": "07070",
            "[": "64446",
            "]": "31113",
            "\\": "44211",
            ";": "02024",
            "'": "22000",
            ",": "00024",
            ".": "00002",
            "/": "11244",
            chr(96): "42000",
        }
    )
    short = {
        "ESC": "ES",
        "PRT": "PR",
        "DEL": "DL",
        "BKSP": "BS",
        "TAB": "TB",
        "CAPS": "CP",
        "ENTER": "EN",
        "SHIFT": "SH",
        "SPACE": "SP",
        "CTRL": "CT",
        "WIN": "WN",
        "ALT": "AL",
        "PGU": "PU",
        "PGD": "PD",
        "END": "ED",
        "INS": "IN",
    }
    for code, label in labels.items():
        mask = caps[code]
        x0, y0, x1, y1 = mask.getbbox()
        cx = (x0 + x1 - 1) / 2
        cy = (y0 + y1 - 1) / 2
        word = short.get(label.upper(), label.upper())
        width = len(word) * 4 - 1
        for index, ch in enumerate(word):
            for j, bits in enumerate(glyph[ch]):
                for col in range(3):
                    if not (int(bits) & (4 >> col)):
                        continue
                    dx = (width - 1) / 2 - index * 4 - col
                    x = round(cx + dx + 0.001)
                    y = round(cy + 2 - j + dx * 0.13 + 0.001)
                    if mask.getpixel((x, y)):
                        for frame in backgrounds:
                            frame.putpixel((x, y), (26, 26, 26))

    # One regular inverted T, with four equal caps on the same inclined plane.
    def on_desk(col, row):
        return round(49 + col * 19 - row * 5), round(113 + col * 3 + row * 14)

    icon = {82: [(-4, 0), (0, -4), (4, 0), (1, 0), (1, 3), (-1, 3), (-1, 0)]}
    for k, col, row, rot in [
        (82, 0, -1, 0),
        (80, -1, 0, 3),
        (81, 0, 0, 2),
        (79, 1, 0, 1),
    ]:
        cx, cy = on_desk(col, row)
        corners = [
            (cx - 6, cy - 6),
            (cx + 10, cy - 3),
            (cx + 6, cy + 6),
            (cx - 10, cy + 3),
        ]
        mask = Image.new("L", size)
        ImageDraw.Draw(mask).polygon(corners, fill=255)
        caps[k] = mask
        a, b, c, d = mask.getbbox()
        keys[k] = a, b, c - 1, d - 1
        hands[k] = arrow_paw(cx, cy)
        symbol = []
        for x, y in icon[82]:
            for _ in range(rot):
                x, y = -y, x
            symbol.append((cx + x, cy + y))
        for im in backgrounds:
            draw = ImageDraw.Draw(im)
            draw.polygon(corners, fill="white", outline="#2c2c2c")
            draw.polygon(symbol, fill="#181818")

    # Encode opaque backgrounds once, deduplicating scanlines. Hand rows use outline widths from actual silhouette.
    colors = [
        "#000000",
        "#161616",
        "#303030",
        "#4a4a4a",
        "#646464",
        "#7e7e7e",
        "#989898",
        "#b2b2b2",
        "#cccccc",
        "#dedede",
        "#eeeeee",
        "#ffffff",
        "#ff879f",
        "#ffc1cd",
        "#ffdae2",
        "#f5f5f5",
    ]
    pal = Image.new("P", (1, 1))
    pal.putpalette(list(bytes.fromhex("".join(c[1:] for c in colors))) * 16)
    indexed = [im.quantize(palette=pal, dither=Image.Dither.NONE) for im in backgrounds]
    bareboxes = [
        ImageChops.difference(indexed[0].convert("RGB"), im.convert("RGB")).getbbox()
        for im in indexed[1:]
    ]
    datarows = bytearray()
    offsets = []
    cache = {}
    rects = []
    for im, (a, b, c, d) in zip(indexed, [(0, 25, 320, 172), *bareboxes]):
        rects.append([a, b, c - a, d - b, len(offsets)])
        for y in range(b, d):
            row = bytes(rle(list(im.crop((a, y, c, y + 1)).getdata())))
            if row not in cache:
                cache[row] = len(datarows)
                datarows.extend(row)
            offsets.append(cache[row])
    spans = []
    poses = []
    codes = []
    caprows = []
    for key in sorted(keys):
        im = hands[key]
        alpha = im.getchannel("A").point(lambda v: 255 if v > 115 else 0)
        a, b, c, d = alpha.getbbox()
        assert c - a < 256
        index = len(spans)
        raw = []
        for y in range(b, d):
            box = alpha.crop((a, y, c, y + 1)).getbbox()
            if not box:
                raw.extend([0, 0, 0])
                continue
            l, r = box[0] + a, box[2] + a - 1
            whites = [
                x
                for x in range(l, r + 1)
                if im.getpixel((x, y))[0] > 100 and alpha.getpixel((x, y))
            ]
            edge = (
                (min(14, whites[0] - l) << 4 | min(14, r - whites[-1]))
                if whites
                else 255
            )
            raw.extend([l - a, r - a, edge])
        side = 1 if key in (79, 80, 81, 82) else 2
        assert len(raw) <= 512
        delta = [
            (raw[j] - (raw[j - 3] if j >= 3 else 0)) & 255
            for channel in range(3)
            for j in range(channel, len(raw), 3)
        ]
        spans.extend(compress(delta))
        x0, y0, x1, y1 = keys[key]
        cap_index = len(caprows) // 2
        for row in range(y0, y1 + 1):
            if key in caps:
                bounds = caps[key].crop((x0, row, x1 + 1, row + 1)).getbbox()
                caprows.extend((bounds[0], bounds[2] - 1) if bounds else (1, 0))
            else:
                caprows.extend((0, x1 - x0))
        poses.append([a, b, d - b, index, side, x0, y0, x1, y1, cap_index])
        codes.append(key)
    assert {4, 29, 30, 39, 58, 59, 69, 76, 79, 80, 81, 82, 401} <= set(codes) and len(
        set(codes)
    ) == len(codes)

    def array(typ, name, items):
        return f"static const {typ} {name}[]={{" + ",".join(map(str, items)) + "};\n"

    def table(name, items):
        return (
            f"static const u16 {name}[][{len(items[0])}]={{"
            + ",".join("{" + ",".join(map(str, row)) + "}" for row in items)
            + "};\n"
        )

    hdr = (
        array("u16", "palette", list(map(rgb565, colors)))
        + array("u8", "background_runs", datarows)
        + array("u16", "row_offset", offsets)
        + table("rects", rects)
        + array("u8", "paw_rows", spans)
        + array("u8", "cap_rows", caprows)
        + table("poses", poses)
        + array("u16", "keycodes", codes)
    )

    (out / "keymap.h").write_text(hdr, encoding="utf8")
    (out / "targets.json").write_text(json.dumps(keys), encoding="utf8")
    # Expand once to canonical RGB565 values shared by the GIF and native renderer.
    lookup = []
    for color in map(rgb565, colors):
        red, green, blue = color >> 11, (color >> 5) & 63, color & 31
        lookup.append(
            (
                (red << 3) | (red >> 2),
                (green << 2) | (green >> 4),
                (blue << 3) | (blue >> 2),
            )
        )
    frame = Image.new("RGB", size)
    frame.putdata([lookup[index] for index in indexed[0].getdata()])
    return frame
