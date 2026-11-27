"""Opt-in Bank2 pet IPS builder. Reuses exact stock/hash/patch checks.
No hardware access; no CH585 image or private assets. SPDX-License-Identifier: MIT.
"""
import argparse, json
from pathlib import Path
import build as fw
from assets import ROOT, resolve_theme, generate, save_cache_gif, validate_cache_gif
from bongo_art import render


def build(a):
    stock = fw.checked(a.stock, fw.IPS_SHA)
    low, high, base = 0x08080000, 0x08088000, 0x08004000
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    clang = fw.compiler(a)
    theme_name, theme = resolve_theme(a.theme)
    generate(a.keys, a.theme, out / "assets", out)
    if a.public_art == bool(a.model or a.desk_image) or not a.public_art and not (a.model and a.desk_image):
        raise ValueError("Choose --public-art or both --model and --desk-image")
    frame = render(a.model, a.desk_image, out)
    gif = out / "assets" / f"bongo-base-{theme_name}.gif"
    save_cache_gif([frame, frame], gif)
    validate_cache_gif(gif, theme)
    sources = [ROOT / "firmware/ips/native_ui.c", ROOT / "firmware/ips/rtc.c"]
    linker = ROOT / "firmware/ips-lyrics/linker.ld"
    target = out / "module.elf"
    fw.run(
        [
            clang,
            "--target=arm-none-eabi",
            "-mcpu=cortex-m4",
            "-mthumb",
            "-mfloat-abi=soft",
            "-DRAINY_BONGO=1",
            *(["-DRAINY_BONGO_ID=0x4247"] if a.public_art else []),
            "-ffreestanding",
            "-fno-builtin",
            "-Oz",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-nostdlib",
            "-fuse-ld=lld",
            "-I",
            out,
            "-Wl,-T," + str(linker),
            *sources,
            "-o",
            target,
        ]
    )
    own = target.read_bytes()
    _, _, _, symbols, segments = fw.elf(own)
    image = bytearray(stock)
    patches = []
    for kind, off, va, pa, n, memsize, flags, align in segments:
        if kind != 1 or not n:
            continue
        fw.require(
            low <= va and va + n <= high, "Code escapes audited Bank2 reservation"
        )
        start = va - base
        fw.require(start >= len(stock), "Code overlaps stock")
        if len(image) < start + n:
            image.extend(b"\xff" * (start + n - len(image)))
        image[start : start + n] = own[off : off + n]
    for addr, old, symbol in [
        (0x0807CA16, 0x0807A600, "start"),
        (0x0805B5B8, 0x080596AC, "ips"),
        (0x0807A73E, 0x0802DCA8, "gui"),
        (0x0807A760, 0x0805B244, "image"),
        (0x0807A764, 0x0805B030, "misc"),
        (0x0805B282, 0x0805D6F2, "cached_draw"),
        (0x0805B462, 0x0805AC72, "native_key"),
        (0x0805B53A, 0x0805AE0A, "native_status"),
    ]:
        at = addr - base
        fw.require(
            image[at : at + 4] == fw.thumb_bl(addr, old), "Stock instruction mismatch"
        )
        image[at : at + 4] = fw.thumb_bl(addr, symbols["rainy_hook_" + symbol])
        patches.append({"fileOffset": at, "bytes": 4})
    fw.require(len(image) + base <= high, "Image overflow")
    image.extend(b"\xff" * (high - base - len(image)))
    allowed = {
        i for p in patches for i in range(p["fileOffset"], p["fileOffset"] + p["bytes"])
    }
    fw.require(
        image[:512] == stock[:512]
        and all(x == y or i in allowed for i, (x, y) in enumerate(zip(stock, image))),
        "Unexpected factory modifications",
    )
    slot = fw.locate_theme_slot(target, own, clang, low, high, base, image, theme)
    manifest = {
        "format": "rainy75v2-tft/build-v1",
        "target": "ips",
        "status": "native key-mapped screen pet",
        "bytes": len(image),
        "sha256": fw.digest(image),
        "stockSha256": fw.digest(stock),
        "applicationBase": 0x4000,
        "iapPid": 0x3078,
        "appPid": 0x3075,
        "patches": patches,
        "codeStart": low,
        "imageEnd": high,
        "requiredFlashKiB": 1024,
        "requiredSeries": 13,
        "iapEraseEnd": 0x080C0000,
        "preservedSettings": [0x080FC000, 0x080FE000, 0x080FF800],
        "moduleRam": "0x2005f000..0x20060000",
        "theme": theme_name,
        "themeColors": theme,
        "themeSlot": slot,
        "protocol": "L6",
        "pet": "bongocat-keymap",
        "petLayout": "fullscreen320x172",
        "variant": "bongo-v1",
        "petEnabled": True,
        "petArtLicense": "MIT" if a.public_art else "User-provided Mver assets for personal use",
        "petGif": gif.relative_to(out).as_posix(),
        "petIdentity": 0x4247 if a.public_art else 0x4246,
    }
    (out / "rainy75v2-ips.bin").write_bytes(image)
    (out / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps(manifest))
    return out


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--stock", type=Path, required=True)
    p.add_argument("--clang")
    p.add_argument("--out", type=Path, default=ROOT / "build/bongo")
    p.add_argument("--keys", type=Path, default=ROOT / "profiles/keys.json")
    p.add_argument("--theme", default="pink")
    p.add_argument("--model", type=Path)
    p.add_argument("--desk-image", type=Path)
    p.add_argument("--public-art", action="store_true")
    build(p.parse_args())
