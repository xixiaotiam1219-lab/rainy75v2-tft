"""Package six standalone installers and matched firmware. SPDX-License-Identifier: MIT."""
import argparse
import base64
import gzip
import io
import json
import shutil
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageFont

from pack_clock071 import STOCK_SHA, pack_clock_page
from release import (
    ROOT, _gz_b64, _load_target_entry, bundle_html, sha256_bytes, sha256_file,
    verify_release_html, verify_release_dir, write_release_zip,
)

EDITIONS = (
    ('keys', '桌宠与按键', None, 'preview-pink.png'),
    ('lyrics-classic', '经典双行歌词', 0, 'player-pink-20.png'),
    ('lyrics-caption', '大字字幕', 1, 'player-pink.png'),
    ('lyrics-focus', '大字聚焦', 2, 'player-pink-focus.png'),
    ('lyrics-double', '双行大字', 3, 'player-pink-double.png'),
    ('lyrics-cover', '沉浸封面', 4, 'player-pink-immersive.png'),
)
FORMAT = 'rainy75v2/edition-v1'
COMMON = ('background-locations.cjs', 'config.cjs', 'gui-server.cjs')
PLAYER = (
    'bridge.cjs', 'cover.cjs', 'cover.ps1', 'font.cjs', 'hid-caps.ps1',
    'launch.cjs', 'lyric-link.cjs', 'lyric-provider.cjs', 'media.ps1', 'music.cjs',
    'netease-timeline.cjs', 'screen-control.cjs', 'startup.ps1', 'transport.cjs',
    'volume.cjs', 'volume.ps1',
)
LICENSES = ('LICENSE-MIT.txt', 'WCH-SDK-NOTICE.txt', 'WOB-STOCK-NOTICE.txt')
MAIN_HASHES = {
    'main063beta1': 'bc575a6d7b19042048705248715a43a67a23c7f217ba0ac464c539a390f4d23b',
    'main064': '31a9eb80752c1f8c94951dd6e2e6776eeb216f47ba58919ca36f6e6d26f0e476',
    'main071': STOCK_SHA,
}
IPS_SHA = '32defab7902e57eb972a577fc6cbf3a7e57bc772d59b99f11038370412b77f41'


def payload(data):
    return {'binGzipBase64': _gz_b64(data), 'sha256': sha256_bytes(data), 'size': len(data)}


def image_bytes(entry, key):
    raw = gzip.decompress(base64.b64decode(entry['binGzipBase64'], validate=True))
    main = key in MAIN_HASHES
    lyrics = key == 'ipsLyrics'
    size = 294912 if main else 540672 if lyrics else 507904
    expected = {
        'format': 'rainy75v2-tft/build-v1', 'target': 'main' if main else 'ips',
        'applicationBase': 0x2000 if main else 0x4000,
        'iapPid': 0x3079 if main else 0x3078, 'appPid': 0x3075,
        'bytes': size, 'sha256': sha256_bytes(raw), 'stockSha256': MAIN_HASHES.get(key, IPS_SHA),
        'variant': 'lyrics-v1' if lyrics else None,
    }
    if lyrics:
        expected.update(requiredFlashKiB=1024, requiredSeries=13, codeStart=0x08080000,
                        imageEnd=0x08088000, iapEraseEnd=0x080c0000)
    if (len(raw) != size or entry['size'] != size or entry['sha256'] != expected['sha256']
            or any(entry['manifest'].get(field) != value for field, value in expected.items())):
        raise ValueError(f'Wrong image for {key}: target, length, stock SHA or address')
    return raw


def waiting_gif(theme):
    image = Image.new('RGB', (320, 172), theme['background'])
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((8, 36, 311, 162), radius=14, fill=theme['panel'], outline=theme['shell'], width=2)
    draw.point((22, 39), fill=theme['ink'])
    draw.text((231, 85), 'LYRICS', fill=theme['ink'], anchor='mm', font=ImageFont.load_default(size=19))
    draw.rounded_rectangle((203, 104, 259, 108), radius=2, fill=theme['accent'])
    result = io.BytesIO()
    image.save(result, format='GIF', disposal=1, duration=500, loop=0, optimize=False)
    return result.getvalue()


def copy_named(source, dest, names):
    dest.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copyfile(source / name, dest / name)


def notices(directory, frozen, extra=()):
    copy_named(frozen / 'licenses', directory / 'licenses', LICENSES + extra)
    shutil.copyfile(ROOT / 'DISCLAIMER.md', directory / '免责声明.md')
    (directory / '许可与声明.txt').write_text(
        '免费项目，严禁倒卖。\n本项目自有代码采用 MIT。原厂固件及第三方组件沿用各自的许可。\n'
        '恢复镜像由对应出厂版本重建，未从设备读取。\n', 'utf8')


