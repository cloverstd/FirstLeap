package app

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func readingTestApp(t *testing.T) (*App, string, readingEntry) {
	t.Helper()
	a, id, _ := testApp(t)
	a.cfg.ReadingRoot = filepath.Join(t.TempDir(), "source")
	_ = os.Mkdir(a.cfg.ReadingRoot, 0755)
	name := "新概念第一册美音版第25集.mp4"
	_ = os.WriteFile(filepath.Join(a.cfg.ReadingRoot, name), []byte("source"), 0644)
	info, _ := os.Stat(filepath.Join(a.cfg.ReadingRoot, name))
	e := readingEntry{Reading: Reading{ID: "nce1-reading-025", Number: 25, Duration: 10, Status: "ready"}, Relative: name, Size: info.Size(), Modified: info.ModTime().UnixNano()}
	a.readings = map[int]readingEntry{25: e}
	a.readingsAvailable = true
	cache := filepath.Join(a.cfg.DataRoot, "readings")
	_ = os.MkdirAll(cache, 0750)
	_ = os.WriteFile(filepath.Join(cache, readingKey(e)), []byte("0123456789abcdefghijklmnopqrstuvwxyz"), 0600)
	a.saveReadings(cache)
	return a, id, e
}
func TestReadingNumbersAndMapping(t *testing.T) {
	for name, want := range map[string]int{"新概念第一册美音版第01集.mp4": 1, "新概念第一册美音版第025集.mp4": 25, "新概念第一册美音版第143集.mp4": 143, "新概念第一册美音版第144集.mp4": 0, "新概念第一册美音版第00集.mp4": 0, "other.mp4": 0} {
		if got := readingNumber(name); got != want {
			t.Errorf("%s: %d", name, got)
		}
	}
	a, id, e := readingTestApp(t)
	course := a.course()
	if len(course.Lessons) != 1 || course.Lessons[0].ID != id || course.Lessons[0].Reading.ID != e.ID {
		t.Fatal("lecture identity changed or incorrect mapping")
	}
	a.mu.RLock()
	missing := a.readingFor(Lesson{Label: "Lesson 137 & 138"})
	intro := a.readingFor(Lesson{Label: "导学课"})
	a.mu.RUnlock()
	if missing.Number != 137 || missing.Status != "missing" || intro != nil {
		t.Fatal("missing or intro incorrectly mapped")
	}
	body := request(a, "GET", "/api/courses/ncese01", nil).Body.String()
	if strings.Contains(body, e.Relative) || strings.Contains(body, a.cfg.ReadingRoot) {
		t.Fatal("private path leaked")
	}
}
func TestReadingRangeSafetyAndRecovery(t *testing.T) {
	a, id, e := readingTestApp(t)
	url := "/api/lessons/" + id + "/reading/video"
	for _, c := range []struct {
		method, rng string
		status      int
		body        string
	}{{"GET", "bytes=5-9", 206, "56789"}, {"HEAD", "", 200, ""}, {"GET", "bytes=999-", 416, ""}} {
		w := request(a, c.method, url, map[string]string{"Range": c.rng})
		if w.Code != c.status || (c.status != 416 && w.Body.String() != c.body) {
			t.Fatalf("bad range/head: %d %s", w.Code, w.Body.String())
		}
	}
	etag := request(a, "HEAD", url, nil).Header().Get("ETag")
	if etag == "" || request(a, "GET", url, map[string]string{"If-None-Match": etag}).Code != 304 {
		t.Fatal("conditional request failed")
	}
	if request(a, "GET", url, map[string]string{"Range": "bytes=0-1", "If-Range": "\"old\""}).Code != 200 {
		t.Fatal("If-Range failed")
	}
	for _, p := range []string{"unknown", "%2e%2e%2fsecret"} {
		if request(a, "GET", "/api/lessons/"+p+"/reading/video", nil).Code != 404 {
			t.Fatal("invalid ID accepted")
		}
	}
	old := a.cfg.ReadingRoot
	a.cfg.ReadingRoot += "-offline"
	a.scanReadings(context.Background())
	if request(a, "GET", url, nil).Code != 503 || a.course().Lessons[0].Reading.Status != "unavailable" || request(a, "GET", "/health/ready", nil).Code != 200 {
		t.Fatal("reading outage affected lecture or was not exposed")
	}
	a.cfg.ReadingRoot = old
	a.scanReadings(context.Background())
	if request(a, "GET", url, nil).Code != 200 {
		t.Fatal("recovery failed")
	}
	original := filepath.Join(old, e.Relative)
	outside := filepath.Join(t.TempDir(), "outside.mp4")
	_ = os.WriteFile(outside, []byte("source"), 0644)
	_ = os.Remove(original)
	_ = os.Symlink(outside, original)
	if request(a, "GET", url, nil).Code != 503 {
		t.Fatal("source symlink escaped root")
	}
	_ = os.Remove(original)
	_ = os.WriteFile(original, []byte("source"), 0644)
	info, _ := os.Stat(original)
	e.Modified = info.ModTime().UnixNano()
	a.readings[25] = e
	cacheFile := filepath.Join(a.cfg.DataRoot, "readings", readingKey(e))
	_ = os.Remove(cacheFile)
	_ = os.Symlink(outside, cacheFile)
	if request(a, "GET", url, nil).Code != 503 {
		t.Fatal("cache symlink escaped root")
	}
}
func TestReadingCacheAndDuplicate(t *testing.T) {
	a, _, e := readingTestApp(t)
	key := readingKey(e)
	a.scanReadings(context.Background())
	if a.readings[25].Status != "ready" {
		t.Fatal("valid cached video not reused")
	}
	moved := a.cfg.ReadingRoot + "-moved"
	_ = os.Rename(a.cfg.ReadingRoot, moved)
	a.cfg.ReadingRoot = moved
	a.scanReadings(context.Background())
	if a.readings[25].ID != e.ID || readingKey(a.readings[25]) != key {
		t.Fatal("mount move changed stable identity or cache")
	}
	_ = os.Mkdir(filepath.Join(moved, "duplicates"), 0755)
	_ = os.WriteFile(filepath.Join(moved, "duplicates", e.Relative), []byte("other"), 0644)
	a.scanReadings(context.Background())
	if a.readings[25].Status != "error" {
		t.Fatal("duplicate silently selected")
	}
	_ = os.RemoveAll(filepath.Join(moved, "duplicates"))
	_ = os.WriteFile(filepath.Join(moved, e.Relative), []byte("changed invalid media"), 0644)
	a.scanReadings(context.Background())
	if readingKey(a.readings[25]) == key || a.readings[25].Status == "ready" {
		t.Fatal("changed source served stale cache")
	}
}
func TestReadingTranscode(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required for integration test")
	}
	a, id, _ := readingTestApp(t)
	path := filepath.Join(a.cfg.ReadingRoot, "新概念第一册美音版第25集.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=320x240:rate=10", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "1", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-y", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %s %v", b, err)
	}
	a.scanReadings(context.Background())
	e := a.readings[25]
	if e.Status != "ready" || e.Duration < 1 {
		t.Fatalf("conversion failed: %+v", e)
	}
	output, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", filepath.Join(a.cfg.DataRoot, "readings", readingKey(e))).Output()
	if err != nil {
		t.Fatal(err)
	}
	var probe struct {
		Streams []struct {
			Codec  string `json:"codec_name"`
			Pixel  string `json:"pix_fmt"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		}
	}
	if json.Unmarshal(output, &probe) != nil || len(probe.Streams) != 2 || probe.Streams[0].Codec != "h264" || probe.Streams[0].Pixel != "yuv420p" || probe.Streams[0].Width != 320 || probe.Streams[0].Height != 240 || probe.Streams[1].Codec != "aac" {
		t.Fatalf("invalid playback format: %s", output)
	}
	if request(a, "GET", "/api/lessons/"+id+"/reading/video", map[string]string{"Range": "bytes=0-31"}).Code != 206 {
		t.Fatal("converted file not served")
	}
}
