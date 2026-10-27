"""Bounded, local-only animation decoder. Binary stdin, JSON stdout; no files/URLs."""
import base64
import bisect
import io
import json
import math
import sys
import warnings

from PIL import Image, ImageDraw

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 4 * 1024 * 1024
MAX_TOTAL_PIXELS = 80 * 1024 * 1024
MAX_FRAMES = 400
SAMPLES = 9
TILE = 360
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter('error', Image.DecompressionBombWarning)


def decode(data):
    if not data or len(data) > MAX_BYTES:
        raise ValueError('bytes-limit')
    with Image.open(io.BytesIO(data), formats=['GIF', 'WEBP', 'PNG']) as im:
        width, height = im.size
        pixels = width * height
        if max(width, height) > 4096 or pixels > MAX_PIXELS:
            raise ValueError('dimensions-limit')
        # Sequential seek/load lets Pillow apply GIF disposal, partial updates and
        # alpha compositing. Never treat a GIF patch as a complete frame.
        durations = []
        default_image = bool(im.info.get('default_image', False))
        loop = im.info.get('loop')
        offset = 1 if default_image else 0
        index = offset
        while True:
            try:
                im.seek(index)
            except EOFError:
                break
            if len(durations) >= MAX_FRAMES or (len(durations) + 1) * pixels > MAX_TOTAL_PIXELS:
                raise ValueError('frames-limit')
            im.load()
            duration = float(im.info.get('duration', 100) or 100)
            if not math.isfinite(duration) or duration < 0:
                raise ValueError('bad-duration')
            durations.append(max(20, duration))
            index += 1
        if len(durations) <= 1:
            return {'status': 'static'}
        total = sum(durations)
        starts = [0.0]
        for duration in durations[:-1]:
            starts.append(starts[-1] + duration)
        count = min(SAMPLES, len(durations))
        chosen = {0, len(durations) - 1}
        for n in range(count):
            chosen.add(min(len(durations) - 1, bisect.bisect_right(starts, (total - 1) * n / (count - 1)) - 1))
        # Long holds can collapse time samples onto one frame. Fill the largest
        # remaining index gaps so short intermediate transitions still get a look.
        while len(chosen) < count:
            remaining = (i for i in range(len(durations)) if i not in chosen)
            chosen.add(max(remaining, key=lambda i: min(abs(i - j) for j in chosen)))
        chosen = sorted(chosen)
        cols = min(3, count)
        rows = math.ceil(count / cols)
        sheet = Image.new('RGB', (cols * TILE, rows * (TILE + 28)), '#eeeeee')
        draw = ImageDraw.Draw(sheet)
        for cell, frame in enumerate(chosen):
            im.seek(frame + offset)
            rgba = im.convert('RGBA')
            scale = min((TILE - 8) / rgba.width, (TILE - 8) / rgba.height)
            rgba = rgba.resize((max(1, round(rgba.width * scale)), max(1, round(rgba.height * scale))), Image.Resampling.LANCZOS)
            left = (cell % cols) * TILE
            top = (cell // cols) * (TILE + 28)
            sheet.paste(rgba, (left + (TILE - rgba.width) // 2, top + 28 + (TILE - rgba.height) // 2), rgba)
            draw.text((left + 8, top + 4), f'{cell + 1} | {starts[frame] / 1000:.2f}s', fill='black', font_size=18)
        output = io.BytesIO()
        sheet.save(output, format='PNG')
        if output.tell() > 4 * 1024 * 1024:
            raise ValueError('output-limit')
        return {'status': 'animated', 'frames': len(durations), 'durationMs': total,
                'loop': loop, 'sampleFrames': chosen, 'timesMs': [starts[i] for i in chosen],
                'url': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii')}


if __name__ == '__main__':
    try:
        result = decode(sys.stdin.buffer.read(MAX_BYTES + 1))
    except Exception:
        # Do not emit media, arbitrary file metadata, or decoder tracebacks.
        result = {'status': 'failed'}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
