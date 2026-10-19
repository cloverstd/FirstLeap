#!/usr/bin/env python3
"""Build resumable, per-lesson reading data from read-only NCE JSON + LRC + MP3.

The alignment-only WhisperX API is used: no ASR or speaker model is required.
Generated files live outside source control. See README for CPU installation.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import re
import subprocess
import unicodedata

VERSION = "textbooks-v3"
ALIGN_MODEL = ALIGN_METADATA = None
SPEAKER = re.compile(r"^([A-Z][A-Z .’'\-]{1,30})\s*[:：]\s*")
WORD = re.compile(r"\S+")
CORRECTIONS = {
    "beyond It is difficult": "beyond. It is difficult",
    "Islandscame": "Islands came",
    "5, 000": "5,000",
    "2, 000": "2,000",
    "3, 000": "3,000",
    "2, 250, 000": "2,250,000",
    "6, 000, 000": "6,000,000",
}


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    temporary.replace(path)


def normalize(text):
    text = unicodedata.normalize("NFKD", text.replace("’", "'"))
    return re.findall(
        r"[a-z]+(?:'[a-z]+)?|\d+", text.encode("ascii", "ignore").decode().lower()
    )


def corrected(text):
    for before, after in CORRECTIONS.items():
        text = text.replace(before, after)
    return re.sub(r"(?<=\d),\s+(?=\d{3}\b)", ",", text)


PHONEMES = {
    ("excuse", "v."): "ɛkskjˈuz",
    ("present", "v."): "pɹɪzˈɛnt",
    ("present", "n."): "pɹˈɛzənt",
    ("present", "adj."): "pɹˈɛzənt",
    ("wind", "v."): "wˈaɪnd",
    ("close", "adj."): "klˈOs",
    ("bow", "v."): "bˈaʊ",
    ("conduct", "v."): "kəndˈʌkt",
    ("content", "adj."): "kəntˈɛnt",
    ("desert", "v."): "dɪzˈɜɹt",
    ("entrance", "n."): "ˈɛntɹəns",
    ("increase", "v."): "ɪnkɹˈis",
    ("live", "v."): "lˈɪv",
    ("minute", "n."): "mˈɪnɪt",
    ("object", "v."): "əbdʒˈɛkt",
    ("produce", "v."): "pɹədˈus",
    ("progress", "v."): "pɹəɡɹˈɛs",
    ("record", "n."): "ɹˈɛkəɹd",
    ("refuse", "v."): "ɹɪfjˈuz",
    ("subject", "n."): "sˈʌbdʒɪkt",
    ("convert", "v."): "kənvˈɜɹt",
    ("suspect", "v."): "səspˈɛkt",
    ("transport", "v."): "tɹænspˈɔɹt",
    ("proceeds", "n."): "pɹˈOsidz",
    ("survey", "n."): "sˈɜɹvA",
    ("upset", "adj."): "ʌpsˈɛt",
    ("row", "v."): "ɹˈO",
}


def lesson_overrides(overrides, book, number):
    specific = overrides.get("lessons", {}).get(f"{book}:{number}", {})
    if overrides.get("pronunciations"):
        specific = dict(
            specific,
            pronunciations={
                **overrides["pronunciations"],
                **specific.get("pronunciations", {}),
            },
        )
    return specific


def phonemes_for(word, pos, overrides):
    return overrides.get(f"{word}|{pos}", PHONEMES.get((word.lower(), pos), ""))


def pronunciation_id(word, pos, phonemes=""):
    phonemes = phonemes or phonemes_for(word, pos, {})
    return hashlib.sha256(
        f"kokoro-v1:af_heart:{word.strip().lower()}:{pos}:{phonemes}".encode()
    ).hexdigest()[:24]


def make_lesson(book, source, track, overrides):
    """Use monotonic transcript matches, so repeated titles never steal body audio.

    Source paragraphs/speakers provide structure; the spoken transcript provides
    the readable wording. Every difference is exported for editorial review.
    Unspoken source notes are kept separately and never acquire timestamps.
    """
    no = source["lesson"]
    paragraphs, source_tokens, source_locations = [], [], []
    for i, raw in enumerate(source["passage"]):
        match = SPEAKER.match(raw)
        speaker = match[1] if match else ""
        text = raw[match.end() :] if match else raw
        if book == 3 and no == 7:
            text = text.replace(
                "did note in your back pocket? When you rescued your trousers, did ",
                "did ",
            )
            text = text.split("Damaged bank notes.")[0].rstrip()
        paragraphs.append(
            {"id": f"p{i}", "speaker": speaker, "sentences": [], "source": text}
        )
        tokens = normalize(text)
        source_tokens.extend(tokens)
        source_locations.extend([i] * len(tokens))
    sentences = [dict(s, text=corrected(s["text"])) for s in track["sentences"]]
    audio_tokens, audio_locations = [], []
    for i, sentence in enumerate(sentences):
        tokens = normalize(sentence["text"])
        audio_tokens.extend(tokens)
        audio_locations.extend([i] * len(tokens))
    matcher = difflib.SequenceMatcher(None, source_tokens, audio_tokens, autojunk=False)
    votes = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            p = source_locations[block.a + offset]
            s = audio_locations[block.b + offset]
            votes.setdefault(s, []).append(p)
    # Body matches form a contiguous suffix after lesson/title/instruction/question.
    # A per-lesson override handles genuinely different transcript editions.
    body_start = overrides.get("bodyStart")
    if body_start is None:
        body_start = min(votes) if votes else len(sentences)
        # Do not let an early partial word match pull a spoken question or the
        # listening instructions into the article (notably book 1, lesson 55).
        question_tokens = normalize(source.get("question", ""))
        for i, sentence in enumerate(sentences[:8]):
            text = sentence["text"]
            is_instruction = text.lower().startswith(
                ("listen to the tape", "first listen and then")
            )
            is_question = (
                bool(question_tokens)
                and difflib.SequenceMatcher(
                    None, question_tokens, normalize(text), autojunk=False
                ).ratio()
                >= 0.85
            )
            if is_instruction or is_question:
                body_start = max(body_start, i + 1)
        # Lesson/unit labels cannot be spoken body prose.
        while body_start < len(sentences) and re.match(
            r"^(Lesson|Unit)\s+\d+", sentences[body_start]["text"], re.I
        ):
            body_start += 1
    last_paragraph = 0
    for i, raw in enumerate(sentences):
        if i < body_start:
            continue
        counts = votes.get(i, [])
        p = max(set(counts), key=counts.count) if counts else last_paragraph
        p = max(last_paragraph, p)
        last_paragraph = p
        text = overrides.get("sentences", {}).get(str(i), raw["text"])
        ident = f"s{i}"
        words = []
        previous = 0
        for j, match in enumerate(WORD.finditer(text)):
            words.append(
                {
                    "id": f"{ident}-w{j}",
                    "text": match.group(),
                    "before": text[previous : match.start()],
                    "start": None,
                    "end": None,
                }
            )
            previous = match.end()
        paragraphs[p]["sentences"].append(
            {
                "id": ident,
                "text": text,
                "start": raw["start"],
                "end": raw["end"],
                "words": words,
            }
        )
    differences = []
    for p in paragraphs:
        spoken = " ".join(s["text"] for s in p["sentences"])
        if normalize(spoken) != normalize(p["source"]):
            differences.append(
                {"paragraph": p["id"], "source": p["source"], "spoken": spoken}
            )
        if not p["sentences"]:
            p["note"] = p["source"]
        del p["source"]
    vocabulary = []
    for i, item in enumerate(source["vocabulary"]):
        phonemes = phonemes_for(
            item["word"], item["pos"], overrides.get("pronunciations", {})
        )
        vocabulary.append(
            {
                "id": f"v{i}",
                "word": item["word"],
                "pos": item["pos"],
                "meaning": item["meaning"],
                "pronunciationId": pronunciation_id(
                    item["word"], item["pos"], phonemes
                ),
                "phonemes": phonemes,
                "ready": False,
            }
        )
    return {
        "book": book,
        "lesson": no,
        "label": f"Lesson {no} & {no + 1}" if book == 1 else f"Lesson {no}",
        "titleEn": source["title_en"],
        "titleZh": source["title_zh"],
        "instruction": source.get("instruction", ""),
        "instructionZh": source.get("instruction_zh", ""),
        "question": source.get("question", ""),
        "paragraphs": paragraphs,
        "vocabulary": vocabulary,
        "translation": source["translation"],
        "duration": track["duration"],
        "alignment": "pending",
        "revision": "",
    }, differences


def spoken_form(token):
    from num2words import num2words

    text = (
        unicodedata.normalize("NFKD", token.replace("’", "'"))
        .encode("ascii", "ignore")
        .decode()
    )
    abbreviations = {"mr.": "mister", "mrs.": "missus", "dr.": "doctor", "st.": "saint"}
    if text.lower() in abbreviations:
        return abbreviations[text.lower()]

    def number(match):
        value = match.group().replace(",", "")
        try:
            return (
                num2words(float(value) if "." in value else int(value))
                .replace("-", " ")
                .replace(",", "")
            )
        except (ValueError, OverflowError):
            return value

    text = re.sub(r"\d[\d,]*(?:\.\d+)?", number, text)
    return " ".join(re.findall(r"[a-z]+(?:'[a-z]+)?", text.lower()))


def align_lesson(lesson, path, model, metadata, device, timing_overrides):
    import numpy as np
    from whisperx.alignment import align

    audio = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-",
        ]
    )
    audio = np.frombuffer(audio, dtype=np.float32).copy()
    issues = []
    for paragraph in lesson["paragraphs"]:
        for sentence in paragraph["sentences"]:
            forms = [spoken_form(w["text"]) for w in sentence["words"]]
            transcript = " ".join(forms)
            if not transcript:
                continue
            output = align(
                [
                    {
                        "start": sentence["start"],
                        "end": sentence["end"],
                        "text": transcript,
                    }
                ],
                model,
                metadata,
                audio,
                device,
                interpolate_method="ignore",
            )
            aligned = [w for s in output["segments"] for w in s.get("words", [])]
            cursor = 0
            for word, form in zip(sentence["words"], forms):
                count = len(form.split())
                group = aligned[cursor : cursor + count]
                cursor += count
                valid = [
                    w
                    for w in group
                    if isinstance(w.get("start"), (float, int))
                    and isinstance(w.get("end"), (float, int))
                    and w["end"] > w["start"]
                ]
                if count and len(valid) == count:
                    word["start"] = round(min(w["start"] for w in valid), 3)
                    word["end"] = round(max(w["end"] for w in valid), 3)
                if word["id"] in timing_overrides:
                    word["start"], word["end"] = timing_overrides[word["id"]]
                if count and word["start"] is None:
                    issues.append(
                        {
                            "word": word["id"],
                            "text": word["text"],
                            "reason": "no reliable alignment",
                        }
                    )
            timed = [w for w in sentence["words"] if w["start"] is not None]
            if timed:
                sentence["start"] = max(0, round(timed[0]["start"] - 0.025, 3))
                sentence["end"] = min(
                    lesson["duration"], round(timed[-1]["end"] + 0.1, 3)
                )
            if sentence["id"] in timing_overrides:
                sentence["start"], sentence["end"] = timing_overrides[sentence["id"]]
    lesson["alignment"] = "ready" if not issues else "partial"
    return issues


def alignment_task(task):
    lesson, audio_path, device, timings, path, report_path, differences = task
    issues = align_lesson(
        lesson, audio_path, ALIGN_MODEL, ALIGN_METADATA, device, timings
    )
    atomic_json(path, lesson)
    atomic_json(report_path, {"differences": differences, "alignmentIssues": issues})
    print(
        f"book{lesson['book']} lesson{lesson['lesson']}: {lesson['alignment']} ({len(issues)} issues)",
        flush=True,
    )
    # Return unused activation pages between tracks on memory-limited CPU hosts.
    import ctypes
    import gc

    gc.collect()
    try:
        ctypes.CDLL(None).malloc_trim(0)
    except AttributeError:
        pass
    return lesson["book"], lesson["lesson"]


def alignment_worker_init():
    import faulthandler
    import signal

    faulthandler.register(signal.SIGUSR1)


def generate_pronunciations(
    root, lessons, overrides, onnx_model=None, onnx_voices=None, shard="0/1"
):
    import numpy as np
    import torch
    from kokoro import KPipeline

    torch.set_num_threads(1)
    torch.backends.nnpack.set_flags(False)
    pipeline = None
    engine = None
    output = root / "pronunciations"
    output.mkdir(parents=True, exist_ok=True)
    words = {v["pronunciationId"]: v for l in lessons for v in l["vocabulary"]}
    shard_index, shard_count = map(int, shard.split("/"))
    words = {
        key: value
        for i, (key, value) in enumerate(words.items())
        if i % shard_count == shard_index
    }
    failures = []
    for i, (ident, item) in enumerate(words.items()):
        target = output / f"{ident}.mp3"
        if target.exists() and target.stat().st_size:
            continue
        if pipeline is None:
            pipeline = KPipeline(
                lang_code="a",
                repo_id="hexgrad/Kokoro-82M",
                device="cpu",
                model=False if onnx_model else None,
            )
            if onnx_model:
                import onnxruntime as ort
                from kokoro_onnx import Kokoro

                options = ort.SessionOptions()
                options.intra_op_num_threads = options.inter_op_num_threads = 1
                engine = Kokoro.from_session(
                    ort.InferenceSession(
                        str(onnx_model),
                        sess_options=options,
                        providers=["CPUExecutionProvider"],
                    ),
                    str(onnx_voices),
                )
        text = item["word"]
        # POS-specific heteronyms are explicit, not inferred from an isolated word.
        phonemes = item.get("phonemes") or phonemes_for(
            text, item["pos"], overrides.get("pronunciations", {})
        )
        if phonemes:
            text = f"[{text}](/{phonemes}/)"
        try:
            if engine:
                phones, _ = pipeline.g2p(text)
                samples, _ = engine.create(phones, "af_heart", is_phonemes=True)
                chunks = [np.asarray(samples, dtype=np.float32)]
            else:
                chunks = [
                    np.asarray(audio, dtype=np.float32)
                    for _, _, audio in pipeline(text, voice="af_heart", speed=1)
                ]
            if not chunks:
                raise ValueError("empty speech")
            samples = np.concatenate(chunks)
            if (
                not samples.size
                or not np.isfinite(samples).all()
                or np.max(np.abs(samples)) < 1e-5
            ):
                raise ValueError("empty or silent speech")
            temporary = target.with_suffix(".tmp.mp3")
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "f32le",
                    "-ar",
                    "24000",
                    "-ac",
                    "1",
                    "-i",
                    "-",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "64k",
                    "-y",
                    str(temporary),
                ],
                input=samples.tobytes(),
                check=True,
            )
            temporary.replace(target)
        except Exception as exc:
            failures.append({"word": item["word"], "error": str(exc)})
        if i % 50 == 0:
            print(f"pronunciations {i + 1}/{len(words)}", flush=True)
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--data", default=Path("data"), type=Path)
    parser.add_argument("--books", default="1,2,3,4")
    parser.add_argument("--lesson", type=int)
    parser.add_argument("--align", action="store_true")
    parser.add_argument("--pronunciations", action="store_true")
    parser.add_argument(
        "--pronunciations-only",
        action="store_true",
        help="Generate speech from existing manifests without rewriting alignment data",
    )
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", default=2, type=int)
    parser.add_argument("--retry-partial", action="store_true")
    parser.add_argument(
        "--workers",
        default=1,
        type=int,
        help="CPU alignment workers; Linux fork shares read-only model weights",
    )
    parser.add_argument("--tts-onnx-model", type=Path)
    parser.add_argument("--tts-onnx-voices", type=Path)
    parser.add_argument("--pronunciation-shard", default="0/1")
    parser.add_argument(
        "--overrides",
        type=Path,
        default=Path(__file__).with_name("textbook_overrides.json"),
    )
    args = parser.parse_args()
    if bool(args.tts_onnx_model) != bool(args.tts_onnx_voices):
        parser.error("ONNX model and voice files must be supplied together")
    if args.workers < 1 or args.threads < 1:
        parser.error("workers and threads must be positive")
    if args.workers > 1 and args.device != "cpu":
        parser.error("parallel alignment is CPU-only")
    try:
        shard_index, shard_count = map(int, args.pronunciation_shard.split("/"))
        if not 0 <= shard_index < shard_count:
            raise ValueError()
    except ValueError:
        parser.error("pronunciation shard must be zero-based index/count, e.g. 0/2")
    if args.data.resolve().is_relative_to(args.source.resolve()):
        parser.error("output data directory must be outside the read-only source")
    output = args.data / "textbooks/library"
    output.mkdir(parents=True, exist_ok=True)
    overrides = read(args.overrides) if args.overrides.exists() else {}
    if args.pronunciations_only:
        lessons = [
            read(path)
            for path in sorted(output.glob("book*/*.json"))
            if path.name != "index.json"
        ]
        failures = generate_pronunciations(
            output,
            lessons,
            overrides,
            args.tts_onnx_model,
            args.tts_onnx_voices,
            args.pronunciation_shard,
        )
        atomic_json(output / f"reports/pronunciations-{shard_index}.json", failures)
        if failures:
            raise SystemExit(f"{len(failures)} pronunciations failed; rerun to retry")
        return
    model = metadata = None
    if args.align:
        global ALIGN_MODEL, ALIGN_METADATA
        import torch
        from whisperx.alignment import load_align_model

        torch.set_num_threads(max(1, args.threads))
        torch.backends.nnpack.set_flags(False)
        model, metadata = load_align_model(
            "en", args.device, model_name="facebook/wav2vec2-base-960h"
        )
        ALIGN_MODEL, ALIGN_METADATA = model, metadata
    generated = []
    pending = []
    for book in map(int, args.books.split(",")):
        if book not in (1, 2, 3, 4):
            parser.error("book must be 1–4")
        source = read(args.source / f"data/book{book}.json")
        tracks = {
            t["lessons"][0]: t
            for t in read(args.source / f"audio/book{book}/index.json")["tracks"]
        }
        summaries = []
        for raw in source["lessons"]:
            no = raw["lesson"]
            path = output / f"book{book}/{no:03d}.json"
            track = tracks[no]
            specific = lesson_overrides(overrides, book, no)
            lesson, differences = make_lesson(book, raw, track, specific)
            audio_path = args.source / "audio" / track["file"]
            stat = audio_path.stat()
            revision = hashlib.sha256(
                json.dumps(
                    [
                        VERSION,
                        raw,
                        track,
                        specific,
                        overrides.get("timings", {}).get(f"{book}:{no}", {}),
                        stat.st_size,
                        stat.st_mtime_ns,
                    ],
                    sort_keys=True,
                    ensure_ascii=False,
                ).encode()
            ).hexdigest()[:24]
            previous = read(path) if path.exists() else None
            selected = args.lesson is None or args.lesson == no
            if previous and previous["revision"] == revision:
                previous["vocabulary"] = lesson["vocabulary"]
                lesson = previous
            if (
                selected
                and args.align
                and (
                    lesson["alignment"] == "pending"
                    or (args.retry_partial and lesson["alignment"] == "partial")
                    or not previous
                    or previous["revision"] != revision
                )
            ):
                if args.workers > 1:
                    pending.append(
                        (
                            lesson,
                            audio_path,
                            args.device,
                            overrides.get("timings", {}).get(f"{book}:{no}", {}),
                            path,
                            output / f"reports/{book}-{no:03d}.json",
                            differences,
                        )
                    )
                else:
                    issues = align_lesson(
                        lesson,
                        audio_path,
                        model,
                        metadata,
                        args.device,
                        overrides.get("timings", {}).get(f"{book}:{no}", {}),
                    )
                    atomic_json(
                        output / f"reports/{book}-{no:03d}.json",
                        {"differences": differences, "alignmentIssues": issues},
                    )
                    print(
                        f"book{book} lesson{no}: {lesson['alignment']} ({len(issues)} issues)",
                        flush=True,
                    )
            elif not previous:
                atomic_json(
                    output / f"reports/{book}-{no:03d}.json",
                    {"differences": differences, "alignmentIssues": []},
                )
            lesson["revision"] = revision
            atomic_json(path, lesson)
            generated.append(lesson)
            summaries.append(
                {
                    k: lesson[k]
                    for k in (
                        "lesson",
                        "label",
                        "titleEn",
                        "titleZh",
                        "duration",
                        "alignment",
                    )
                }
            )
        atomic_json(
            output / f"book{book}/index.json",
            {
                "book": book,
                "name": source["name"],
                "subtitleEn": source["subtitle_en"],
                "lessonCount": len(summaries),
                "available": True,
                "lessons": summaries,
                "downloads": [],
            },
        )
    if pending:
        if args.device != "cpu":
            parser.error("parallel alignment is CPU-only")
        # Unlike multiprocessing.Pool, the executor reports a lost worker rather
        # than waiting forever for a result after an OS-level termination.
        with ProcessPoolExecutor(
            max_workers=args.workers,
            mp_context=multiprocessing.get_context("fork"),
            initializer=alignment_worker_init,
        ) as pool:
            list(pool.map(alignment_task, pending, chunksize=1))
        for book in map(int, args.books.split(",")):
            index_path = output / f"book{book}/index.json"
            index = read(index_path)
            for summary in index["lessons"]:
                summary["alignment"] = read(
                    output / f"book{book}/{summary['lesson']:03d}.json"
                )["alignment"]
            atomic_json(index_path, index)
        generated = [
            read(output / f"book{l['book']}/{l['lesson']:03d}.json") for l in generated
        ]
    if args.pronunciations:
        failures = generate_pronunciations(
            output,
            [l for l in generated if args.lesson is None or l["lesson"] == args.lesson],
            overrides,
            args.tts_onnx_model,
            args.tts_onnx_voices,
            args.pronunciation_shard,
        )
        atomic_json(output / "reports/pronunciations.json", failures)
        if failures:
            raise SystemExit(f"{len(failures)} pronunciations failed; rerun to retry")
    print(f"Prepared {len(generated)} lesson manifests in {output}", flush=True)


if __name__ == "__main__":
    main()
