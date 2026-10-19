package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type aiTarget struct {
	Kind  string `json:"kind"`
	ID    string `json:"id,omitempty"`
	EndID string `json:"endId,omitempty"`
	Text  string `json:"text,omitempty"`
}
type explainRequest struct {
	Book       int            `json:"book"`
	Lesson     int            `json:"lesson"`
	Target     aiTarget       `json:"target"`
	Regenerate bool           `json:"regenerate"`
	Active     map[string]any `json:"active,omitempty"`
}
type aiImage struct {
	ID        string `json:"id"`
	Prompt    string `json:"prompt"`
	Caption   string `json:"caption"`
	Version   string `json:"version"`
	URL       string `json:"url"`
	Model     string `json:"model"`
	CreatedAt string `json:"createdAt"`
}
type learningContext struct {
	Profile  profileData    `json:"profile"`
	Progress map[string]any `json:"progress"`
	Current  map[string]any `json:"current"`
	Stage    string         `json:"stage"`
}
type explanation struct {
	ID        string           `json:"id"`
	Book      int              `json:"book"`
	Lesson    int              `json:"lesson"`
	Target    aiTarget         `json:"target"`
	Content   string           `json:"content"`
	Images    []aiImage        `json:"images"`
	Warnings  []string         `json:"warnings"`
	Context   learningContext  `json:"context"`
	CreatedAt string           `json:"createdAt"`
	Model     string           `json:"model"`
	Usage     []map[string]any `json:"usage"`
}
type jobSnapshot struct {
	ID       string    `json:"id"`
	Status   string    `json:"status"`
	Text     string    `json:"text"`
	Images   []aiImage `json:"images"`
	Warnings []string  `json:"warnings"`
	Error    string    `json:"error,omitempty"`
	Result   any       `json:"result,omitempty"`
	Sequence uint64    `json:"sequence"`
}
type aiJob struct {
	mu    sync.Mutex
	state jobSnapshot
}

