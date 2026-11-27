"""Bundle a locally built and modeled 0.71 clock update. SPDX-License-Identifier: MIT."""
import argparse
import base64
import gzip
import json
from pathlib import Path

from release import ROOT, bundle_html, sha256_bytes, verify_release_html

STOCK_SHA = 'c9ecade81300d083e3a067498e67401dd323668b76c26450ad23f758394ccbd4'


def image_entry(folder, filename):
    manifest = json.loads((folder / 'manifest.json').read_text('utf8'))
    image = (folder / filename).read_bytes()
    if (manifest['target'], manifest['stockSha256'], manifest['applicationBase'], manifest['iapPid'], len(image)) != (
        'main', STOCK_SHA, 0x2000, 0x3079, 294912
    ) or manifest['sha256'] != sha256_bytes(image) or manifest['bytes'] != len(image):
        raise ValueError('Wrong 0.71 image or manifest')
    return {'manifest': manifest, 'gzip': base64.b64encode(gzip.compress(image, mtime=0)).decode('ascii')}


def pack_clock_page(build, out, measured_rate=None):
    patched = image_entry(build / 'main', 'rainy75v2-main.bin')
    restore = image_entry(build / 'main-restore', 'rainy75v2-main-restore.bin')
    model = json.loads((build / 'main/model-validation.json').read_text('utf8'))
    if not model['passed'] or model['stockVersion'] != '0.71' or model['sha256'] != patched['manifest']['sha256']:
        raise ValueError('The matching 0.71 model check must pass before bundling')
    raw = bundle_html(ROOT / 'web/clock071.html')
    bundle = {'patched': patched, 'restore': restore}
    if measured_rate:
        rate = json.loads(measured_rate.read_text('utf8'))['rateMilliHz']
        if type(rate) is not int or not 30000000 <= rate <= 40000000:
            raise ValueError('Invalid measured millihertz rate')
        bundle['measuredRate'] = rate
    payload = json.dumps(bundle, separators=(',', ':'))
    start = raw.index('<script type="module">')
    page = raw[:start] + '<script type="application/json" id="clock-firmware">' + payload + '</script>\n' + raw[start:]
    verify_release_html(page, require_bundle_payload=False)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, 'utf8', newline='\n')
    print(out.resolve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--measured-rate', type=Path, help='Optional private calibration result to preload for this keyboard')
    args = parser.parse_args()
    pack_clock_page(args.build, args.out, args.measured_rate)


if __name__ == '__main__':
    main()
