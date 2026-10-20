package app

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type dictionaryForm struct {
	Label  string   `json:"label"`
	Values []string `json:"values"`
}
type dictionarySource struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Revision string `json:"revision"`
}
type dictionaryEntry struct {
	Word         string           `json:"word"`
	Phonetic     string           `json:"phonetic"`
	Translations []string         `json:"translations"`
	Definitions  []string         `json:"definitions"`
	Forms        []dictionaryForm `json:"forms"`
	Source       dictionarySource `json:"source"`
}
type dictionaryShard struct {
	id      string
	entries map[string]*dictionaryEntry
	folded  map[string]*dictionaryEntry
}
type dictionaryStore struct {
	root   string
	source dictionarySource
	mu     sync.Mutex
	lru    *list.List
	shards map[string]*list.Element
}

func newDictionaryStore(root string) (*dictionaryStore, error) {
	if root == "" {
		return nil, nil
	}
	var manifest struct {
		dictionarySource
		Format  int `json:"format"`
		Entries int `json:"entries"`
	}
	if err := loadJSON(filepath.Join(root, "manifest.json"), &manifest); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("unable to read dictionary manifest")
	}
	if manifest.Format != 1 || manifest.Name != "ECDICT" || manifest.Entries < 1 || !hashID.MatchString(manifest.Revision) {
		return nil, fmt.Errorf("invalid dictionary manifest")
	}
	return &dictionaryStore{root: root, source: manifest.dictionarySource, lru: list.New(), shards: map[string]*list.Element{}}, nil
}

func dictionaryWord(word string) string { return strings.Join(strings.Fields(word), " ") }
func dictionaryFold(word string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, word)
}
func dictionaryShardID(word string) string {
	sum := sha256.Sum256([]byte(dictionaryFold(dictionaryWord(word))))
	return hex.EncodeToString(sum[:1])
}

// Shards are immutable. Keep only a small working set in memory; no downloads or
// language model calls are needed to display a lesson's basic dictionary entries.
func (d *dictionaryStore) lookup(word string) *dictionaryEntry {
	if d == nil {
		return nil
	}
	word = dictionaryWord(word)
	id := dictionaryShardID(word)
	d.mu.Lock()
	defer d.mu.Unlock()
	cached := d.shards[id]
	if cached == nil {
		f, err := os.Open(filepath.Join(d.root, id+".jsonl"))
		if err != nil {
			return nil
		}
		defer f.Close()
		shard := &dictionaryShard{id: id, entries: map[string]*dictionaryEntry{}, folded: map[string]*dictionaryEntry{}}
		decoder := json.NewDecoder(io.LimitReader(f, 16<<20))
		for {
			var entry dictionaryEntry
			err := decoder.Decode(&entry)
			if err == io.EOF {
				break
			}
			if err != nil || len(entry.Word) > 1024 || entry.Word == "" || len(shard.entries) > 30000 {
				return nil
			}
			entry.Source = d.source
			shard.entries[entry.Word] = &entry
			lower := dictionaryFold(entry.Word)
			if shard.folded[lower] == nil || entry.Word == lower {
				shard.folded[lower] = &entry
			}
		}
		cached = d.lru.PushFront(shard)
		d.shards[id] = cached
		if d.lru.Len() > 16 {
			last := d.lru.Back()
			delete(d.shards, last.Value.(*dictionaryShard).id)
			d.lru.Remove(last)
		}
	}
	d.lru.MoveToFront(cached)
	shard := cached.Value.(*dictionaryShard)
	entry := shard.entries[word]
	if entry == nil {
		entry = shard.folded[dictionaryFold(word)]
	}
	if entry == nil {
		return nil
	}
	// The caller may enrich a response without changing the shared dictionary.
	out := copyValue(*entry)
	return &out
}
