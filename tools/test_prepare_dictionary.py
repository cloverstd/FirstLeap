import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from prepare_dictionary import prepare, shard


class DictionaryPreparationTests(unittest.TestCase):
    def test_csv_preserves_definitions_forms_and_attribution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.csv"
            with source.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=["word", "phonetic", "translation", "definition", "exchange"])
                writer.writeheader()
                writer.writerow({"word": "go", "phonetic": "ɡəʊ", "translation": "v. 去\\nn. 尝试", "definition": "move\ntry", "exchange": "p:went/d:gone/3:goes/i:going/unknown:ignored"})
                writer.writerow({"word": "as well as", "translation": "以及", "definition": "and also"})
                writer.writerow({"word": "empty"})
            output = root / "dictionary"
            self.assertEqual(prepare(source, output, {"name": "ECDICT", "revision": "pinned"}), 2)
            data = json.loads((output / (shard("GO") + ".jsonl")).read_text().splitlines()[0])
            self.assertEqual(data["translations"], ["v. 去", "n. 尝试"])
            self.assertEqual(data["definitions"], ["move", "try"])
            self.assertEqual(data["forms"][0], {"label": "过去式", "values": ["went"]})
            self.assertEqual(data["forms"][1], {"label": "过去分词", "values": ["gone"]})
            self.assertEqual(json.loads((output / "manifest.json").read_text())["entries"], 2)
            self.assertIn("MIT License", (output / "LICENSE").read_text())
            with self.assertRaises(ValueError):
                prepare(source, output, {})

    def test_wrong_snapshot_is_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.csv"
            source.write_text("word,phonetic,translation,definition,exchange\ngo,go,去,move,\n")
            output = root / "dictionary"
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("prepare_dictionary.py")), "--source", str(source), "--output", str(output)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())
            self.assertIn("校验失败", result.stderr.decode())


if __name__ == "__main__":
    unittest.main()