func (j *aiJob) update(fn func(*jobSnapshot)) {
	j.mu.Lock()
	defer j.mu.Unlock()
	fn(&j.state)
	j.state.Sequence++
}
func (j *aiJob) snapshot() jobSnapshot { j.mu.Lock(); defer j.mu.Unlock(); return copyValue(j.state) }
func (s *aiService) startJob(key string, run func(context.Context, *aiJob) (any, error)) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id := s.pending[key]; id != "" {
		if job := s.jobs[id]; job != nil && job.snapshot().Status == "running" {
			return id
		}
		delete(s.pending, key)
	}
	// Completed jobs are only a short reconnect buffer. Durable results live on disk.
	if len(s.jobs) > 256 {
		for id, j := range s.jobs {
			if j.snapshot().Status != "running" {
				delete(s.jobs, id)
			}
		}
	}
	id := uniqueID()
	j := &aiJob{state: jobSnapshot{ID: id, Status: "running", Images: []aiImage{}, Warnings: []string{}}}
	s.jobs[id] = j
	s.pending[key] = id
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		result, err := run(ctx, j)
		j.update(func(v *jobSnapshot) {
			if err != nil {
				v.Status = "error"
				v.Error = err.Error()
			} else {
				v.Status = "done"
				v.Result = result
			}
		})
		s.mu.Lock()
		if s.pending[key] == id {
			delete(s.pending, key)
		}
		s.mu.Unlock()
	}()
	return id
}
func canonicalText(raw string) string { return strings.Join(strings.Fields(raw), " ") }
func lessonEnglish(l TextLesson) string {
	var lines []string
	lines = append(lines, l.TitleEn, l.Question)
	for _, p := range l.Paragraphs {
		if p.Speaker != "" {
			lines = append(lines, p.Speaker)
		}
		for _, v := range p.Sentences {
			lines = append(lines, v.Text)
		}
	}
	return strings.Join(lines, "\n")
}
func resolveTarget(l TextLesson, t aiTarget) (aiTarget, string, error) {
	if t.Kind == "" || t.Kind == "lesson" {
		return aiTarget{Kind: "lesson"}, lessonEnglish(l), nil
	}
	sentences := []TextSentence{}
	for _, p := range l.Paragraphs {
		sentences = append(sentences, p.Sentences...)
	}
	for _, v := range sentences {
		if t.Kind == "sentence" && v.ID == t.ID {
			return aiTarget{Kind: "sentence", ID: v.ID}, v.Text, nil
		}
		if t.Kind == "word" {
			for _, w := range v.Words {
				if w.ID == t.ID {
					return aiTarget{Kind: "word", ID: w.ID}, w.Text + "（所在句：" + v.Text + "）", nil
				}
			}
		}
	}
	if t.Kind == "vocabulary" {
		for _, v := range l.Vocabulary {
			if v.ID == t.ID {
				return aiTarget{Kind: t.Kind, ID: v.ID}, v.Word + " " + v.POS + " " + v.Meaning, nil
			}
		}
	}
	if t.Kind == "selection" && len(t.Text) <= 4000 && strings.TrimSpace(t.Text) != "" {
		start, end := -1, -1
		for i, v := range sentences {
			if v.ID == t.ID {
				start = i
			}
			if v.ID == t.EndID {
				end = i
			}
		}
		if start >= 0 && end >= start {
			var chunks []string
			for _, v := range sentences[start : end+1] {
				chunks = append(chunks, v.Text)
			}
			text := canonicalText(t.Text)
			if strings.Contains(canonicalText(strings.Join(chunks, " ")), text) {
				t.Text = text
				return t, text, nil
			}
		}
	}
	return t, "", fmt.Errorf("请选择当前课文中有效的词句")
}
func semanticProfile(p profileData) any {
	levels := map[string]int{}
	for d, a := range p.Abilities {
		levels[d] = a.Level
	}
	return map[string]any{"level": p.Level, "abilities": levels, "goals": p.Goals, "weaknesses": p.Weaknesses, "style": p.Style}
}
func (s *aiService) explainContext(req explainRequest, l TextLesson) (learningContext, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ctx := learningContext{Profile: copyValue(s.state.Profile.profileData), Progress: map[string]any{}, Current: map[string]any{"book": l.Book, "lesson": l.Lesson, "title": l.TitleEn}, Stage: "初学"}
	refs := map[string]any{}
	s.app.mu.RLock()
	for id, e := range s.app.entries {
		n := textbookNumber(e.Lesson)
		refs[id] = map[string]any{"book": 1, "lesson": n, "label": e.Label, "title": e.Title}
		if n > 0 {
			refs[fmt.Sprintf("nce1-reading-%03d", n)] = refs[id]
		}
	}
	s.app.mu.RUnlock()
	describe := func(track, id string) any {
		if track == "text" {
			parts := strings.Split(id, ":")
			if len(parts) == 2 {
				book, _ := strconv.Atoi(parts[0])
				lesson, _ := strconv.Atoi(parts[1])
				if validTextLesson(book, lesson) {
					return map[string]any{"book": book, "lesson": lesson}
				}
			}
		}
		if ref, ok := refs[id]; ok {
			return ref
		}
		return id
	}
	for track, rows := range s.state.Progress.Tracks {
		ids := []string{}
		for id, row := range rows {
			if row.Values["completed"] == true {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		completed := []any{}
		for _, id := range ids {
			completed = append(completed, describe(track, id))
		}
		last, _ := rows["@last"].Values["lastLesson"].(string)
		ctx.Progress[track] = map[string]any{"completed": completed, "completedCount": len(ids), "lastLesson": describe(track, last)}
	}
	textKey := fmt.Sprintf("%d:%d", l.Book, l.Lesson)
	text := s.state.Progress.Tracks["text"][textKey]
	if text.Values["completed"] == true {
		ctx.Stage = "复习"
	}
	ctx.Current["saved"] = copyValue(text.Values)
	for k, v := range req.Active {
		switch k {
		case "completed":
			if completed, ok := v.(bool); ok {
				ctx.Current[k] = completed
				if completed {
					ctx.Stage = "复习"
				} else {
					ctx.Stage = "初学"
				}
			}
		case "position":
			if n, ok := v.(float64); ok && n >= 0 && n <= l.Duration {
				ctx.Current[k] = v
			}
		case "sentence":
			if id, ok := v.(string); ok {
				for _, p := range l.Paragraphs {
					for _, sent := range p.Sentences {
						if sent.ID == id {
							ctx.Current[k] = id
						}
					}
				}
			}
		case "mode":
			if v == "text" || v == "lecture" || v == "reading" {
				ctx.Current[k] = v
			}
		}
	}
	_, selectedText, _ := resolveTarget(l, req.Target)
	key := contentHash([]any{"explanation-v1", l.Book, l.Lesson, req.Target, selectedText, lessonEnglish(l), semanticProfile(ctx.Profile), ctx.Stage})
	return ctx, key
}
func (s *aiService) explanationPath(id string) string {
	return filepath.Join(s.root, "explanations", id+".json")
}
func (s *aiService) explanationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/ai/explanations", func(w http.ResponseWriter, r *http.Request) {
		var req explainRequest
		_ = json.Unmarshal([]byte(r.URL.Query().Get("target")), &req.Target)
		fmt.Sscan(r.URL.Query().Get("book"), &req.Book)
		fmt.Sscan(r.URL.Query().Get("lesson"), &req.Lesson)
		l, err := s.app.textLesson(req.Book, req.Lesson)
		if err != nil {
			failure(w, 404, "课文不存在")
			return
		}
		req.Target, _, err = resolveTarget(l, req.Target)
		if err != nil {
			failure(w, 400, err.Error())
			return
		}
		_, key := s.explainContext(req, l)
		var cached explanation
		hit := s.readExplanation(s.explanationPath(key), &cached) == nil
		s.mu.Lock()
		pending := s.pending["explain:"+key]
		s.mu.Unlock()
		history := []explanation{}
		paths, _ := filepath.Glob(filepath.Join(s.root, "explanations", "*.json"))
		for _, path := range paths {
			var old explanation
			if s.readExplanation(path, &old) == nil && old.Book == req.Book && old.Lesson == req.Lesson && contentHash(old.Target) == contentHash(req.Target) && old.ID != key {
				history = append(history, old)
			}
		}
		jsonResponse(w, 200, map[string]any{"id": key, "cached": hit, "result": cached, "jobId": pending, "history": history})
	})
	mux.HandleFunc("POST /api/ai/explanations", func(w http.ResponseWriter, r *http.Request) {
		var req explainRequest
		if !decodeBody(w, r, &req) {
			return
		}
		l, err := s.app.textLesson(req.Book, req.Lesson)
		if err != nil {
			failure(w, 404, "课文不存在")
			return
		}
		target, text, err := resolveTarget(l, req.Target)
		if err != nil {
			failure(w, 400, err.Error())
			return
		}
		req.Target = target
		ctx, key := s.explainContext(req, l)
		if !req.Regenerate {
			var cached explanation
			if s.readExplanation(s.explanationPath(key), &cached) == nil {
				jsonResponse(w, 200, map[string]any{"cached": true, "result": cached})
				return
			}
		}
		cfg := s.settingsSnapshot()
		if !configured(cfg.Text.modelConfig) {
			failure(w, 409, "请先在系统配置中设置文字模型")
			return
		}
		id := s.startJob("explain:"+key, func(c context.Context, j *aiJob) (any, error) {
			return s.generateExplanation(c, j, cfg, req, l, text, ctx, key)
		})
		jsonResponse(w, 202, map[string]string{"jobId": id})
	})
	mux.HandleFunc("GET /api/ai/jobs/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		j := s.jobs[r.PathValue("id")]
		s.mu.Unlock()
		if j == nil {
			failure(w, 404, "任务已结束或服务已重启，请重新读取缓存")
			return
		}
		f, ok := w.(http.Flusher)
		if !ok {
			failure(w, 500, "当前连接不支持流式传输")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		ticker := time.NewTicker(150 * time.Millisecond)
		defer ticker.Stop()
		last := ^uint64(0)
		heart := time.Now()
		for {
			state := j.snapshot()
			if state.Sequence != last {
				b, _ := json.Marshal(state)
				if _, err := fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", b); err != nil {
					return
				}
				f.Flush()
				last = state.Sequence
			}
			if state.Status != "running" {
				return
			}
			if time.Since(heart) > 10*time.Second {
				fmt.Fprint(w, ": keepalive\n\n")
				f.Flush()
				heart = time.Now()
			}
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
			}
		}
	})
	mux.HandleFunc("GET /api/ai/images/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !hashID.MatchString(id) {
			failure(w, 404, "图片不存在")
			return
		}
		var im aiImage
		if loadJSON(filepath.Join(s.root, "images", id+".json"), &im) != nil || !hashID.MatchString(im.Version) {
			failure(w, 404, "图片尚未生成")
			return
		}
		f, err := os.Open(filepath.Join(s.root, "images", id+"."+im.Version+".bin"))
		if err != nil {
			failure(w, 404, "图片尚未生成")
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			failure(w, 404, "图片不存在")
			return
		}

		w.Header().Set("ETag", `"`+im.Version+`"`)
		w.Header().Set("Cache-Control", "private, no-cache")
		http.ServeContent(w, r, "illustration", info.ModTime(), f)
	})
	mux.HandleFunc("POST /api/ai/images/{id}/regenerate", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !hashID.MatchString(id) {
			failure(w, 404, "图片不存在")
			return
		}
		var im aiImage
		if loadJSON(filepath.Join(s.root, "images", id+".json"), &im) != nil {
			failure(w, 404, "配图需求不存在")
			return
		}
		cfg := s.settingsSnapshot()
		if !cfg.Image.Enabled || !configured(cfg.Image.modelConfig) {
			failure(w, 409, "请先启用并配置生图模型")
			return
		}
		job := s.startJob("image:"+id, func(c context.Context, j *aiJob) (any, error) { return s.makeImage(c, cfg, im, true) })
		jsonResponse(w, 202, map[string]string{"jobId": job})
	})
}
func (s *aiService) generateExplanation(ctx context.Context, j *aiJob, cfg aiSettings, req explainRequest, l TextLesson, targetText string, lc learningContext, key string) (any, error) {
	prompt := cfg.Prompts.Lesson
	if req.Target.Kind == "sentence" || req.Target.Kind == "selection" {
		prompt = cfg.Prompts.Sentence
	}
	if req.Target.Kind == "word" || req.Target.Kind == "vocabulary" {
		prompt = cfg.Prompts.Word
	}
	data, _ := json.Marshal(map[string]any{"learningContext": lc, "passage": lessonEnglish(l), "target": targetText, "instruction": prompt})
	var tools []map[string]any
	if cfg.Image.Enabled && cfg.Image.MaxCalls > 0 && configured(cfg.Image.modelConfig) {
		tools = []map[string]any{imageTool(cfg.Text.Protocol)}
	}
	p := newProviderSession(cfg.Text, cfg.Prompts.System+"\n学习等级：-1未评估，0入门，1初级，2中级，3中高级，4高级。你可以在视觉解释有帮助时调用生图工具。只引用工具实际返回的本站图片 URL，不要编造图片。", string(data), tools)
	result := explanation{ID: key, Book: l.Book, Lesson: l.Lesson, Target: req.Target, Images: []aiImage{}, Warnings: []string{}, Context: lc, CreatedAt: nowISO(), Model: cfg.Text.Model, Usage: []map[string]any{}}
	calls := 0
	for round := 0; round < cfg.Image.MaxCalls+2; round++ {
		if result.Content != "" {
			result.Content += "\n\n"
			j.update(func(v *jobSnapshot) { v.Text += "\n\n" })
		}
		t, err := s.turn(ctx, p, func(delta string) { j.update(func(v *jobSnapshot) { v.Text += delta }) })
		if err != nil {
			return nil, err
		}
		result.Content += t.Text
		if t.Usage != nil {
			result.Usage = append(result.Usage, t.Usage)
		}
		if len(t.Calls) == 0 {
			if strings.TrimSpace(result.Content) == "" {
				return nil, fmt.Errorf("AI 没有返回详解")
			}
			if err = writeJSONAtomic(s.explanationPath(key), result); err != nil {
				return nil, fmt.Errorf("详解缓存保存失败")
			}
			return result, nil
		}
		p.addTurn(t)
		for _, call := range t.Calls {
			calls++
			var args struct {
				Prompt  string `json:"prompt"`
				Caption string `json:"caption"`
			}
			decoder := json.NewDecoder(strings.NewReader(call.Arguments))
			decoder.DisallowUnknownFields()
			var toolResult any
			if call.Name != "generate_image" || calls > cfg.Image.MaxCalls || !cfg.Image.Enabled || !configured(cfg.Image.modelConfig) {
				toolResult = map[string]string{"error": "当前工具不可用或已达到配图上限，请继续完成文字详解"}
			} else if decoder.Decode(&args) != nil || decoder.Decode(&struct{}{}) != io.EOF || strings.TrimSpace(args.Caption) == "" || strings.TrimSpace(args.Prompt) == "" || len(args.Prompt) > 8000 || len(args.Caption) > 500 {
				toolResult = map[string]string{"error": "配图参数无效，请继续文字详解"}
			} else {
				id := contentHash([]any{"image-v1", l.Book, l.Lesson, lessonEnglish(l), args.Prompt})
				im := aiImage{ID: id, Prompt: args.Prompt, Caption: args.Caption, URL: "/api/ai/images/" + id}
				j.update(func(v *jobSnapshot) { v.Warnings = append(v.Warnings, "正在生成配图："+args.Caption) })
				generated, e := s.makeImage(ctx, cfg, im, false)
				if e != nil {
					warning := "配图失败：" + e.Error()
					result.Warnings = append(result.Warnings, warning)
					result.Images = append(result.Images, im)
					toolResult = map[string]string{"error": warning, "imageId": im.ID}
				} else {
					result.Images = append(result.Images, generated)
					toolResult = map[string]string{"imageId": generated.ID, "url": generated.URL, "caption": generated.Caption}
				}
				j.update(func(v *jobSnapshot) { v.Images = copyValue(result.Images); v.Warnings = copyValue(result.Warnings) })
			}
			p.toolResult(call, toolResult)
		}
		if calls >= cfg.Image.MaxCalls {
			p.Tools = nil
			p.Messages = append(p.Messages, map[string]any{"role": "user", "content": "配图工具调用阶段已结束，请直接完成文字详解，不再请求工具。"})
		}
	}
	return nil, fmt.Errorf("工具调用轮次过多，已停止生成。请调整提示词后重试")
}
func (s *aiService) makeImage(ctx context.Context, cfg aiSettings, im aiImage, force bool) (aiImage, error) {
	s.imageMu.Lock()
	defer s.imageMu.Unlock()
	path := filepath.Join(s.root, "images", im.ID+".json")
	var old aiImage
	_ = loadJSON(path, &old)
	if !force && old.Version != "" {
		if _, err := os.Stat(filepath.Join(s.root, "images", im.ID+"."+old.Version+".bin")); err == nil {
			return old, nil
		}
	}
	// Persist the intended prompt even on failure so retry does not need a new text-model call.
	if old.Version == "" {
		if err := writeJSONAtomic(path, im); err != nil {
			return im, fmt.Errorf("配图存储不可写")
		}
	}
	c, cancel := context.WithTimeout(ctx, time.Duration(cfg.Image.Timeout)*time.Second)
	defer cancel()
	body := map[string]any{"model": cfg.Image.Model, "prompt": cfg.Prompts.Image + "\n" + im.Prompt, "n": 1}
	if cfg.Image.Size != "" {
		body["size"] = cfg.Image.Size
	}
	if cfg.Image.Quality != "" {
		body["quality"] = cfg.Image.Quality
	}
	resp, err := s.modelRequest(c, cfg.Image.modelConfig, "/images/generations", body)
	if err != nil {
		return im, err
	}
	defer resp.Body.Close()
	var data struct {
		Data []struct {
			Base64 string `json:"b64_json"`
			URL    string `json:"url"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 40<<20)).Decode(&data) != nil || len(data.Data) != 1 {
		return im, fmt.Errorf("生图接口返回内容无效")
	}
	var b []byte
	if data.Data[0].Base64 != "" {
		b, err = base64.StdEncoding.DecodeString(data.Data[0].Base64)
	} else {
		u, e := url.Parse(data.Data[0].URL)
		if e != nil || !validDownloadURL(u) {
			return im, fmt.Errorf("生图返回了无效图片地址")
		}
		req, e := http.NewRequestWithContext(c, "GET", u.String(), nil)
		if e != nil {
			return im, fmt.Errorf("图片地址无效")
		}
		client := *s.client
		client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
			if len(via) > 5 || !validDownloadURL(r.URL) {
				return fmt.Errorf("invalid image redirect")
			}
			return nil
		}
		download, e := client.Do(req)
		if e != nil {
			return im, fmt.Errorf("图片下载失败")
		}
		defer download.Body.Close()
		if download.StatusCode != 200 {
			return im, fmt.Errorf("图片下载失败")
		}
		b, err = io.ReadAll(io.LimitReader(download.Body, (24<<20)+1))
	}
	if err != nil || len(b) == 0 || len(b) > 24<<20 {
		return im, fmt.Errorf("图片内容无效或超过 24 MB")
	}
	mime := http.DetectContentType(b)
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/gif" {
		return im, fmt.Errorf("生图返回的不是支持的图片")
	}
	dir := filepath.Join(s.root, "images")
	f, e := os.CreateTemp(dir, ".image-*")
	if e != nil {
		return im, fmt.Errorf("图片保存失败")
	}
	name := f.Name()
	defer os.Remove(name)
	_ = f.Chmod(0600)
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return im, fmt.Errorf("图片保存失败")
	}
	im.Version = contentHash(b)
	if os.Rename(name, filepath.Join(dir, im.ID+"."+im.Version+".bin")) != nil {
		return im, fmt.Errorf("图片保存失败")
	}
	im.CreatedAt = nowISO()
	im.Model = cfg.Image.Model
	im.URL = "/api/ai/images/" + im.ID + "?v=" + im.Version[:12]
	if writeJSONAtomic(path, im) != nil {
		return im, fmt.Errorf("图片索引保存失败")
	}
	return im, nil
}
func validDownloadURL(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

func (s *aiService) readExplanation(path string, out *explanation) error {
	if err := loadJSON(path, out); err != nil {
		return err
	}
	for i, image := range out.Images {
		var current aiImage
		if loadJSON(filepath.Join(s.root, "images", image.ID+".json"), &current) == nil && current.Version != "" {
			out.Images[i] = current
		}
	}
	return nil
}