def package_zip(directory, target):
    lines = []
    for file in sorted(p for p in directory.rglob('*') if p.is_file()):
        lines.append(f'{sha256_file(file)} *{file.relative_to(directory).as_posix()}')
    (directory / 'SHA256SUMS.txt').write_text('\n'.join(lines) + '\n', 'utf8')
    write_release_zip(directory, target)
    with ZipFile(target) as archive:
        if archive.testzip() or len(archive.namelist()) != len(lines) + 1:
            raise ValueError(f'Invalid archive: {target}')
        for line in lines:
            digest, name = line.split(' *', 1)
            if sha256_bytes(archive.read(name)) != digest:
                raise ValueError(f'Archive file does not match checksums: {name}')
    print(target, flush=True)


def write_launcher(directory):
    # Keep batch commands and referenced filenames ASCII under every cmd code page.
    script = (
        '@echo off\n'
        'setlocal EnableExtensions DisableDelayedExpansion\n'
        'set "RAINY75_DATA=%~dp0app\\data"\n'
        'set "RAINY75_FONT=%~dp0app\\FONT.BIN"\n'
        'if not exist "%~dp0app\\runtime\\node.exe" goto missing\n'
        'if not exist "%~dp0app\\desktop\\gui-server.cjs" goto missing\n'
        'if not exist "%~dp0install.html" goto missing\n'
        'echo Opening the installer. Keep this window open until setup is complete.\n'
        'echo If needed, copy the URL below into Chrome or Edge.\n'
        '"%~dp0app\\runtime\\node.exe" "%~dp0app\\desktop\\gui-server.cjs" --html "%~dp0install.html" --open\n'
        'if not errorlevel 1 exit /b 0\n'
        'pause\n'
        'exit /b 1\n'
        ':missing\n'
        'echo Installer files are missing. Extract the entire ZIP before running this file.\n'
        'pause\n'
        'exit /b 1\n'
    )
    (directory / '点我安装.cmd').write_bytes(script.replace('\n', '\r\n').encode('ascii'))


def write_edition(output, frozen, firmware, font, edition):
    name, title, layout, preview = edition
    lyric = layout is not None
    directory = output / name
    app = directory / 'app'
    runtime = frozen / 'Windows便携后台'
    copy_named(runtime / 'runtime', app / 'runtime', ('node.exe',))
    copy_named(ROOT / 'desktop', app / 'desktop', COMMON + (PLAYER if lyric else ()))
    settings = {'format': FORMAT, 'id': name, 'title': title, 'layout': layout}
    (app / 'edition.json').write_text(json.dumps(settings, ensure_ascii=False), 'utf8')
    fw = {key: value for key, value in firmware.items() if lyric or key != 'ipsLyrics'}
    if lyric:
        shutil.copyfile(ROOT / 'desktop/edition-control.html', app / 'desktop/control.html')
        copy_named(runtime / 'app', app, ('FONT.BIN', 'FONT-NOTICE.txt', 'OFL-1.1.txt'))
        if (app / 'FONT.BIN').read_bytes() != font:
            raise ValueError('Screen and desktop FONT.BIN differ')
        shutil.copytree(runtime / 'app/node_modules', app / 'node_modules')
        copy_named(ROOT / 'web', app / 'web', ('hid.mjs', 'protocol.mjs', 'font.mjs'))
        gif = waiting_gif(fw['ipsLyrics']['manifest']['themeColors'])
    else:
        gif = (frozen / '固件与素材/assets/robot-pink.gif').read_bytes()
    png = base64.b64encode((ROOT / 'assets' / preview).read_bytes()).decode('ascii')
    bundle = {'format': FORMAT, 'edition': {**settings, 'preview': 'data:image/png;base64,' + png},
              'firmware': fw, 'gif': payload(gif),
              'publicFontIdentity': {'bodyCrc': int.from_bytes(font[36:40], 'little'), 'bytes': len(font)}}
    if lyric:
        bundle['font'] = payload(font)
    html = bundle_html(ROOT / 'web/easy-install.html', bundle)
    verify_release_html(html, require_bundle_payload=False)
    (directory / 'install.html').write_text(html, 'utf8')
    write_launcher(directory)
    extra = ('NodeJS-LICENSE.txt',) + (('netease-elog-MIT.txt', 'node-hid-LICENSE.txt', 'Noto-OFL-1.1.txt') if lyric else ())
    notices(directory, frozen, extra)
    (directory / '使用说明.md').write_text(
        f'# {title}\n\n'
        '1. 解压整个 ZIP，双击 **点我安装.cmd**。\n'
        '2. 用 USB 线连接键盘，切到有线档，退出 WOBHub。\n'
        '3. 点 **开始安装**。弹窗出现时选页面提示的设备，等待安装完成。\n\n'
        + ('安装结束后播放 QQ 音乐或网易云音乐。歌词需要 Windows 后台和 USB 有线连接，网页可以关闭。'
           '以后通过「启动歌词同步」直接启动，可在「歌词设置」开启登录自启。\n\n' if lyric else
           '安装后可关闭安装窗口。桌宠和按键页由键盘自行运行。\n\n')
        + '若要清理旧歌词字库，可在刷桌宠版前打开页面底部「删除屏内字库」。\n\n'
          '安装会替换小屏第 1 个 GIF。若小屏仍是原厂界面，暂停歌词同步后在 WOBHub 选 GIF 槽位 1，再退出 WOBHub。\n'
          '安装中断时保持 USB 供电，在原窗口点「再试这一步」。若已关闭窗口且只看到升级设备，'
          '请按同一 Release 的固件包和恢复说明处理。\n', 'utf8')
    package_zip(directory, output / f'rainy75v2-{name}-windows-x64.zip')


