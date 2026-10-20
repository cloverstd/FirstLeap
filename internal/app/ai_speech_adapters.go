package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"unicode/utf8"
)

const maxSpeechBytes = 32 << 20

type speechCapabilities struct {
	ID           string    `json:"id"`
	Label        string    `json:"label"`
	ModelListing bool      `json:"modelListing"`
	MinSpeed     float64   `json:"minSpeed"`
	MaxSpeed     float64   `json:"maxSpeed"`
	Defaults     ttsConfig `json:"defaults"`
}

type speechAdapter struct {
	capabilities speechCapabilities
	validate     func(ttsConfig) error
	synthesize   func(context.Context, *aiService, ttsConfig, string, io.Writer) error
}

func speechAdapters() []speechAdapter {
	openai := defaultTTSConfig()
	openai.APIType = "openai"
	native := defaultTTSConfig()
	native.BaseURL, native.AuthMode = "https://openspeech.bytedance.com/api/v3", "api-key"
	tts, audio := native, native
	tts.APIType, tts.ResourceID = "doubao-tts", "seed-tts-2.0"
	audio.APIType, audio.Model = "doubao-audio", "seed-audio-1.0"
	return []speechAdapter{
		{speechCapabilities{"openai", "OpenAI 兼容", true, .25, 4, openai}, validateOpenAISpeech, synthesizeOpenAISpeech},
		{speechCapabilities{"doubao-tts", "豆包语音合成 Seed TTS", false, .5, 2, tts}, validateDoubaoTTS, synthesizeDoubaoTTS},
		{speechCapabilities{"doubao-audio", "豆包音频生成 Seed Audio", false, .5, 2, audio}, validateDoubaoAudio, synthesizeDoubaoAudio},
	}
}

