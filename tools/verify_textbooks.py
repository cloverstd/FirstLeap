#!/usr/bin/env python3
"""Validate complete textbook delivery without importing speech models."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import math
from pathlib import Path
import re
import subprocess


def validate(root, decode=False, require_translations=False):
    errors, warnings = [], []
    counts = Counter()
    pronunciation_ids = set()
    for book, expected in [
        (1, list(range(1, 144, 2))),
        (2, list(range(1, 97))),
        (3, list(range(1, 61))),
        (4, list(range(1, 49))),
    ]:
        path = root / f"book{book}/index.json"
        if not path.exists():
            errors.append(f"book{book}: missing index")
            continue
        index = json.loads(path.read_text())
        if [lesson["lesson"] for lesson in index["lessons"]] != expected:
            errors.append(f"book{book}: wrong lesson sequence")
        for number in expected:
            path = root / f"book{book}/{number:03d}.json"
            if not path.exists():
                errors.append(f"book{book}:{number}: missing lesson")
                continue
            lesson = json.loads(path.read_text())
            prefix = f"{book}:{number}"
            counts["lessons"] += 1
            counts[f"book{book}"] += 1
            if lesson["alignment"] != "ready":
                errors.append(f"{prefix}: alignment {lesson['alignment']}")
            if not lesson["translation"] or not lesson["vocabulary"]:
                errors.append(f"{prefix}: missing translation or vocabulary")
            sentences = [s for p in lesson["paragraphs"] for s in p["sentences"]]
            if not sentences:
                errors.append(f"{prefix}: empty body")
            previous_end = 0
            seen = set()
            for sentence in sentences:
                counts["sentences"] += 1
                if isinstance(sentence.get("translationZh"), str) and sentence["translationZh"].strip():
                    counts["sentenceTranslations"] += 1
                elif require_translations:
                    errors.append(f"{prefix}/{sentence['id']}: missing sentence translation")
                start, end = sentence["start"], sentence["end"]
                if not valid_range(start, end, lesson["duration"]):
                    errors.append(f"{prefix}/{sentence['id']}: invalid sentence range")
                    continue
                if start < previous_end - 0.001:
                    warnings.append(
                        f"{prefix}/{sentence['id']}: sentence margins overlap"
                    )
                previous_end = end
                previous_word = start
                for word in sentence["words"]:
                    if word["id"] in seen:
                        errors.append(f"{prefix}: duplicate word id {word['id']}")
                    seen.add(word["id"])
                    if not re.search(r"[\w]", word["text"], re.UNICODE):
                        continue
                    counts["words"] += 1
                    if not valid_range(word["start"], word["end"], lesson["duration"]):
                        errors.append(
                            f"{prefix}/{word['id']}: missing word time ({word['text']})"
                        )
                        continue
                    if (
                        word["start"] < previous_word - 0.001
                        or word["start"] < start - 0.001
                        or word["end"] > end + 0.001
                    ):
                        errors.append(
                            f"{prefix}/{word['id']}: word outside sentence order"
                        )
                    previous_word = word["end"]
            for word in lesson["vocabulary"]:
                counts["vocabularyEntries"] += 1
                ident = word["pronunciationId"]
                pronunciation_ids.add(ident)
                path = root / "pronunciations" / f"{ident}.mp3"
                if not path.is_file() or path.stat().st_size == 0:
                    errors.append(f"{prefix}: missing pronunciation {word['word']}")
    counts["pronunciations"] = len(pronunciation_ids)
    if decode:

        def probe(ident):
            path = root / "pronunciations" / f"{ident}.mp3"
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=nw=1:nk=1",
                    str(path),
                ],
                capture_output=True,
                text=True,
            )
            try:
                duration = float(result.stdout)
            except ValueError:
                duration = 0
            return ident if result.returncode or duration <= 0 else None

        with ThreadPoolExecutor(max_workers=4) as pool:
            errors.extend(
                f"corrupt pronunciation: {ident}"
                for ident in pool.map(probe, pronunciation_ids)
                if ident
            )
    return {"counts": dict(counts), "errors": errors, "warnings": warnings}


def valid_range(start, end, duration):
    return (
        isinstance(start, (int, float))
        and isinstance(end, (int, float))
        and math.isfinite(start)
        and math.isfinite(end)
        and 0 <= start < end <= duration
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data"))
    parser.add_argument(
        "--decode",
        action="store_true",
        help="Also probe every generated vocabulary MP3",
    )
    parser.add_argument("--require-sentence-translations", action="store_true")
    args = parser.parse_args()
    report = validate(args.data / "textbooks/library", args.decode, args.require_sentence_translations)
    target = args.data / "textbooks/library/reports/validation.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {
                "counts": report["counts"],
                "errors": len(report["errors"]),
                "warnings": len(report["warnings"]),
            },
            ensure_ascii=False,
        )
    )
    raise SystemExit(bool(report["errors"]))