def load_firmware(frozen, main071):
    stock = frozen / '固件与素材'
    files = {'main063beta1': 'main-063beta1', 'main064': 'main-064', 'main071': 'main',
             'ipsBase': 'ips-base', 'ipsLyrics': 'ips-lyrics'}
    firmware, restore = {}, {}
    for key, name in files.items():
        target = 'main' if key in MAIN_HASHES else 'ips'
        directory = main071 if key == 'main071' else stock
        firmware[key] = _load_target_entry(directory / name, f'rainy75v2-{target}.bin')
        if key != 'ipsLyrics':
            restore_dir = 'ips-restore' if key == 'ipsBase' else name + '-restore'
            if key != 'main071':
                directory = directory / 'restore-images'
            restore[key] = _load_target_entry(directory / restore_dir, f'rainy75v2-{target}-restore.bin')
    model = json.loads((main071 / 'main/model-validation.json').read_text('utf8'))
    if model.get('passed') is not True or model.get('stockVersion') != '0.71' or model.get('sha256') != firmware['main071']['sha256']:
        raise ValueError('The bundled 0.71 image requires a passing machine-code model')
    return firmware, restore


def write_firmware(output, frozen, main071, firmware, restore):
    directory = output / 'firmware'
    for group, images in [('定制固件', firmware), ('恢复固件', restore)]:
        for key, entry in images.items():
            folder = directory / group / key
            folder.mkdir(parents=True)
            (folder / 'firmware.bin').write_bytes(image_bytes(entry, key))
            (folder / 'manifest.json').write_text(json.dumps(entry['manifest'], indent=2) + '\n', 'utf8')
    notices(directory, frozen)
    pack_clock_page(main071, directory / 'Rainy75V2-0.71-更新与校频.html')
    (directory / '固件使用说明.md').write_text(
        '# 定制固件与恢复\n\n'
        '| 目录 | 用途 |\n|---|---|\n'
        '| main063beta1 | 0.63-beta1 键盘主控 |\n| main064 | 0.64 键盘主控 |\n'
        '| main071 | 0.71 键盘主控 V7.2 |\n| ipsBase | 桌宠与按键屏幕，亦用于核对屏幕芯片 |\n'
        '| ipsLyrics | 1024KiB／系列 13 屏幕使用的歌词固件 |\n\n'
        '手动写入时用仓库网页工作台，选择同一目录的 firmware.bin 和 manifest.json。'
        '从出厂状态装歌词时，先用 ipsBase 核对芯片，再写 ipsLyrics。'
        '桌宠素材、歌词字库和电脑后台请使用相应的一键安装包。\n\n'
        '0.71 键盘也可打开随附单文件网页，更新主控、校时或校频。'
        '恢复时使用对应出厂版本。键盘 IAP 是 0x3079、屏幕 IAP 是 0x3078；未知主控版本请先确认。\n\n'
        '[网页工作台与完整使用说明](https://github.com/xixiaotiam1219-lab/rainy75v2-tft)\n', 'utf8')
    package_zip(directory, output / 'rainy75v2-custom-firmware-and-recovery.zip')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', required=True, type=Path, help='Verified alpha.6 release directory')
    parser.add_argument('--main071', required=True, type=Path, help='0.71 patch, recovery image and model results')
    parser.add_argument('--out', required=True, type=Path, help='New output directory')
    args = parser.parse_args()
    verify_release_dir(args.public)
    firmware, restore = load_firmware(args.public, args.main071)
    font = (args.public / '固件与素材/FONT.BIN').read_bytes()
    if int.from_bytes(font[36:40], 'little') != firmware['ipsLyrics']['manifest']['fontBodyCrc']:
        raise ValueError('Packaged font does not match the lyrics image')
    args.out.mkdir(parents=True, exist_ok=False)
    write_firmware(args.out, args.public, args.main071, firmware, restore)
    for edition in EDITIONS:
        write_edition(args.out, args.public, firmware, font, edition)


if __name__ == '__main__':
    main()
