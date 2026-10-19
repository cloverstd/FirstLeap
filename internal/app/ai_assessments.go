package app

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
)

type learningFeedback struct {
	ExplanationID string `json:"explanationId"`
	Rating        string `json:"rating"`
	Dimension     string `json:"dimension"`
	At            string `json:"at"`
}
type assessmentAudio struct {
	Book       int    `json:"book"`
	Lesson     int    `json:"lesson"`
	Segment    string `json:"segment"`
	URL        string `json:"url"`
	Transcript string `json:"transcript,omitempty"`
}
type assessmentQuestion struct {
	ID          string           `json:"id"`
	Dimension   string           `json:"dimension"`
	Difficulty  int              `json:"difficulty"`
	Text        string           `json:"text"`
	Options     []string         `json:"options"`
	Answer      int              `json:"answer"`
	Explanation string           `json:"explanation"`
	AudioIndex  int              `json:"audioIndex"`
	Audio       *assessmentAudio `json:"audio,omitempty"`
	Unavailable bool             `json:"unavailable"`
}
type assessmentAnswer struct {
	Question assessmentQuestion `json:"question"`
	Choice   int                `json:"choice"`
	Correct  bool               `json:"correct"`
	Skipped  bool               `json:"skipped"`
	Unknown  bool               `json:"unknown,omitempty"`
}
type assessmentSession struct {
	ID              string              `json:"id"`
	Status          string              `json:"status"`
	CreatedAt       string              `json:"createdAt"`
	Answers         []assessmentAnswer  `json:"answers"`
	Question        *assessmentQuestion `json:"question"`
	Report          string              `json:"report"`
	ProfileRevision int                 `json:"profileRevision"`
}