func speechAdapterFor(c ttsConfig) (speechAdapter, error) {
	for _, a := range speechAdapters() {
		if a.capabilities.ID == speechAPIType(c) {
			return a, nil
		}
	}
	return speechAdapter{}, fmt.Errorf("不支持的语音接口类型")
}
func speechAPIType(c ttsConfig) string {
	if c.APIType == "" {
		return "openai"
	}
	return c.APIType
}
func speechAuthMode(c ttsConfig) string {
	if c.AuthMode == "" {
		return "api-key"
	}
	return c.AuthMode
}
func speechCapabilityList() []speechCapabilities {
	list := []speechCapabilities{}
	for _, a := range speechAdapters() {
		list = append(list, a.capabilities)
	}
	return list
}
func (p *aiProviders) savedTTS(id string) ttsConfig {
	for _, v := range p.TTS {
		if v.ID == id {
			return v.Config
		}
	}
	return ttsConfig{}
}
func prepareTTS(c *ttsConfig, saved ttsConfig) error {
	if !c.ClearKey && c.APIKey == "" && saved.APIKey != "" &&
		(speechAPIType(*c) != speechAPIType(saved) || speechAuthMode(*c) != speechAuthMode(saved) || c.AppID != saved.AppID) {
		return fmt.Errorf("语音接口或鉴权身份已更改，请重新填写密钥，或勾选清除 Key")
	}
	return prepareModel(&c.modelConfig, saved.modelConfig)
}
func configuredTTS(c ttsConfig) bool {
	if !validBase(c.BaseURL) || c.BaseURL == "" {
		return false
	}
	switch speechAPIType(c) {
	case "doubao-tts":
		return c.APIKey != "" && c.ResourceID != "" && c.Voice != "" && (speechAuthMode(c) != "app-token" || c.AppID != "")
	case "doubao-audio":
		return c.APIKey != "" && strings.TrimSpace(c.Model) != "" && (speechAuthMode(c) != "app-token" || c.AppID != "")
	case "openai":
		return configured(c.modelConfig)
	}
	return false
}
func validateTTS(c ttsConfig) error {
	a, err := speechAdapterFor(c)
	if err != nil {
		return err
	}
	if !validModelFields(c.modelConfig) || len(c.Voice) > 512 || math.IsNaN(c.Speed) || c.Speed < a.capabilities.MinSpeed || c.Speed > a.capabilities.MaxSpeed || (c.Format != "mp3" && c.Format != "wav") || c.Timeout < 30 || c.Timeout > 1800 || len(c.Instructions) > 16000 {
		return fmt.Errorf("请检查语音接口、音色、合成语速、格式和超时设置")
	}
	if b, err := json.Marshal(c.Extra); err != nil || len(b) > 64<<10 {
		return fmt.Errorf("语音高级参数必须是有效 JSON 对象且不超过 64 KB")
	}
	if err := a.validate(c); err != nil {
		return err
	}
	if c.Enabled && !configuredTTS(c) {
		return fmt.Errorf("启用语音前请填写所选接口需要的地址、模型或资源 ID、音色及鉴权信息")
	}
	return nil
}
func rejectSpeechFields(extra map[string]any, keys ...string) error {
	for _, key := range keys {
		if _, ok := extra[key]; ok {
			return fmt.Errorf("语音高级参数不能覆盖 %s", key)
		}
	}
	return nil
}
func validateOpenAISpeech(c ttsConfig) error {
	if c.InstructionField != "none" && c.InstructionField != "instructions" && c.InstructionField != "instruct" {
		return fmt.Errorf("语音风格指令字段无效")
	}
	return rejectSpeechFields(c.Extra, "model", "input", "voice", "speed", "response_format", "instructions", "instruct", "stream", "stream_format")
}
func validateDoubaoAuth(c ttsConfig) error {
	if (speechAuthMode(c) != "api-key" && speechAuthMode(c) != "app-token") || len(c.AppID) > 256 || len(c.ResourceID) > 256 || strings.ContainsAny(c.AppID+c.ResourceID, "\r\n") {
		return fmt.Errorf("请检查豆包鉴权方式、App ID 和资源 ID")
	}
	return nil
}
func validateAudioOptions(extra map[string]any, field string) error {
	raw, exists := extra[field]
	if !exists {
		return nil
	}
	options, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s 必须为 JSON 对象", field)
	}
	if err := rejectSpeechFields(options, "format", "speech_rate"); err != nil {
		return err
	}
	if sr, exists := options["sample_rate"]; exists {
		n, ok := sr.(float64)
		if !ok || (n != 8000 && n != 16000 && n != 22050 && n != 24000 && n != 32000 && n != 40000 && n != 44100 && n != 48000) {
			return fmt.Errorf("sample_rate 无效")
		}
	}
	return nil
}
func validateDoubaoTTS(c ttsConfig) error {
	if err := validateDoubaoAuth(c); err != nil {
		return err
	}
	if err := rejectSpeechFields(c.Extra, "text", "model", "speaker", "ssml", "req_params", "user", "namespace"); err != nil {
		return err
	}
	if err := validateAudioOptions(c.Extra, "audio_params"); err != nil {
		return err
	}
	if options, ok := c.Extra["audio_params"].(map[string]any); ok && options["sample_rate"] == float64(40000) {
		return fmt.Errorf("豆包语音合成不支持 40000 Hz 采样率")
	}
	if raw, ok := c.Extra["additions"]; ok {
		additions, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("additions 必须为 JSON 对象")
		}
		if err := rejectSpeechFields(additions, "context_texts", "use_tag_parser"); err != nil {
			return err
		}
	}
	if c.Instructions != "" && c.Model != "" {
		return fmt.Errorf("指定豆包复刻模型版本时不支持风格指令，请清空 Model 或风格指令")
	}
	return nil
}
func validateDoubaoAudio(c ttsConfig) error {
	if err := validateDoubaoAuth(c); err != nil {
		return err
	}
	// Reserve space for the fixed prompt, voice reference and a 300-rune segment.
	if utf8.RuneCountInString(c.Instructions) > 2500 {
		return fmt.Errorf("豆包音频生成的风格指令不能超过 2500 字符")
	}
	if err := rejectSpeechFields(c.Extra, "model", "text_prompt", "speaker", "references"); err != nil {
		return err
	}
	return validateAudioOptions(c.Extra, "audio_config")
}

type limitedSpeechWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *limitedSpeechWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, fmt.Errorf("音频响应超过 32 MB")
	}
	n, err := w.writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}
func synthesizeOpenAISpeech(ctx context.Context, s *aiService, c ttsConfig, text string, out io.Writer) error {
	body := copyValue(c.Extra)
	if body == nil {
		body = map[string]any{}
	}
	body["model"], body["input"], body["speed"], body["response_format"] = c.Model, text, c.Speed, c.Format
	if c.Voice != "" {
		body["voice"] = c.Voice
	}
	if c.InstructionField != "none" && c.Instructions != "" {
		body[c.InstructionField] = c.Instructions
	}
	resp, err := s.modelRequest(ctx, c.modelConfig, "/audio/speech", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, err = io.Copy(out, io.LimitReader(resp.Body, maxSpeechBytes+1))
	return err
}
func doubaoRequest(ctx context.Context, s *aiService, c ttsConfig, path string, body any) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("语音请求参数无效")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("语音接口地址无效")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Request-Id", speechRequestID())
	if speechAuthMode(c) == "app-token" {
		req.Header.Set("X-Api-App-Id", c.AppID)
		req.Header.Set("X-Api-Access-Key", c.APIKey)
	} else {
		req.Header.Set("X-Api-Key", c.APIKey)
	}
	if speechAPIType(c) == "doubao-tts" {
		req.Header.Set("X-Api-Resource-Id", c.ResourceID)
	}
	client := *s.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接语音服务或请求已取消／超时")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return nil, fmt.Errorf("豆包认证失败，请检查密钥、App ID 和资源权限")
		}
		if resp.StatusCode == 429 {
			return nil, fmt.Errorf("豆包请求额度或频率已达上限")
		}
		return nil, fmt.Errorf("豆包语音接口返回 HTTP %d，请检查模型、音色和参数", resp.StatusCode)
	}
	return resp, nil
}
func speechRequestID() string {
	// uniqueID is 16 cryptographically random bytes, formatted here as a UUID.
	id := uniqueID()
	return id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]
}
func speechOptions(extra map[string]any, field string, c ttsConfig) map[string]any {
	options, _ := extra[field].(map[string]any)
	if options == nil {
		options = map[string]any{}
	}
	options["format"], options["speech_rate"] = c.Format, int(math.Round((c.Speed-1)*100))
	if _, ok := options["sample_rate"]; !ok {
		options["sample_rate"] = 24000
	}
	return options
}
func synthesizeDoubaoTTS(ctx context.Context, s *aiService, c ttsConfig, text string, out io.Writer) error {
	body := copyValue(c.Extra)
	if body == nil {
		body = map[string]any{}
	}
	body["text"], body["speaker"] = text, c.Voice
	if c.Model != "" {
		body["model"] = c.Model
	}
	options := speechOptions(body, "audio_params", c)
	if c.Format == "wav" {
		options["format"] = "pcm"
	}
	body["audio_params"] = options
	additions, _ := body["additions"].(map[string]any)
	if c.Instructions != "" {
		if additions == nil {
			additions = map[string]any{}
		}
		additions["context_texts"] = []string{c.Instructions}
	}
	if additions != nil {
		encoded, _ := json.Marshal(additions)
		body["additions"] = string(encoded)
	}
	resp, err := doubaoRequest(ctx, s, c, "/tts/unidirectional", map[string]any{"req_params": body})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	// Decode consecutive JSON records, independent of HTTP chunk and line boundaries.
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 48<<20))
	var pcm bytes.Buffer
	target := out
	if c.Format == "wav" {
		target = &limitedSpeechWriter{writer: &pcm, remaining: maxSpeechBytes - 44}
	}
	for {
		var frame struct {
			Code *int   `json:"code"`
			Data string `json:"data"`
		}
		if err := decoder.Decode(&frame); err != nil {
			return fmt.Errorf("豆包语音流未完整结束或响应无法解析")
		}
		if frame.Code == nil {
			return fmt.Errorf("豆包语音流缺少状态码")
		}
		if *frame.Code == 20000000 {
			break
		}
		if *frame.Code != 0 {
			return fmt.Errorf("豆包语音合成失败（错误码 %d），请检查音色、资源和参数", *frame.Code)
		}
		if frame.Data != "" {
			audio, err := base64.StdEncoding.DecodeString(frame.Data)
			if err != nil {
				return fmt.Errorf("豆包语音流包含无效音频编码")
			}
			if _, err = target.Write(audio); err != nil {
				return err
			}
		}
	}
	if c.Format == "wav" {
		sr, _ := options["sample_rate"].(float64)
		if sr == 0 {
			sr = 24000
		}
		return writeSpeechWAV(out, pcm.Bytes(), uint32(sr))
	}
	return nil
}
func writeSpeechWAV(out io.Writer, pcm []byte, sampleRate uint32) error {
	if len(pcm) == 0 || len(pcm)%2 != 0 {
		return fmt.Errorf("豆包返回的 PCM 音频无效")
	}
	var header bytes.Buffer
	header.WriteString("RIFF")
	_ = binary.Write(&header, binary.LittleEndian, uint32(36+len(pcm)))
	header.WriteString("WAVEfmt ")
	_ = binary.Write(&header, binary.LittleEndian, uint32(16))
	for _, v := range []uint16{1, 1} {
		_ = binary.Write(&header, binary.LittleEndian, v)
	}
	_ = binary.Write(&header, binary.LittleEndian, sampleRate)
	_ = binary.Write(&header, binary.LittleEndian, sampleRate*2)
	for _, v := range []uint16{2, 16} {
		_ = binary.Write(&header, binary.LittleEndian, v)
	}
	header.WriteString("data")
	_ = binary.Write(&header, binary.LittleEndian, uint32(len(pcm)))
	if _, err := out.Write(header.Bytes()); err != nil {
		return err
	}
	_, err := out.Write(pcm)
	return err
}
func synthesizeDoubaoAudio(ctx context.Context, s *aiService, c ttsConfig, text string, out io.Writer) error {
	prompt := "请用一位英语老师的声音逐字朗读以下讲稿，保留中英文原文，不增删内容，不添加背景音乐或音效。"
	if c.Voice != "" {
		prompt += "使用@音频1的音色。"
	}
	if c.Instructions != "" {
		prompt += "朗读风格：" + c.Instructions + "。"
	}
	prompt += "\n讲稿：\n" + text
	if utf8.RuneCountInString(prompt) > 3000 {
		return fmt.Errorf("豆包音频生成的讲稿与风格指令合计不能超过 3000 字符")
	}
	body := copyValue(c.Extra)
	if body == nil {
		body = map[string]any{}
	}
	body["model"], body["text_prompt"], body["audio_config"] = c.Model, prompt, speechOptions(body, "audio_config", c)
	if c.Voice != "" {
		body["references"] = []any{map[string]string{"speaker": c.Voice}}
	}
	resp, err := doubaoRequest(ctx, s, c, "/tts/create", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 48<<20))
	var result struct {
		Code  int    `json:"code"`
		Audio string `json:"audio"`
	}
	if err := decoder.Decode(&result); err != nil {
		return fmt.Errorf("豆包音频生成响应无法解析或超过大小限制")
	}
	if result.Code != 0 {
		return fmt.Errorf("豆包音频生成失败（错误码 %d），请检查模型、音色和参数", result.Code)
	}
	if result.Audio == "" {
		return fmt.Errorf("豆包未返回音频数据")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("豆包音频响应包含多余数据")
	}
	_, err = io.Copy(out, base64.NewDecoder(base64.StdEncoding, strings.NewReader(result.Audio)))
	if err != nil {
		return fmt.Errorf("豆包音频编码无效、超过大小限制或保存失败")
	}
	return nil
}
