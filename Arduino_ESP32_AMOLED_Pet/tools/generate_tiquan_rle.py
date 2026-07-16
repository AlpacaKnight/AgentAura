"""Convert the v2 pet atlas to RGB565 RLE frames used by the firmware."""
from pathlib import Path
from PIL import Image
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/pets/tiquan-v2/spritesheet.webp"
OUTPUT = ROOT / "data/pets/tiquan-v2/sprites.rle"
HEADER = ROOT / "src/ui/tiquan_v2_frames.h"
WIDTH, HEIGHT = 192, 208
FRAME_COUNTS = (7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8)
BACKGROUND = (0x1A, 0x1A, 0x2E)


def rgb565(red, green, blue):
    return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)


def encode(frame):
    pixels = []
    for red, green, blue, alpha in frame.convert("RGBA").getdata():
        if alpha < 128:
            red, green, blue = BACKGROUND
        pixels.append(rgb565(red, green, blue))
    encoded = bytearray()
    start = 0
    while start < len(pixels):
        color = pixels[start]
        end = start + 1
        while end < len(pixels) and pixels[end] == color and end - start < 65535:
            end += 1
        encoded += struct.pack("<HH", end - start, color)
        start = end
    return encoded


def main():
    atlas = Image.open(SOURCE).convert("RGBA")
    if atlas.size != (WIDTH * 8, HEIGHT * 11):
        raise ValueError(f"unexpected atlas size: {atlas.size}")
    data = bytearray()
    offsets = []
    for row, count in enumerate(FRAME_COUNTS):
        row_offsets = []
        for col in range(count):
            frame = atlas.crop((col * WIDTH, row * HEIGHT,
                                (col + 1) * WIDTH, (row + 1) * HEIGHT))
            row_offsets.append((len(data), len(encode(frame))))
            data += encode(frame)
        offsets.append(row_offsets)
    OUTPUT.write_bytes(data)
    lines = ["#pragma once", "#include <Arduino.h>", "",
             "#define TIQUAN_FRAME_WIDTH 192", "#define TIQUAN_FRAME_HEIGHT 208",
             "#define TIQUAN_FRAME_BYTES (TIQUAN_FRAME_WIDTH * TIQUAN_FRAME_HEIGHT * 2)",
             "#define TIQUAN_ANIMATION_COUNT 11", "",
             "struct TiquanFrameIndex { uint32_t offset; uint32_t length; };",
             f"static const uint8_t tiquan_frame_counts[TIQUAN_ANIMATION_COUNT] = {{{', '.join(map(str, FRAME_COUNTS))}}};",
             "static const TiquanFrameIndex tiquan_frame_index[TIQUAN_ANIMATION_COUNT][8] = {"]
    for row in offsets:
        cells = [f"{{{offset}, {length}}}" for offset, length in row]
        cells.extend(["{0, 0}"] * (8 - len(cells)))
        lines.append("  {" + ", ".join(cells) + "},")
    lines.append("};")
    HEADER.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT}: {len(data)} bytes")


if __name__ == "__main__":
    main()
