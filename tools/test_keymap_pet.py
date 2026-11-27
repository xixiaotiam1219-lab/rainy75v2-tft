"""Execute pet hooks in Unicorn; no physical device or transport access.
SPDX-License-Identifier: MIT.
"""
import argparse, json, struct, hashlib
from pathlib import Path
from PIL import Image
from unicorn import Uc, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS, UC_HOOK_CODE
from unicorn.arm_const import (
    UC_ARM_REG_R0,
    UC_ARM_REG_R1,
    UC_ARM_REG_R2,
    UC_ARM_REG_R3,
    UC_ARM_REG_SP,
    UC_ARM_REG_LR,
    UC_ARM_REG_PC,
)
from build import elf, require
from assets import ROOT, rgb565, load


def run(folder, preview=None):
    folder = Path(folder)
    m = load(folder / "manifest.json")
    image = (folder / "rainy75v2-ips.bin").read_bytes()
    require(
        m.get("petEnabled") is True
        and hashlib.sha256(image).hexdigest() == m["sha256"],
        "Not the expected pet image",
    )
    _, _, _, syms, _ = elf((folder / "module.elf").read_bytes())
    u = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
    u.mem_map(0x08000000, 0x100000)
    u.mem_write(0x08004000, image)
    u.mem_map(0x20000000, 0x60000)
    u.mem_map(0x40000000, 0x40000)
    surface, obj, stack, stop = 0x20010002, 0x20006000, 0x2005E000, 0x08001000
    ctx = {"now": 1000, "draws": 0}

    def put(at, v, n=4):
        u.mem_write(at, int(v).to_bytes(n, "little"))

    def ret(v=0):
        u.reg_write(UC_ARM_REG_R0, v)
        u.reg_write(UC_ARM_REG_PC, u.reg_read(UC_ARM_REG_LR))

    def external(cpu, at, size, _):
        if at == 0x0803A2BA:
            ret(ctx["now"])
        elif at == 0x0805D6F2:
            ctx["draws"] += 1
            put(0x20001C6C, 1)
            ret()
        else:
            ret()

    for at in [
        0x0803A2BA,
        0x0805D6F2,
        0x0807A600,
        0x0805AC72,
        0x0805AE0A,
        0x0805B244,
        0x0802DCA8,
        0x0805B030,
    ]:
        u.hook_add(UC_HOOK_CODE, external, begin=at, end=at)

    def call(name, *args):
        for i, r in enumerate(
            [UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3]
        ):
            u.reg_write(r, args[i] if i < len(args) else 0)
        for i, v in enumerate(args[4:]):
            put(stack + i * 4, v)
        u.reg_write(UC_ARM_REG_SP, stack)
        u.reg_write(UC_ARM_REG_LR, stop | 1)
        u.emu_start(syms[name] | 1, stop, count=12000000)
        assert u.reg_read(UC_ARM_REG_PC) & ~1 == stop, name

    def draw():
        put(0x20001C6C, 0)
        call("rainy_hook_cached_draw", 0, 0, 320, 172, surface)
        put(0x20001C6C, 0)
        return bytes(u.mem_read(surface, 110080))

    def tick(now):
        ctx["now"] = now
        put(0x20001C6C, 0)
        call("rainy_hook_image")
        put(0x20001C6C, 0)
        return bytes(u.mem_read(surface, 110080))

    def pet(raw):
        return raw

    call("rainy_hook_start")
    put(0x40004C00, 0x40)
    put(0x2003EDE8, obj)
    put(obj + 0x658, surface)
    for at, v in [
        (0x2003EDBA, 320),
        (0x2003EDBC, 172),
        (0x2003EDBE, 0),
        (0x2003EDC0, 0),
    ]:
        put(at, v, 2)
    base = Image.open(folder / m["petGif"]).convert("RGB")
    raw = b"".join(
        struct.pack("<H", rgb565("#%02x%02x%02x" % c)) for c in base.getdata()
    )
    u.mem_write(surface, raw)
    idle = draw()
    assert idle == raw
    targets = {int(k): v for k, v in load(folder / "targets.json").items()}
    distinct = set()
    samples = {}
    for key, (x0, y0, x1, y1) in targets.items():
        call("rainy_hook_native_key", key, 0, 0)
        frame = draw()
        assert frame not in distinct, ("duplicate pose", key)
        distinct.add(frame)
        at = 0
        marked = []
        for yy in range(172):
            for xx in range(320):
                at = (yy * 320 + xx) * 2
                if frame[at : at + 2] != idle[at : at + 2]:
                    color = int.from_bytes(frame[at : at + 2], "little")
                    if (
                        color >> 11 >= 8
                        and (color >> 5 & 63) == (color >> 11) // 2
                        and (color & 31) == (color >> 11) // 2
                    ):
                        marked.append((xx, yy))
        assert all(x0 <= xx <= x1 and y0 <= yy <= y1 for xx, yy in marked), (
            "misplaced highlight",
            key,
        )
        # Independent LCD-space bounds from the original cat-facing artwork.
        arrow_caps = {82: (41, 118, 72, 137), 81: (63, 102, 92, 116),
                      80: (91, 107, 123, 125), 79: (37, 95, 65, 109)}
        if key in arrow_caps:
            left, top, right, bottom = arrow_caps[key]
            assert all(left <= x <= right and top <= y <= bottom for x, y in marked), key
        assert marked, ("invisible highlight", key)
        if key in [4, 29, 58, 59, 69, 79, 80, 81, 82, 75]:
            samples[key] = frame
        call("rainy_hook_native_key", key, 0, 0)
        assert draw() == frame
        call("rainy_hook_native_key", 0, 0, 0)
        assert draw() == frame
        if key in range(224, 232):
            call("rainy_hook_native_key", key - 232, 0, 0)
            assert draw() == frame
    call("rainy_hook_native_key", 999, 0, 0)
    assert draw() == idle
    ctx["now"] = 1020
    call("rainy_hook_native_key", 4, 0, 0)
    assert draw() == samples[4]
    assert tick(1119) == samples[4]
    restored = tick(1120)
    assert restored == idle
    blink = tick(3900)
    assert blink != idle and tick(4001) == idle
    first, second = samples[58], samples[69]
    # DMA owns the frame until completion, including key/pose changes.
    before = bytes(u.mem_read(surface, 110080))
    put(0x20001C6C, 1)
    call("rainy_hook_native_key", 5, 0, 0)
    call("rainy_hook_image")
    call("rainy_hook_cached_draw", 0, 0, 320, 172, surface)
    assert bytes(u.mem_read(surface, 110080)) == before
    put(0x20001C6C, 0)
    draw()
    tick(4101)
    ctx["now"] = 0xFFFFFFD0
    call("rainy_hook_native_key", 6, 0, 0)
    wrapped = draw()
    assert pet(tick(0x33)) == pet(wrapped)
    assert pet(tick(0x34)) == pet(idle), "Unsigned timer rollover"
    # No spill beyond validated drawing regions; guards also test halfword alignment.
    assert (
        bytes(u.mem_read(surface - 2, 2)) == b"\0\0"
        and bytes(u.mem_read(surface + 110080, 2)) == b"\0\0"
    )
    assert (
        idle == restored
    ), "The whole immersive scene must restore, including hidden legacy UI"
    if preview:
        preview = Path(preview)
        preview.mkdir(parents=True, exist_ok=True)
        frames = []
        for name, pixels in [
            ("idle", idle),
            ("F1", first),
            ("F12", second),
            ("blink", blink),
            ("A", samples[4]),
            ("up", samples[82]),
        ]:
            im = Image.new("RGB", (320, 172))
            im.putdata(
                [
                    (
                        ((v >> 11) & 31) * 255 // 31,
                        ((v >> 5) & 63) * 255 // 63,
                        (v & 31) * 255 // 31,
                    )
                    for (v,) in struct.iter_unpack("<H", pixels)
                ]
            )
            im.save(preview / f"bongo-{name}-320.png")
            im.resize((960, 516), Image.Resampling.NEAREST).save(
                preview / f"bongo-{name}.png"
            )
            frames.append(im)
        frames[0].save(
            preview / "bongo-response-model.gif",
            save_all=True,
            append_images=[
                frames[1],
                frames[0],
                frames[2],
                frames[0],
                frames[3],
                frames[0],
            ],
            duration=[600, 100, 150, 100, 600, 120, 600],
            loop=0,
            disposal=2,
        )
    result = {
        "passed": True,
        "layer": "ARM instruction model; no hardware tested",
        "checks": [
            f"{len(targets)} distinct key poses, repeated key, exact target bounding boxes and signed modifiers",
            "key-up ignored",
            "100ms exact idle restoration",
            "blink",
            "DMA ownership",
            "timer rollover",
            "halfword aligned surface guard",
            "region bounds",
        ],
        "sha256": m["sha256"],
    }
    (folder / "bongo-model-validation.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--build", type=Path, default=ROOT / "build/bongo")
    p.add_argument("--preview", type=Path)
    a = p.parse_args()
    run(a.build, a.preview)
