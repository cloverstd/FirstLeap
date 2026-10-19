import unittest
from prepare_textbooks import lesson_overrides, make_lesson, pronunciation_id


class TextbookMappingTests(unittest.TestCase):
    def test_duplicate_title_and_repeated_dialogue_preserve_occurrences(self):
        source = {
            "lesson": 1,
            "title_en": "Excuse me!",
            "title_zh": "对不起",
            "passage": ["Excuse me!", "Is this your handbag?", "Is this your handbag?"],
            "translation": [],
            "vocabulary": [],
        }
        track = {
            "duration": 30,
            "sentences": [
                {"text": text, "start": start, "end": start + 2}
                for text, start in [
                    ("Lesson 1", 0),
                    ("Excuse me!", 3),
                    ("Whose handbag is it?", 6),
                    ("Excuse me!", 10),
                    ("Is this your handbag?", 15),
                    ("Is this your handbag?", 20),
                ]
            ],
        }
        lesson, _ = make_lesson(1, source, track, {})
        sentences = [s for p in lesson["paragraphs"] for s in p["sentences"]]
        self.assertEqual([s["start"] for s in sentences], [10, 15, 20])
        self.assertNotEqual(
            sentences[1]["words"][3]["id"], sentences[2]["words"][3]["id"]
        )

    def test_speaker_names_and_unspoken_references_are_not_timed(self):
        source = {
            "lesson": 5,
            "title_en": "Welcome",
            "title_zh": "欢迎",
            "passage": [
                "MR. BLAKE: Good morning.",
                "STUDENTS: Good morning, Mr. Blake.",
                "AUTHOR from The Listener",
            ],
            "translation": [],
            "vocabulary": [],
        }
        track = {
            "duration": 20,
            "sentences": [
                {"text": "Lesson 5", "start": 0, "end": 2},
                {"text": "Good morning.", "start": 5, "end": 7},
                {"text": "Good morning Mr. Blake.", "start": 8, "end": 10},
            ],
        }
        lesson, _ = make_lesson(1, source, track, {})
        self.assertEqual(lesson["paragraphs"][0]["speaker"], "MR. BLAKE")
        self.assertEqual(
            lesson["paragraphs"][0]["sentences"][0]["text"], "Good morning."
        )
        self.assertEqual(lesson["paragraphs"][-1]["sentences"], [])
        self.assertIn("AUTHOR", lesson["paragraphs"][-1]["note"])

    def test_heteronyms_and_overrides_have_separate_cached_audio(self):
        self.assertNotEqual(
            pronunciation_id("present", "v."), pronunciation_id("present", "n.")
        )
        self.assertNotEqual(
            pronunciation_id("wind", "v."), pronunciation_id("wind", "v.", "other")
        )

    def test_partial_heading_match_does_not_include_listening_instructions(self):
        source = {
            "lesson": 55,
            "title_en": "The Sawyer family",
            "title_zh": "索耶一家",
            "question": "When do the children do their homework?",
            "passage": [
                "The Sawyer live at 87 King Street.",
                "At night, the children do their homework.",
            ],
            "translation": [],
            "vocabulary": [],
        }
        lines = [
            "Lesson 55",
            "The Sawyer family",
            "Listen to the tape then answer this question.",
            "When do the children do their homework?",
            "The Sawyers live at 87 King Street.",
            "At night, the children do their homework.",
        ]
        track = {
            "duration": 30,
            "sentences": [
                {"text": text, "start": i * 4, "end": i * 4 + 4}
                for i, text in enumerate(lines)
            ],
        }
        lesson, _ = make_lesson(1, source, track, {})
        self.assertEqual(
            [s["id"] for p in lesson["paragraphs"] for s in p["sentences"]],
            ["s4", "s5"],
        )

    def test_pronunciation_corrections_flow_into_the_cache_identity(self):
        overrides = {
            "pronunciations": {"word|n.": "global"},
            "lessons": {
                "1:1": {"bodyStart": 4, "pronunciations": {"word|n.": "local"}}
            },
        }
        self.assertEqual(
            lesson_overrides(overrides, 1, 1)["pronunciations"]["word|n."], "local"
        )
        self.assertEqual(
            lesson_overrides(overrides, 2, 1)["pronunciations"]["word|n."], "global"
        )
        self.assertEqual(lesson_overrides({}, 1, 1), {})


if __name__ == "__main__":
    unittest.main()