func publicAssessment(a assessmentSession) map[string]any {
	var q any
	if a.Question != nil {
		v := a.Question
		var audio any
		if v.Audio != nil {
			copy := *v.Audio
			copy.Transcript = ""
			audio = copy
		}
		q = map[string]any{"id": v.ID, "dimension": v.Dimension, "difficulty": v.Difficulty, "text": v.Text, "options": v.Options, "audio": audio, "unavailable": v.Unavailable}
	}
	return map[string]any{"id": a.ID, "status": a.Status, "createdAt": a.CreatedAt, "answers": a.Answers, "question": q, "report": a.Report, "total": 16}
}
func (s *aiService) assessmentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/learner/feedback", func(w http.ResponseWriter, r *http.Request) {
		var req learningFeedback
		if !decodeBody(w, r, &req) {
			return
		}
		if !hashID.MatchString(req.ExplanationID) || (req.Rating != "hard" && req.Rating != "okay" && req.Rating != "easy") {
			failure(w, 400, "反馈无效")
			return
		}
		if req.Dimension != "" && req.Dimension != "vocabulary" && req.Dimension != "grammar" && req.Dimension != "reading" && req.Dimension != "listening" {
			failure(w, 400, "能力维度无效")
			return
		}
		var exp explanation
		if loadJSON(s.explanationPath(req.ExplanationID), &exp) != nil {
			failure(w, 404, "详解不存在")
			return
		}
		req.At = nowISO()
		s.mu.Lock()
		before := copyValue(s.state)
		s.state.Feedback[req.ExplanationID] = req
		p := copyValue(s.state.Profile.profileData)
		switch req.Rating {
		case "hard":
			p.Style = "foundation"
		case "easy":
			p.Style = "concise"
		case "okay":
			p.Style = "balanced"
		}
		s.applyProfile(p, "根据讲解难度反馈调整表达方式")
		count := len(s.state.Feedback)
		needs := count-s.state.FeedbackEvaluated >= 3
		profile := copyValue(s.state.Profile)
		if s.saveState() != nil {
			s.state = before
			s.mu.Unlock()
			failure(w, 500, "反馈保存失败")
			return
		}
		s.mu.Unlock()
		job := ""
		if needs {
			job = s.startFeedbackEvaluation(count)
		}
		jsonResponse(w, 200, map[string]any{"saved": true, "profile": profile, "jobId": job})
	})
	mux.HandleFunc("GET /api/assessments", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		list := []map[string]any{}
		for _, a := range s.state.Assessments {
			list = append(list, map[string]any{"id": a.ID, "status": a.Status, "createdAt": a.CreatedAt, "answered": len(a.Answers), "report": a.Report})
		}
		sort.Slice(list, func(i, j int) bool { return list[i]["createdAt"].(string) > list[j]["createdAt"].(string) })
		jsonResponse(w, 200, list)
	})
	mux.HandleFunc("POST /api/assessments", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			New bool `json:"new"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		cfg := s.settingsSnapshot()
		if !configured(cfg.Text.modelConfig) {
			failure(w, 409, "请先配置文字模型，再开始测评")
			return
		}
		s.mu.Lock()
		var a *assessmentSession
		if !req.New {
			for _, old := range s.state.Assessments {
				if old.Status != "done" {
					if a == nil || old.CreatedAt > a.CreatedAt {
						a = old
					}
				}
			}
		}
		if a == nil {
			a = &assessmentSession{ID: uniqueID(), Status: "active", CreatedAt: nowISO(), Answers: []assessmentAnswer{}, ProfileRevision: s.state.Profile.Revision}
			s.state.Assessments[a.ID] = a
			if s.saveState() != nil {
				delete(s.state.Assessments, a.ID)
				s.mu.Unlock()
				failure(w, 500, "测评保存失败")
				return
			}
		}
		id := a.ID
		s.mu.Unlock()
		job := s.advanceAssessment(id)
		s.mu.Lock()
		result := publicAssessment(copyValue(*s.state.Assessments[id]))
		s.mu.Unlock()
		jsonResponse(w, 200, map[string]any{"session": result, "jobId": job})
	})
	mux.HandleFunc("GET /api/assessments/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		a := s.state.Assessments[r.PathValue("id")]
		if a == nil {
			failure(w, 404, "测评不存在")
			return
		}
		job := s.pending["assessment:"+a.ID]
		jsonResponse(w, 200, map[string]any{"session": publicAssessment(copyValue(*a)), "jobId": job})
	})
	mux.HandleFunc("POST /api/assessments/{id}/answers", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			QuestionID string `json:"questionId"`
			Choice     *int   `json:"choice"`
			Unknown    bool   `json:"unknown"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		if (req.Unknown && req.Choice != nil) || (!req.Unknown && req.Choice == nil) {
			failure(w, 400, "请选择一个答案或“不知道”")
			return
		}
		choice := -2 // A distinct persisted value for an explicit "I don't know" answer.
		if req.Choice != nil {
			choice = *req.Choice
		}
		id := r.PathValue("id")
		s.mu.Lock()
		a := s.state.Assessments[id]
		if a == nil {
			s.mu.Unlock()
			failure(w, 404, "测评不存在")
			return
		}
		for _, answer := range a.Answers {
			if answer.Question.ID == req.QuestionID {
				s.mu.Unlock()
				job := s.advanceAssessment(id)
				s.mu.Lock()
				result := publicAssessment(copyValue(*s.state.Assessments[id]))
				s.mu.Unlock()
				jsonResponse(w, 200, map[string]any{"session": result, "jobId": job})
				return
			}
		}
		if a.Question == nil || a.Question.ID != req.QuestionID || (!req.Unknown && (choice < -1 || choice > 3 || choice >= len(a.Question.Options))) || (req.Unknown && a.Question.Unavailable) {
			s.mu.Unlock()
			failure(w, 409, "题目已更新，请重新读取测评")
			return
		}
		if choice == -1 && !a.Question.Unavailable && a.Question.Dimension != "listening" {
			s.mu.Unlock()
			failure(w, 400, "请选择一个答案")
			return
		}
		before := copyValue(*a)
		q := *a.Question
		a.Answers = append(a.Answers, assessmentAnswer{Question: q, Choice: choice, Correct: !req.Unknown && choice == q.Answer && choice >= 0, Skipped: choice == -1, Unknown: req.Unknown})
		a.Question = nil
		if s.saveState() != nil {
			*a = before
			s.mu.Unlock()
			failure(w, 500, "答案保存失败")
			return
		}
		s.mu.Unlock()
		job := s.advanceAssessment(id)
		s.mu.Lock()
		result := publicAssessment(copyValue(*s.state.Assessments[id]))
		s.mu.Unlock()
		jsonResponse(w, 200, map[string]any{"session": result, "jobId": job})
	})
	mux.HandleFunc("POST /api/assessments/{id}/continue", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		a := s.state.Assessments[r.PathValue("id")]
		s.mu.Unlock()
		if a == nil {
			failure(w, 404, "测评不存在")
			return
		}
		jsonResponse(w, 202, map[string]string{"jobId": s.advanceAssessment(r.PathValue("id"))})
	})
}
func (s *aiService) startFeedbackEvaluation(count int) string {
	cfg := s.settingsSnapshot()
	if !configured(cfg.Text.modelConfig) {
		return ""
	}
	return s.startJob("profile-evaluation", func(ctx context.Context, j *aiJob) (any, error) {
		s.mu.Lock()
		base := copyValue(s.state.Profile)
		evidence := []learningFeedback{}
		for _, f := range s.state.Feedback {
			evidence = append(evidence, f)
		}
		s.mu.Unlock()
		sort.Slice(evidence, func(i, j int) bool { return evidence[i].At > evidence[j].At })
		if len(evidence) > 30 {
			evidence = evidence[:30]
		}
		// Give the evaluator the actual teaching context, rather than opaque cache IDs.
		examples := []map[string]any{}
		for _, feedback := range evidence {
			if len(examples) >= 6 {
				break
			}
			var exp explanation
			if loadJSON(s.explanationPath(feedback.ExplanationID), &exp) != nil {
				continue
			}
			excerpt := []rune(exp.Content)
			if len(excerpt) > 800 {
				excerpt = excerpt[:800]
			}
			example := map[string]any{"id": feedback.ExplanationID, "book": exp.Book, "lesson": exp.Lesson, "target": exp.Target, "level": exp.Context.Profile.Level, "explanationExcerpt": string(excerpt)}
			if lesson, err := s.app.textLesson(exp.Book, exp.Lesson); err == nil {
				_, text, err := resolveTarget(lesson, exp.Target)
				if err == nil {
					runes := []rune(text)
					if len(runes) > 1200 {
						runes = runes[:1200]
					}
					example["targetText"] = string(runes)
				}
			}
			examples = append(examples, example)
		}
		result, reason, err := s.evaluateProfile(ctx, cfg, base.profileData, map[string]any{"feedback": evidence, "examples": examples}, true)
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.state.Profile.Revision != base.Revision {
			return nil, fmt.Errorf("档案已更新，本次评估未覆盖新档案；下次反馈时会重评")
		}
		before := copyValue(s.state)
		s.applyProfile(result, reason)
		s.state.FeedbackEvaluated = count
		if s.saveState() != nil {
			s.state = before
			return nil, fmt.Errorf("能力评估保存失败")
		}
		return s.state.Profile, nil
	})
}
func (s *aiService) evaluateProfile(ctx context.Context, cfg aiSettings, base profileData, evidence any, feedback bool) (profileData, string, error) {
	var output struct {
		Level      *int           `json:"level"`
		Abilities  map[string]int `json:"abilities"`
		Weaknesses []string       `json:"weaknesses"`
		Reason     string         `json:"reason"`
	}
	schema := `返回 {"level":-1到4整数,"abilities":{"vocabulary":-1到4整数,"grammar":-1到4整数,"reading":-1到4整数,"listening":-1到4整数},"weaknesses":["有证据支持的薄弱项"],"reason":"解释判断依据"}。-1未评估，0入门，1初级，2中级，3中高级，4高级。不要评估口语或写作。答题记录中 unknown=true、choice=-2 表示学习者明确选择“不知道”，是尚未掌握的有效答题证据。skipped=true 表示因题目或音频不可用而跳过，不作为答错证据。`
	if err := s.structured(ctx, cfg, cfg.Prompts.Evaluation+"\n"+schema, map[string]any{"profile": base, "evidence": evidence, "feedbackOnly": feedback}, &output); err != nil {
		return base, "", err
	}
	if output.Level == nil || *output.Level < -1 || *output.Level > 4 || len(output.Weaknesses) > 30 || output.Reason == "" || len(output.Reason) > 4000 {
		return base, "", fmt.Errorf("能力评估结果无效")
	}
	next := copyValue(base)
	level := *output.Level
	if feedback {
		level = boundedLevel(base.Level, level)
	}
	next.Level = level
	for _, d := range dimensions[:4] {
		level, ok := output.Abilities[d]
		if !ok || level < -1 || level > 4 {
			return base, "", fmt.Errorf("能力评估维度无效")
		}
		a := next.Abilities[d]
		if a.Locked {
			continue
		}
		if feedback {
			level = boundedLevel(a.Level, level)
			hasEvidence := false
			if ev, ok := evidence.(map[string]any); ok {
				if fs, ok := ev["feedback"].([]learningFeedback); ok {
					for _, f := range fs {
						if f.Dimension == d {
							hasEvidence = true
						}
					}
				}
			}
			if !hasEvidence {
				continue
			}
		}
		if !feedback {
			answered := 0
			if answers, ok := evidence.([]assessmentAnswer); ok {
				for _, answer := range answers {
					if answer.Question.Dimension == d && !answer.Skipped {
						answered++
					}
				}
			}
			if answered < 4 {
				continue
			}
		}
		a.Level = level
		if feedback {
			a.Source = "feedback"
		} else {
			a.Source = "assessment"
		}
		next.Abilities[d] = a
	}
	next.Weaknesses = output.Weaknesses
	if !validProfile(next) {
		return base, "", fmt.Errorf("能力评估结果无效")
	}
	return next, output.Reason, nil
}
func boundedLevel(old, next int) int {
	if old < 0 {
		return old
	}
	if next > old+1 {
		return old + 1
	}
	if next < old-1 {
		return old - 1
	}
	return next
}
func (s *aiService) advanceAssessment(id string) string {
	s.mu.Lock()
	a := s.state.Assessments[id]
	if a == nil || a.Status == "done" || a.Question != nil {
		s.mu.Unlock()
		return ""
	}
	s.mu.Unlock()
	return s.startJob("assessment:"+id, func(ctx context.Context, j *aiJob) (any, error) {
		s.mu.Lock()
		session := copyValue(*s.state.Assessments[id])
		base := copyValue(s.state.Profile)
		s.mu.Unlock()
		cfg := s.settingsSnapshot()
		if len(session.Answers) >= 16 {
			next, reason, err := s.evaluateProfile(ctx, cfg, base.profileData, session.Answers, false)
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if base.Revision != s.state.Profile.Revision {
				return nil, fmt.Errorf("档案已更新，请重试完成测评")
			}
			before := copyValue(s.state)
			s.applyProfile(next, "动态测评："+reason)
			a := s.state.Assessments[id]
			a.Status = "done"
			a.Report = reason
			if s.saveState() != nil {
				s.state = before
				return nil, fmt.Errorf("测评结果保存失败")
			}
			return publicAssessment(copyValue(*a)), nil
		}
		dim := dimensions[len(session.Answers)%4]
		audio := []assessmentAudio{}
		if dim == "listening" {
			audio = s.audioCandidates(session)
		}
		q := assessmentQuestion{ID: uniqueID(), Dimension: dim, Difficulty: base.Level, Options: []string{}}
		if dim == "listening" && len(audio) == 0 {
			q.Text = "当前没有可用原音，听力部分暂未测评。可以稍后重新测评。"
			q.Unavailable = true
		} else {
			schema := `返回 {"text":"中文题干，阅读题附英文材料，听力题不泄露原音文字","options":["选项A","选项B","选项C","选项D"],"answer":0到3正确选项下标,"explanation":"中文答案解析","difficulty":0到4整数,"audioIndex":听力所选原音下标，其他为-1}。不要调用任何工具。应用会额外提供“不知道”选项，不要将它加入 options。priorAnswers 中 unknown=true、choice=-2 表示学习者明确选择“不知道”，请作为尚未掌握的证据调整难度；skipped=true 是因题目或音频不可用而跳过，不作为答错证据。`
			var generated struct {
				Text        string   `json:"text"`
				Options     []string `json:"options"`
				Answer      *int     `json:"answer"`
				Explanation string   `json:"explanation"`
				Difficulty  *int     `json:"difficulty"`
				AudioIndex  *int     `json:"audioIndex"`
			}
			if err := s.structured(ctx, cfg, cfg.Prompts.Assessment+"\n"+schema, map[string]any{"dimension": dim, "profile": base.profileData, "priorAnswers": session.Answers, "audioCandidates": audio}, &generated); err != nil {
				return nil, err
			}
			if len(generated.Options) != 4 || generated.Answer == nil || *generated.Answer < 0 || *generated.Answer > 3 || generated.Difficulty == nil || *generated.Difficulty < 0 || *generated.Difficulty > 4 || generated.Text == "" || len(generated.Text) > 12000 || generated.Explanation == "" {
				return nil, fmt.Errorf("AI 题目格式无效，请重试")
			}
			seen := map[string]bool{}
			for _, v := range generated.Options {
				if v == "" || len(v) > 4000 || seen[v] {
					return nil, fmt.Errorf("AI 题目选项无效，请重试")
				}
				seen[v] = true
			}
			q.Text = generated.Text
			q.Options = generated.Options
			q.Answer = *generated.Answer
			q.Explanation = generated.Explanation
			q.Difficulty = *generated.Difficulty
			if dim == "listening" {
				if generated.AudioIndex == nil || *generated.AudioIndex < 0 || *generated.AudioIndex >= len(audio) {
					return nil, fmt.Errorf("AI 选择的原音无效，请重试")
				}
				chosen := audio[*generated.AudioIndex]
				q.Audio = &chosen
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		a := s.state.Assessments[id]
		if len(a.Answers) != len(session.Answers) || a.Question != nil {
			return publicAssessment(copyValue(*a)), nil
		}
		a.Question = &q
		if s.saveState() != nil {
			a.Question = nil
			return nil, fmt.Errorf("测评题目保存失败")
		}
		return publicAssessment(copyValue(*a)), nil
	})
}
func (s *aiService) audioCandidates(session assessmentSession) []assessmentAudio {
	out := []assessmentAudio{}
	used := map[string]bool{}
	for _, a := range session.Answers {
		if a.Question.Audio != nil {
			used[a.Question.Audio.URL] = true
		}
	}
	// Sample actual, aligned sentences; a model may choose only among these references.
	offset := len(session.Answers) / 4
	for book := 1; book <= 4; book++ {
		catalog := s.app.textBook(book)
		for i, summary := range catalog.Lessons {
			if i%5 != offset%5 {
				continue
			}
			if _, err := os.Stat(filepath.Join(s.app.cfg.TextbookRoot, audioRelative(book, summary.Lesson))); err != nil {
				continue
			}
			l, err := s.app.textLesson(book, summary.Lesson)
			if err != nil {
				continue
			}
			for _, p := range l.Paragraphs {
				for _, sent := range p.Sentences {
					if !validBounds(sent.Start, sent.End, l.Duration) || *sent.End-*sent.Start < 1 || *sent.End-*sent.Start > 25 {
						continue
					}
					url := fmt.Sprintf("/api/books/%d/lessons/%d/clips/%s", book, l.Lesson, sent.ID)
					if used[url] {
						continue
					}
					out = append(out, assessmentAudio{Book: book, Lesson: l.Lesson, Segment: sent.ID, URL: url, Transcript: sent.Text})
					break
				}
				if len(out) >= (book * 2) {
					break
				}
			}
			if len(out) >= (book * 2) {
				break
			}
		}
	}
	return out
}
