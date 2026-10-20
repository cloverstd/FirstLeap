package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func dictionaryFixture(t *testing.T, entries ...dictionaryEntry) string {
	t.Helper()
	root := t.TempDir()
	if err := writeJSONAtomic(filepath.Join(root, "manifest.json"), map[string]any{"name": "ECDICT", "url": "https://github.com/skywind3000/ECDICT", "revision": strings.Repeat("a", 40), "format": 1, "entries": len(entries)}); err != nil {
		t.Fatal(err)
	}
	shards := map[string][]byte{}
	for _, entry := range entries {
		b, _ := json.Marshal(entry)
		id := dictionaryShardID(entry.Word)
		shards[id] = append(shards[id], append(b, '\n')...)
	}
	for id, b := range shards {
		if err := os.WriteFile(filepath.Join(root, id+".jsonl"), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDictionaryBasicDefinitionsAreLocalAndIndependentOfAI(t *testing.T) {
	a := aiFixture(t)
	root := dictionaryFixture(t, dictionaryEntry{Word: "handbag", Phonetic: "ˈhændbæɡ", Translations: []string{"n. 手提包", "n. 女用手袋"}, Definitions: []string{"a small bag"}, Forms: []dictionaryForm{{Label: "复数", Values: []string{"handbags"}}}})
	a.cfg.DictionaryRoot = root
	restarted, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	w := aiRequest(t, restarted, "GET", "/api/books/1/lessons/1", nil)
	var lesson TextLesson
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &lesson) != nil {
		t.Fatal(w.Body.String())
	}
	word := lesson.Vocabulary[0]
	if word.Dictionary == nil || word.Dictionary.Source.Name != "ECDICT" || word.Dictionary.Phonetic != "ˈhændbæɡ" || len(word.Dictionary.Translations) != 2 || word.Dictionary.Forms[0].Values[0] != "handbags" {
		t.Fatal("missing basic dictionary entry")
	}
	if word.Meaning != "手提包" || word.Details != nil || len(restarted.ai.jobs) != 0 {
		t.Fatal("reading dictionary changed the textbook or started an AI job")
	}
	if w := aiRequest(t, restarted, "POST", "/api/books/1/lessons/1/vocabulary/v0/details", nil); w.Code != 409 {
		t.Fatal("AI expansion should require a configured text provider")
	}
	// Missing dictionary entries keep the original textbook gloss available.
	_ = os.Remove(filepath.Join(root, dictionaryShardID("handbag")+".jsonl"))
	again, err := New(a.cfg)
	if err != nil {
		t.Fatal(err)
	}
	lesson, err = again.textLesson(1, 1)
	if err != nil || lesson.Vocabulary[0].Meaning != "手提包" || lesson.Vocabulary[0].Dictionary != nil {
		t.Fatal("missing dictionary interrupted the lesson")
	}
}

func TestDictionaryCasePhrasesAndConcurrentReadIsolation(t *testing.T) {
	root := dictionaryFixture(t,
		dictionaryEntry{Word: "US", Translations: []string{"美国"}},
		dictionaryEntry{Word: "us", Translations: []string{"我们"}},
		dictionaryEntry{Word: "as well as", Translations: []string{"以及"}},
	)
	d, err := newDictionaryStore(root)
	if err != nil {
		t.Fatal(err)
	}
	if d.lookup("US").Translations[0] != "美国" || d.lookup("Us").Translations[0] != "我们" || d.lookup(" as   well as ").Translations[0] != "以及" {
		t.Fatal("case or phrase lookup is incorrect")
	}
	var group sync.WaitGroup
	for range 20 {
		group.Go(func() {
			entry := d.lookup("us")
			if entry == nil || entry.Translations[0] != "我们" {
				t.Error("concurrent dictionary lookup changed")
			}
			entry.Translations[0] = "response-local mutation"
		})
	}
	group.Wait()
	if d.lookup("us").Translations[0] != "我们" || d.lookup("unknown") != nil {
		t.Fatal("dictionary cache was mutated")
	}
}

func TestDictionaryManifestAndCorruptShard(t *testing.T) {
	if d, err := newDictionaryStore(filepath.Join(t.TempDir(), "not-prepared")); err != nil || d != nil {
		t.Fatal("local development without a dictionary should still work")
	}
	root := dictionaryFixture(t, dictionaryEntry{Word: "word", Translations: []string{"词"}})
	if err := os.WriteFile(filepath.Join(root, dictionaryShardID("word")+".jsonl"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	d, err := newDictionaryStore(root)
	if err != nil || d.lookup("word") != nil {
		t.Fatal("corrupt dictionary returned partial data")
	}
	if err := writeJSONAtomic(filepath.Join(root, "manifest.json"), map[string]any{"format": 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := newDictionaryStore(root); err == nil {
		t.Fatal("unsupported dictionary format accepted")
	}
}
