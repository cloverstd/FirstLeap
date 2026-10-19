"""Import reviewed sentence translations without changing media or timing IDs."""
from copy import deepcopy


def apply_sentence_translations(lesson, mapping):
    if (mapping.get("book"), mapping.get("lesson")) != (lesson["book"], lesson["lesson"]):
        raise ValueError("translation map belongs to a different lesson")
    result = deepcopy(lesson)
    sentences = [s for p in result["paragraphs"] for s in p["sentences"]]
    entries = mapping.get("sentences", {})
    if set(entries) != {s["id"] for s in sentences}:
        raise ValueError("translation map has missing or unknown sentence IDs")
    for sentence in sentences:
        entry = entries[sentence["id"]]
        if entry.get("text") != sentence["text"]:
            raise ValueError(f"{sentence['id']}: English changed; review its translation")
        translation = entry.get("translationZh")
        if not isinstance(translation, str) or not translation.strip():
            raise ValueError(f"{sentence['id']}: missing sentence translation")
        sentence["translationZh"] = translation.strip()
    return result
