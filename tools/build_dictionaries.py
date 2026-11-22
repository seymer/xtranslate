#!/usr/bin/env python3
"""从 ECDICT 生成扩展内嵌的英汉精简词典。

用法：
  python3 tools/build_dictionaries.py /tmp/ecdict.csv

数据源：ECDICT https://github.com/skywind3000/ECDICT (MIT)
输出：data/en-zh.json（英文 -> 中文释义）
"""
import csv
import json
import sys
from pathlib import Path


def clean_translation(text):
    if not text:
        return ''
    lines = [line.strip() for line in text.replace('\\n', '\n').split('\n') if line.strip()]
    lines = [line for line in lines if not line.startswith('[网络]')][:3]
    return '\n'.join(lines)


def build_en_zh(src, dest, max_freq=20000, limit=24000):
    entries = {}
    with open(src, encoding='utf-8', newline='') as f:
        for row in csv.DictReader(f):
            word = (row.get('word') or '').strip()
            if not word or ' ' in word:
                continue
            frq = int(row.get('frq') or 0)
            bnc = int(row.get('bnc') or 0)
            if not ((0 < frq <= max_freq) or (0 < bnc <= max_freq)):
                continue
            trans = clean_translation(row.get('translation'))
            if not trans:
                continue
            entry = {'w': word, 't': trans}
            phonetic = (row.get('phonetic') or '').strip()
            if phonetic and len(phonetic) < 40:
                entry['p'] = phonetic
            freq = frq or bnc
            if freq:
                entry['f'] = freq
            entries[word.lower()] = entry
            if len(entries) >= limit:
                break
    dest.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8',
    )
    return len(entries)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    here = Path(__file__).resolve().parent.parent
    data_dir = here / 'data'
    data_dir.mkdir(exist_ok=True)
    count = build_en_zh(Path(sys.argv[1]), data_dir / 'en-zh.json')
    print(f'en-zh.json: {count} entries')


if __name__ == '__main__':
    main()
