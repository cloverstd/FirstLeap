#!/usr/bin/env python3
"""Prepare a pinned ECDICT snapshot as small, independently readable JSONL shards."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "third_party/ecdict/source.json"
FORM_LABELS = {
    "0": "原形", "3": "第三人称单数", "i": "现在分词", "p": "过去式",
    "d": "过去分词", "s": "复数", "r": "比较级", "t": "最高级",
}


def normalize(word):
    return " ".join(word.split())


def fold(word):
    # English case folding is deliberately ASCII so Python and Go hash identical keys.
    return word.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))


def shard(word):
    return hashlib.sha256(fold(normalize(word)).encode()).hexdigest()[:2]


def lines(value):
    return [line.strip() for line in value.replace("\\n", "\n").splitlines() if line.strip()]


def entry(row):
    word = normalize(row["word"])
    if not word or len(word) > 256:
        return None
    translations, definitions = lines(row["translation"]), lines(row["definition"])
    if not translations and not definitions:
        return None
    forms = []
    for item in row["exchange"].split("/"):
        code, _, value = item.partition(":")
        values = list(dict.fromkeys(v.strip() for v in value.split(",") if v.strip()))
        if code in FORM_LABELS and values:
            forms.append({"label": FORM_LABELS[code], "values": values})
    return {"word": word, "phonetic": row["phonetic"].strip(),
            "translations": translations, "definitions": definitions, "forms": forms}


def prepare(source, output, metadata):
    output = Path(output)
    if output.exists():
        raise ValueError("输出目录已存在，请选择新的目录，避免覆盖正在使用的词库")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".dictionary-", dir=output.parent) as temporary:
        stage = Path(temporary) / "ecdict"
        stage.mkdir()
        files = {}
        count = 0
        try:
            with Path(source).open(encoding="utf-8-sig", newline="") as stream:
                reader = csv.DictReader(stream)
                required = {"word", "phonetic", "translation", "definition", "exchange"}
                if not required.issubset(reader.fieldnames or []):
                    raise ValueError("词库 CSV 缺少必要字段")
                for row in reader:
                    data = entry(row)
                    if data is None:
                        continue
                    key = shard(data["word"])
                    if key not in files:
                        files[key] = (stage / (key + ".jsonl")).open("w", encoding="utf-8")
                    files[key].write(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
                    count += 1
        finally:
            for stream in files.values():
                stream.close()
        if not count:
            raise ValueError("词库没有有效词条")
        manifest = {**metadata, "format": 1, "entries": count}
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        shutil.copyfile(REPO / "third_party/ecdict/LICENSE", stage / "LICENSE")
        stage.rename(output)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="已下载的固定版本 ecdict.csv；仍校验 SHA-256")
    parser.add_argument("--output", type=Path, default=REPO / "data/dictionary/ecdict")
    args = parser.parse_args()
    metadata = json.loads(SOURCE.read_text())
    with tempfile.TemporaryDirectory(prefix="firstleap-dictionary-") as temporary:
        source = args.source or Path(temporary) / "ecdict.csv"
        if not args.source:
            for attempt in range(3):
                try:
                    request = urllib.request.Request(metadata["downloadURL"], headers={"User-Agent": "FirstLeapDictionaryBuilder/1.0"})
                    with urllib.request.urlopen(request, timeout=60) as response, source.open("wb") as stream:
                        shutil.copyfileobj(response, stream)
                    break
                except OSError:
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
        with source.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != metadata["sha256"]:
            raise ValueError("ECDICT 校验失败，请重新下载固定版本词库")
        count = prepare(source, args.output, metadata)
        print(f"ECDICT: prepared {count} entries in {args.output}")


if __name__ == "__main__":
    main()
