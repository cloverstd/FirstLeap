import unittest
from textbook_translations import apply_sentence_translations


class TranslationTests(unittest.TestCase):
    def setUp(self):
        self.lesson = {"book": 1, "lesson": 1, "revision": "audio-v1", "paragraphs": [{"sentences": [{"id": "s4", "text": "Hello!", "start": 2, "end": 3, "words": [{"id": "s4-w0", "start": 2.1, "end": 2.9}]}]}]}
        self.mapping = {"book": 1, "lesson": 1, "sentences": {"s4": {"text": "Hello!", "translationZh": "你好！"}}}

    def test_translation_import_preserves_media_and_does_not_mutate_input(self):
        result = apply_sentence_translations(self.lesson, self.mapping)
        sentence = result["paragraphs"][0]["sentences"][0]
        self.assertEqual(sentence["translationZh"], "你好！")
        self.assertEqual(sentence["words"], self.lesson["paragraphs"][0]["sentences"][0]["words"])
        self.assertEqual(result["revision"], "audio-v1")
        self.assertNotIn("translationZh", self.lesson["paragraphs"][0]["sentences"][0])

    def test_stale_missing_or_cross_lesson_translations_are_rejected(self):
        for mapping in [dict(self.mapping, book=2), dict(self.mapping, sentences={}), dict(self.mapping, sentences={"s4": {"text": "Changed", "translationZh": "你好"}}), dict(self.mapping, sentences={"s4": {"text": "Hello!", "translationZh": " "}})]:
            with self.assertRaises(ValueError):
                apply_sentence_translations(self.lesson, mapping)
