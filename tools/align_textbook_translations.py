#!/usr/bin/env python3
"""Offline, monotonic bilingual alignment of the existing textbook translation.

Optional preparation tool only. The website never loads this model. Review the
low-confidence report and edit the generated maps before importing translations.
"""
import argparse
import json
import math
from pathlib import Path
import re


def split_chinese(paragraphs, strip_speakers=False):
    # Preserve punctuation and numerical commas; splitting is only a candidate
    # boundary. The semantic aligner can join multiple clauses back together.
    if strip_speakers:
        paragraphs = [re.sub(r"^[\u4e00-\u9fff \t·.]{1,14}[:：]\s*", "", p) for p in paragraphs]
    text = "\n".join(paragraphs)
    parts = re.split(r"(?<=[。！？!?；;，：、])|(?<!\d),(?!\d)|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def align(english, chinese, embeddings):
    import numpy as np
    n, m = len(english), len(chinese)
    if not n: return []
    if not m: return [("", 0.0)] * n
    en = np.array([embeddings[t] for t in english])
    zh = np.array([embeddings[t] for t in chinese])
    # Weighted pooling provides candidates without re-encoding every possible
    # clause combination. Dynamic programming preserves the original order.
    weights = np.array([max(1, len(re.findall(r'[\u4e00-\u9fff]', t))) ** .5 for t in chinese])
    cumulative = np.vstack([np.zeros(zh.shape[1]), np.cumsum(zh * weights[:, None], axis=0)])
    lengths = np.array([max(1, len(t.split())) for t in english])
    ratio = sum(len(t) for t in chinese) / max(1, sum(lengths))
    dp = np.full((n + 1, m + 1), -1e9)
    back = {}; dp[0, 0] = 0
    for i in range(n):
        for j in range(m + 1):
            if dp[i, j] < -1e8: continue
            # An omitted or merged source translation is reported for editorial
            # completion instead of stealing an unrelated neighbouring sentence.
            if dp[i, j] - .65 > dp[i + 1, j]:
                dp[i + 1, j] = dp[i, j] - .65; back[i + 1, j] = (j, 0.0)
            for k in range(1, min(16, m - j) + 1):
                vector = cumulative[j + k] - cumulative[j]
                similarity = float(en[i] @ vector / max(float(np.linalg.norm(vector)), 1e-9))
                fragment = ''.join(chinese[j:j+k])
                expected = max(2, lengths[i] * ratio)
                penalty = .10 * abs(math.log(max(1, len(fragment)) / expected))
                score = dp[i, j] + similarity - .18 - penalty
                if score > dp[i + 1, j + k]:
                    dp[i + 1, j + k] = score; back[i + 1, j + k] = (j, similarity)
    if (n, m) not in back: raise ValueError('Unable to align translation')
    out = []; j = m
    for i in range(n, 0, -1):
        start, similarity = back[i, j]
        out.append((''.join(chinese[start:j]), similarity)); j = start
    return out[::-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=Path('data'))
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    options = ort.SessionOptions(); options.intra_op_num_threads = args.threads; options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model / 'model_quint8_avx2.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
    tokenizer = Tokenizer.from_file(str(args.model / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=256); tokenizer.enable_padding()
    library = args.data / 'textbooks/library'
    output = args.data / 'textbooks/translations'
    lessons = [json.loads(p.read_text()) for p in sorted(library.glob('book*/[0-9]*.json'))]
    texts = []
    for lesson in lessons:
        texts.extend(s['text'] for p in lesson['paragraphs'] for s in p['sentences'])
        texts.extend(split_chinese(lesson['translation'], lesson['book'] == 1))
    texts = list(dict.fromkeys(texts)); embeddings = {}
    cache = args.model / 'embeddings.npz'
    if cache.exists():
        saved = np.load(cache)
        embeddings = dict(zip(saved['texts'].tolist(), saved['vectors']))
    missing = [text for text in texts if text not in embeddings]
    for offset in range(0, len(missing), 32):
        batch = missing[offset:offset+32]; tokens = tokenizer.encode_batch(batch)
        feed = { 'input_ids': np.array([t.ids for t in tokens], dtype=np.int64), 'attention_mask': np.array([t.attention_mask for t in tokens], dtype=np.int64), 'token_type_ids': np.array([t.type_ids for t in tokens], dtype=np.int64) }
        feed = {k:v for k,v in feed.items() if k in [item.name for item in session.get_inputs()]}
        hidden = session.run(None, feed)[0]
        mask = feed['attention_mask'][...,None]
        vectors = (hidden * mask).sum(1) / np.maximum(mask.sum(1), 1)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)
        embeddings.update(zip(batch, vectors))
        if offset % 320 == 0: print(f'embedded {offset}/{len(missing)}', flush=True)
    np.savez_compressed(cache, texts=np.array(list(embeddings)), vectors=np.array(list(embeddings.values())))
    issues = []; count = 0
    for lesson in lessons:
        sentences = [s for p in lesson['paragraphs'] for s in p['sentences']]
        chinese = split_chinese(lesson['translation'], lesson['book'] == 1)
        aligned = align([s['text'] for s in sentences], chinese, embeddings)
        path = output / f"book{lesson['book']}/{lesson['lesson']:03d}.json"
        existing = json.loads(path.read_text()) if path.exists() else {}
        entries = {}
        for sentence, (translation, confidence) in zip(sentences, aligned):
            old = existing.get('sentences', {}).get(sentence['id'])
            if old and old.get('reviewed') and old.get('text') == sentence['text']:
                entries[sentence['id']] = old; continue
            entries[sentence['id']] = {'text':sentence['text'], 'translationZh':translation, 'confidence':round(confidence, 3)}
            if not translation or confidence < .52:
                issues.append({'book':lesson['book'], 'lesson':lesson['lesson'], 'id':sentence['id'], **entries[sentence['id']]})
            count += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'book':lesson['book'], 'lesson':lesson['lesson'], 'sentences':entries}, ensure_ascii=False, indent=2)+'\n')
    output.mkdir(parents=True, exist_ok=True)
    (output / 'review.json').write_text(json.dumps(sorted(issues, key=lambda item:item['confidence']), ensure_ascii=False, indent=2)+'\n')
    print(f'{len(lessons)} lessons, {count} sentences, {len(issues)} items need review',flush=True)
if __name__ == '__main__': main()
