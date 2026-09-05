# Decode Flipper Zero .sub RAW captures of the Philips Civx remote.
#
#   python tools/decode_sub.py captures            # every .sub in a directory
#   python tools/decode_sub.py captures/civx_ww.sub
#
# A .sub RAW file is a flat list of signed durations: positive is a mark
# (carrier on), negative a space. The remote frames each press as
#
#   sync 7370us / 1090us,  then 41 bits, each one mark + one space:
#     bit 0 = 340us mark / 720us space   (short mark)
#     bit 1 = 720us mark / 330us space   (long mark)
#
# and repeats that five times. Recording with a manual start and stop leaves
# unrelated noise before and after the burst, so decoding keys off the sync mark
# rather than the start of the file, and takes the frame that repeats.

import sys
import os
import re
from collections import Counter

SYNC_MARK = 7370
SYNC_TOL = 1500       # the sync mark is unmistakable; nothing else is this long
BIT_SPLIT = 530       # halfway between a 340us and a 720us mark
FRAME_BITS = 41


def durations(path):
    out = []
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if line.startswith('RAW_Data:'):
                out.extend(int(v) for v in line.split(':', 1)[1].split())
    return out


def frames(values):
    """Every 41-bit frame that follows a sync mark."""
    found = []
    for i, v in enumerate(values):
        if not (v > 0 and abs(v - SYNC_MARK) <= SYNC_TOL):
            continue
        # The sync mark is followed by its space, then mark/space per bit.
        bits = []
        j = i + 2
        while j + 1 < len(values) and len(bits) < FRAME_BITS:
            mark, space = values[j], values[j + 1]
            if mark <= 0 or space >= 0:
                break
            bits.append('1' if mark > BIT_SPLIT else '0')
            j += 2
        if len(bits) == FRAME_BITS:
            found.append(''.join(bits))
    return found


def decode(path):
    found = frames(durations(path))
    if not found:
        return None, 0, 0
    # The transmitter sends five byte-identical repetitions, so the modal frame
    # is the frame. A capture whose repetitions disagree is not trustworthy.
    bits, count = Counter(found).most_common(1)[0]
    return bits, count, len(found)


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[2].strip('# '))
        return 1

    target = sys.argv[1]
    if os.path.isdir(target):
        paths = sorted(os.path.join(target, f) for f in os.listdir(target)
                       if f.lower().endswith('.sub'))
    else:
        paths = [target]

    if not paths:
        print(f'No .sub files in {target}')
        return 1

    bad = 0
    for path in paths:
        bits, count, total = decode(path)
        name = os.path.basename(path)
        if not bits:
            print(f'{name:24} no 41-bit frame found')
            bad += 1
            continue
        hexed = f'0x{int(bits, 2):010x}'
        warn = '' if count >= 2 else '   (single frame — unverified)'
        print(f'{name:24} {bits}  {hexed}{warn}')
        if count < 2:
            bad += 1

    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
