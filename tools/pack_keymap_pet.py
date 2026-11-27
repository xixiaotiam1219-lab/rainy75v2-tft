"""Build the Bongo Cat source and installer kit. SPDX-License-Identifier: MIT."""
import argparse
import shutil
from pathlib import Path
from zipfile import ZipFile

from release import ROOT, bundle_html, sha256_bytes, sha256_file, verify_release_html, write_release_zip

SOURCE = (
    'LICENSE', 'DISCLAIMER.md', 'docs/keymap-pet.md',
    'licenses/BONGO-ART-NOTICE.txt', 'licenses/ayangweb-BongoCat-Apache-2.0.txt',
    'profiles/font.json', 'profiles/keys.json', 'profiles/themes.json',
    'firmware/ips/native_ui.c', 'firmware/ips/native_ui.h', 'firmware/ips/rtc.c',
    'firmware/ips/keymap_pet.h', 'firmware/ips-lyrics/linker.ld',
    'tools/build_keymap_pet.py', 'tools/test_keymap_pet.py', 'tools/bongo_art.py', 'tools/original_cat_art.py',
    'tools/assets.py', 'tools/build.py', 'tools/extract_stock.py', 'tools/main_profiles.py',
)
INSTALLER = '安装白猫.html'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='New output directory')
    args = parser.parse_args()
    out = args.out
    directory = out / 'rainy75v2-bongocat'
    directory.mkdir(parents=True)
    for name in SOURCE:
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    raw = bundle_html(ROOT / 'web/keymap-pet.html')
    verify_release_html(raw, require_bundle_payload=False)
    (directory / INSTALLER).write_text(raw, 'utf8')
    (directory / '先读我.md').write_text(
        '# Bongo Cat 白猫按键版\n\n'
        '1. 按 docs/keymap-pet.md 准备本机素材和原厂 IPS 文件，构建屏幕固件。\n'
        '2. 用 Chrome 或 Edge 打开「安装白猫.html」，选刚构建的目录。\n'
        '3. 用 USB 有线连接 Rainy75 V2，退出 WOBHub 和歌词后台，点「开始安装」。按提示选择正常键盘和屏幕升级设备。\n\n'
        '软件包包含独立网页和构建源码。第三方原图、字体和含图的固件由使用者在本机准备和生成。'
        '安装前需在正常模式检测 1024 KiB / 系列 13 屏幕，并使用已有的兼容主控。'
        '安装会替换 GIF 槽位 1。若写入中断后只见到 0x3078，请用原页面重试，或按项目恢复指南处理。\n\n'
        '免费项目，严禁倒卖。项目自身源码采用 MIT，第三方素材沿用各自许可。\n', 'utf8')
    files = sorted(file for file in directory.rglob('*') if file.is_file())
    checksums = {file.relative_to(directory).as_posix(): sha256_file(file) for file in files}
    (directory / 'SHA256SUMS.txt').write_text(
        ''.join(f'{checksum} *{name}\n' for name, checksum in checksums.items()), 'utf8')
    archive = out / 'rainy75v2-bongocat-build-and-install.zip'
    write_release_zip(directory, archive)
    with ZipFile(archive) as zipped:
        if zipped.testzip() or set(zipped.namelist()) != {*checksums, 'SHA256SUMS.txt'}:
            raise ValueError('ZIP members do not match the source-only pack')
        for name, checksum in checksums.items():
            if sha256_bytes(zipped.read(name)) != checksum:
                raise ValueError(f'ZIP checksum mismatch: {name}')
    print(archive.resolve())


if __name__ == '__main__':
    main()
