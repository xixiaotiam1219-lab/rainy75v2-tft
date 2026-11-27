"""Project-owned white cat and desk artwork. SPDX-License-Identifier: MIT."""
from PIL import Image, ImageDraw

ART_SIZE = (612, 354)
# USB usages in the cat-facing view, with coordinates in LCD viewer space.
ARROWS = {
    82: [(116, 243), (154, 251), (131, 284), (93, 275)],
    81: [(158, 209), (192, 215), (171, 241), (135, 233)],
    80: [(212, 220), (251, 229), (228, 258), (188, 248)],
    79: [(107, 196), (140, 201), (122, 226), (84, 218)],
}


def layers():
    cat = Image.new("RGBA", ART_SIZE)
    draw = ImageDraw.Draw(cat)
    draw.rounded_rectangle((173, 104, 439, 244), radius=58, fill="#dedede", outline="#161616", width=6)
    ears = [(150, 131), (154, 36), (237, 75), (324, 69), (414, 34), (420, 147)]
    draw.polygon(ears, fill="white")
    draw.line(ears, fill="#161616", width=6, joint="curve")
    draw.polygon([(162, 48), (215, 77), (164, 91)], fill="#ffc1cd")
    draw.polygon([(402, 48), (351, 74), (407, 90)], fill="#ffc1cd")
    draw.rounded_rectangle((149, 81, 420, 201), radius=57, fill="white", outline="#161616", width=6)
    draw.line([(161, 102), (188, 89), (226, 82), (314, 82), (366, 85), (406, 105)],
              fill="white", width=8)
    for x, y in [(242, 133), (359, 168)]:
        draw.ellipse((x - 7, y - 9, x + 7, y + 9), fill="#161616")
    for x, y in [(196, 148), (383, 174)]:
        draw.ellipse((x - 10, y - 5, x + 10, y + 5), fill="#ffc1cd")
    draw.polygon([(287, 150), (301, 152), (293, 160)], fill="#161616")
    draw.arc((279, 152, 293, 167), 0, 138, fill="#161616", width=4)
    draw.arc((293, 154, 307, 169), 45, 180, fill="#161616", width=4)
    draw.rounded_rectangle((187, 192, 416, 221), radius=12, fill="#ff879f", outline="#161616", width=5)
    draw.ellipse((304, 204, 324, 224), fill="#ffdae2", outline="#161616", width=4)

    def idle_paw(box):
        layer = Image.new("RGBA", ART_SIZE)
        pad = ImageDraw.Draw(layer)
        pad.rounded_rectangle(box, radius=22, fill="white", outline="#161616", width=5)
        x, y = box[2] - 19, box[3] - 5
        pad.line((x, y - 11, x + 5, y), fill="#646464", width=3)
        return layer

    desk = Image.new("RGBA", ART_SIZE)
    draw = ImageDraw.Draw(desk)
    draw.polygon([(0, 148), (611, 255), (611, 263), (0, 156)], fill="#cccccc")
    draw.line((0, 148, 611, 255), fill="#303030", width=5)
    for code, points in ARROWS.items():
        draw.polygon(points, fill="white")
        draw.line(points + [points[0]], fill="#303030", width=4, joint="curve")
        x = sum(p[0] for p in points) // 4
        y = sum(p[1] for p in points) // 4
        dx, dy = {79: (-1, 0), 80: (1, 0), 81: (0, -1), 82: (0, 1)}[code]
        tip = (x + 6 * dx, y + 6 * dy)
        draw.line((x - 5 * dx, y - 5 * dy, *tip), fill="#161616", width=3)
        draw.polygon([tip, (x - 4 * dy, y + 4 * dx), (x + 4 * dy, y - 4 * dx)], fill="#161616")
    return cat, idle_paw((139, 112, 190, 166)), idle_paw((376, 115, 431, 170)), desk
