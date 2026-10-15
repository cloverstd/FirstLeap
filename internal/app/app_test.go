package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestProductionSMBFilesystemTypes(t *testing.T) {
	for _, typeID := range []int64{0xff534d42, 0xfe534d42} {
		if !readOnlySMB(&syscall.Statfs_t{Type: typeID, Flags: syscall.MS_RDONLY}) {
			t.Fatal("read-only SMB mount was rejected")
		}
		if readOnlySMB(&syscall.Statfs_t{Type: typeID}) {
			t.Fatal("writable SMB mount accepted")
		}
	}
	if readOnlySMB(&syscall.Statfs_t{Type: 0xef53, Flags: syscall.MS_RDONLY}) {
		t.Fatal("ordinary local mount accepted")
	}
}

func testApp(t *testing.T) (*App, string, []byte) {
	t.Helper()
	root := t.TempDir()
	media := filepath.Join(root, "media")
	_ = os.Mkdir(media, 0755)
	name := "014 - Lesson 025&26 Mrs Smith’s kitchen 史密斯太太的厨房 [abc123].mp4"
	content := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	if err := os.WriteFile(filepath.Join(media, name), content, 0644); err != nil {
		t.Fatal(err)
	}
	a, err := New(Config{MediaRoot: media, DataRoot: filepath.Join(root, "data"), WebRoot: filepath.Join(root, "web")})
	if err != nil {
		t.Fatal(err)
	}
	a.scan(context.Background())
	return a, parseName(name).ID, content
}

func request(a *App, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}

func TestParseAndStableID(t *testing.T) {
	l := parseName("014 - Lesson 025&26 Mrs  Smith’s kitchen 史密斯太太的厨房 [abc123].mp4")
	if l.Order != 14 || l.Label != "Lesson 25 & 26" || l.Title != "Mrs Smith’s kitchen 史密斯太太的厨房" {
		t.Fatalf("unexpected metadata: %+v", l)
	}
	if l.ID != parseName("014 - Lesson 025&26 Mrs  Smith’s kitchen 史密斯太太的厨房 [abc123].mp4").ID {
		t.Fatal("unstable ID")
	}
	if parseName("001 - 《新概念英语》第一册 导学课 [intro].mp4").Label != "导学课" {
		t.Fatal("missing introduction")
	}
	a, id, _ := testApp(t)
	old := a.cfg.MediaRoot
	moved := old + "-moved"
	if err := os.Rename(old, moved); err != nil {
		t.Fatal(err)
	}
	a.cfg.MediaRoot = moved
	a.scan(context.Background())
	if _, ok := a.entries[id]; !ok {
		t.Fatal("ID changed after moving mount root")
	}
}

func TestRangeAndHead(t *testing.T) {
	a, id, content := testApp(t)
	path := "/api/lessons/" + id + "/video"
	cases := []struct {
		rangeValue         string
		status             int
		body, contentRange string
	}{
		{"", 200, string(content), ""}, {"bytes=5-9", 206, "56789", "bytes 5-9/36"}, {"bytes=30-", 206, "uvwxyz", "bytes 30-35/36"}, {"bytes=-3", 206, "xyz", "bytes 33-35/36"}, {"bytes=999-", 416, "", "bytes */36"},
	}
	for _, c := range cases {
		t.Run(c.rangeValue, func(t *testing.T) {
			w := request(a, "GET", path, map[string]string{"Range": c.rangeValue})
			if w.Code != c.status {
				t.Fatalf("status: %d", w.Code)
			}
			if c.status != 416 && w.Body.String() != c.body {
				t.Fatalf("body %q", w.Body.String())
			}
			if w.Header().Get("Content-Range") != c.contentRange {
				t.Fatalf("content range: %s", w.Header().Get("Content-Range"))
			}
		})
	}
	head := request(a, "HEAD", path, nil)
	if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") != "36" {
		t.Fatal("invalid HEAD response")
	}
	etag := head.Header().Get("ETag")
	if request(a, "GET", path, map[string]string{"If-None-Match": etag}).Code != 304 {
		t.Fatal("conditional GET ignored")
	}
	if request(a, "GET", path, map[string]string{"Range": "bytes=0-3", "If-Range": "\"other\""}).Code != 200 {
		t.Fatal("If-Range must send full representation on mismatch")
	}
}

func TestCatalogSecurityAndSourceRecovery(t *testing.T) {
	a, id, _ := testApp(t)
	outside := filepath.Join(t.TempDir(), "secret.mp4")
	_ = os.WriteFile(outside, []byte("outside"), 0600)
	link := filepath.Join(a.cfg.MediaRoot, "099 - secret.mp4")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	a.scan(context.Background())
	if len(a.course().Lessons) != 1 {
		t.Fatal("symlink was indexed")
	}
	for _, p := range []string{"/api/lessons/unknown/video", "/api/courses/unknown", "/api/lessons/%2e%2e%2fsecret/video"} {
		if request(a, "GET", p, nil).Code != 404 {
			t.Errorf("unexpected access to %s", p)
		}
	}
	catalog := request(a, "GET", "/api/courses/ncese01", nil)
	if strings.Contains(catalog.Body.String(), a.cfg.MediaRoot) || strings.Contains(catalog.Body.String(), ".mp4") || strings.Contains(catalog.Body.String(), "relative") {
		t.Fatal("server paths leaked")
	}
	// A file replaced after indexing must still be constrained to the media root.
	e := a.entries[id]
	path := filepath.Join(a.cfg.MediaRoot, e.Relative)
	_ = os.Remove(path)
	_ = os.Symlink(outside, path)
	if request(a, "GET", "/api/lessons/"+id+"/video", nil).Code != 503 {
		t.Fatal("escaped media root")
	}
	oldRoot := a.cfg.MediaRoot
	a.cfg.MediaRoot = oldRoot + "-offline"
	a.scan(context.Background())
	if request(a, "GET", "/health/ready", nil).Code != 503 || request(a, "GET", "/health/live", nil).Code != 200 {
		t.Fatal("health distinction lost")
	}
	var cached Course
	_ = json.Unmarshal(request(a, "GET", "/api/courses/ncese01", nil).Body.Bytes(), &cached)
	if cached.SourceAvailable || len(cached.Lessons) != 1 {
		t.Fatal("cached catalog not retained during outage")
	}
	_ = os.Remove(path)
	_ = os.WriteFile(path, []byte("restored"), 0644)
	a.cfg.MediaRoot = oldRoot
	a.scan(context.Background())
	if request(a, "GET", "/health/ready", nil).Code != 200 {
		t.Fatal("source did not recover")
	}
	a.cfg.RequireCIFS = true
	if a.mediaOK() {
		t.Fatal("plain local directory accepted as production CIFS mount")
	}
}

func TestSPAAndMissingAssets(t *testing.T) {
	a, _, _ := testApp(t)
	_ = os.MkdirAll(a.cfg.WebRoot, 0755)
	_ = os.WriteFile(filepath.Join(a.cfg.WebRoot, "index.html"), []byte("<!doctype html>app"), 0644)
	if request(a, http.MethodGet, "/learn/abc", nil).Code != 200 {
		t.Fatal("deep link failed")
	}
	if request(a, http.MethodGet, "/assets/missing.js", nil).Code != 404 {
		t.Fatal("missing asset returned SPA")
	}
}
