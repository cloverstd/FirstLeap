package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type toolCall struct {
	ID        string
	Name      string
	Arguments string
}
type providerTurn struct {
	Text      string
	Calls     []toolCall
	Items     []map[string]any
	Usage     map[string]any
	Assistant map[string]any
}
type providerSession struct {
	Config   textConfig
	Messages []map[string]any
	System   string
	Tools    []map[string]any
}

func newProviderSession(c textConfig, system, user string, tools []map[string]any) *providerSession {
	p := &providerSession{Config: c, System: system, Tools: tools}
	if c.Protocol == "chat" {
		p.Messages = append(p.Messages, map[string]any{"role": "system", "content": system})
	}
	p.Messages = append(p.Messages, map[string]any{"role": "user", "content": user})
	return p
}
func imageTool(protocol string) map[string]any {
	f := map[string]any{"name": "generate_image", "description": "当情景或概念用图示比纯文字更容易理解时生成教学配图。不要为简单定义或无关内容配图。返回本站图片引用，可在 Markdown 中使用。", "parameters": map[string]any{"type": "object", "properties": map[string]any{"prompt": map[string]any{"type": "string", "description": "准确的场景和视觉细节"}, "caption": map[string]any{"type": "string", "description": "简短中文图注"}}, "required": []string{"prompt", "caption"}, "additionalProperties": false}, "strict": true}
	if protocol == "responses" {
		f["type"] = "function"
		return f
	}
	return map[string]any{"type": "function", "function": f}
}
func (p *providerSession) addTurn(t providerTurn) {
	if p.Config.Protocol == "responses" {
		p.Messages = append(p.Messages, t.Items...)
	} else {
		p.Messages = append(p.Messages, t.Assistant)
	}
}
func (p *providerSession) toolResult(call toolCall, result any) {
	b, _ := json.Marshal(result)
	if p.Config.Protocol == "responses" {
		p.Messages = append(p.Messages, map[string]any{"type": "function_call_output", "call_id": call.ID, "output": string(b)})
	} else {
		p.Messages = append(p.Messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": string(b)})
	}
}
func (s *aiService) turn(ctx context.Context, p *providerSession, onDelta func(string)) (providerTurn, error) {
	var out providerTurn
	if !configured(p.Config.modelConfig) {
		return out, fmt.Errorf("请先在系统配置中填写文字模型的接口地址和 Model")
	}
	body := map[string]any{"model": p.Config.Model, "stream": p.Config.Stream}
	path := "/chat/completions"
	if p.Config.Protocol == "responses" {
		path = "/responses"
		body["input"] = p.Messages
		body["instructions"] = p.System
		body["max_output_tokens"] = p.Config.MaxTokens
		body["store"] = false
		body["include"] = []string{"reasoning.encrypted_content"}
	} else {
		body["messages"] = p.Messages
		body[p.Config.TokenField] = p.Config.MaxTokens
		body["store"] = false
	}
	if p.Config.Temperature != nil {
		body["temperature"] = *p.Config.Temperature
	}
	if len(p.Tools) > 0 {
		body["tools"] = p.Tools
		body["tool_choice"] = "auto"
	}
	c, cancel := context.WithTimeout(ctx, time.Duration(p.Config.Timeout)*time.Second)
	defer cancel()
	resp, err := s.modelRequest(c, p.Config.modelConfig, path, body)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		var obj map[string]any
		if json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&obj) != nil {
			return out, fmt.Errorf("模型返回内容无法解析")
		}
		if p.Config.Protocol == "responses" {
			out, err = parseResponse(obj)
		} else {
			out, err = parseChat(obj)
		}
		if err == nil && onDelta != nil {
			onDelta(out.Text)
		}
		return out, err
	}
	calls := map[int]*toolCall{}
	items := []map[string]any{}
	finish := ""
	completed := false
	scanner := bufio.NewScanner(io.LimitReader(resp.Body, 16<<20))
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var eventData []string
	consume := func(data string) error {
		if data == "[DONE]" {
			completed = true
			return nil
		}
		var obj map[string]any
		if json.Unmarshal([]byte(data), &obj) != nil {
			return fmt.Errorf("模型流式响应无法解析")
		}
		if p.Config.Protocol == "responses" {
			switch obj["type"] {
			case "response.output_text.delta":
				d, _ := obj["delta"].(string)
				out.Text += d
				if onDelta != nil {
					onDelta(d)
				}
			case "response.output_item.done":
				if item, ok := obj["item"].(map[string]any); ok {
					items = append(items, item)
				}
			case "response.completed":
				r, _ := obj["response"].(map[string]any)
				t, e := parseResponse(r)
				if e != nil {
					return e
				}
				if out.Text == "" && onDelta != nil {
					onDelta(t.Text)
				}
				out = t
				completed = true
			case "response.failed", "response.incomplete", "error":
				return fmt.Errorf("模型未能完成回答，请检查配置或提高输出上限后重试")
			}
		} else {
			if usage, ok := obj["usage"].(map[string]any); ok {
				out.Usage = usage
			}
			choices, _ := obj["choices"].([]any)
			if len(choices) == 0 {
				return nil
			}
			choice, _ := choices[0].(map[string]any)
			if f, ok := choice["finish_reason"].(string); ok && f != "" {
				finish = f
			}
			delta, _ := choice["delta"].(map[string]any)
			if d, ok := delta["content"].(string); ok {
				out.Text += d
				if onDelta != nil {
					onDelta(d)
				}
			}
			list, _ := delta["tool_calls"].([]any)
			for _, v := range list {
				tc, _ := v.(map[string]any)
				index, _ := tc["index"].(float64)
				call := calls[int(index)]
				if call == nil {
					call = &toolCall{}
					calls[int(index)] = call
				}
				if id, ok := tc["id"].(string); ok {
					call.ID = id
				}
				if f, ok := tc["function"].(map[string]any); ok {
					if n, ok := f["name"].(string); ok {
						call.Name += n
					}
					if a, ok := f["arguments"].(string); ok {
						call.Arguments += a
					}
				}
			}
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(eventData) > 0 {
				if err = consume(strings.Join(eventData, "\n")); err != nil {
					return out, err
				}
				eventData = nil
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			eventData = append(eventData, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if len(eventData) > 0 {
		if err = consume(strings.Join(eventData, "\n")); err != nil {
			return out, err
		}
	}
	if scanner.Err() != nil {
		return out, fmt.Errorf("模型连接中断或超时，请重试")
	}
	if p.Config.Protocol == "responses" {
		if !completed {
			return out, fmt.Errorf("模型连接中断，回答尚未完成")
		}
		if len(out.Items) == 0 {
			out.Items = items
			out.Calls = callsFromItems(items)
		}
	} else {
		if finish == "length" || finish == "content_filter" {
			return out, fmt.Errorf("模型未完成回答，请提高输出上限或调整内容后重试")
		}
		if !completed || finish == "" {
			return out, fmt.Errorf("模型连接中断，回答尚未完成")
		}
		for i := 0; i < len(calls); i++ {
			if calls[i] == nil {
				return out, fmt.Errorf("工具调用顺序无效")
			}
			out.Calls = append(out.Calls, *calls[i])
		}
		out.Assistant = chatAssistant(out)
	}
	return out, nil
}
func callsFromItems(items []map[string]any) []toolCall {
	calls := []toolCall{}
	for _, item := range items {
		if item["type"] == "function_call" {
			id, _ := item["call_id"].(string)
			n, _ := item["name"].(string)
			a, _ := item["arguments"].(string)
			calls = append(calls, toolCall{id, n, a})
		}
	}
	return calls
}
func parseResponse(obj map[string]any) (providerTurn, error) {
	out := providerTurn{}
	if obj == nil || obj["error"] != nil || obj["status"] == "failed" || obj["status"] == "incomplete" {
		return out, fmt.Errorf("模型未完成回答，请检查配置或提高输出上限")
	}
	list, _ := obj["output"].([]any)
	for _, v := range list {
		item, ok := v.(map[string]any)
		if !ok {
			continue
		}
		out.Items = append(out.Items, item)
		content, _ := item["content"].([]any)
		for _, c := range content {
			part, _ := c.(map[string]any)
			if part["type"] == "output_text" {
				txt, _ := part["text"].(string)
				out.Text += txt
			}
		}
	}
	out.Calls = callsFromItems(out.Items)
	out.Usage, _ = obj["usage"].(map[string]any)
	if out.Text == "" && len(out.Calls) == 0 {
		return out, fmt.Errorf("模型没有返回可用内容")
	}
	return out, nil
}
func parseChat(obj map[string]any) (providerTurn, error) {
	out := providerTurn{}
	list, _ := obj["choices"].([]any)
	if len(list) == 0 {
		return out, fmt.Errorf("模型没有返回可用内容")
	}
	choice, _ := list[0].(map[string]any)
	if choice["finish_reason"] == "length" || choice["finish_reason"] == "content_filter" {
		return out, fmt.Errorf("模型未完成回答，请提高输出上限或调整内容")
	}
	msg, _ := choice["message"].(map[string]any)
	out.Assistant = msg
	out.Text, _ = msg["content"].(string)
	calls, _ := msg["tool_calls"].([]any)
	for _, v := range calls {
		tc, _ := v.(map[string]any)
		fn, _ := tc["function"].(map[string]any)
		id, _ := tc["id"].(string)
		n, _ := fn["name"].(string)
		a, _ := fn["arguments"].(string)
		out.Calls = append(out.Calls, toolCall{id, n, a})
	}
	out.Usage, _ = obj["usage"].(map[string]any)
	if out.Text == "" && len(out.Calls) == 0 {
		return out, fmt.Errorf("模型没有返回可用内容")
	}
	return out, nil
}
func chatAssistant(t providerTurn) map[string]any {
	m := map[string]any{"role": "assistant", "content": t.Text}
	if len(t.Calls) > 0 {
		calls := []any{}
		for _, c := range t.Calls {
			calls = append(calls, map[string]any{"id": c.ID, "type": "function", "function": map[string]string{"name": c.Name, "arguments": c.Arguments}})
		}
		m["tool_calls"] = calls
	}
	return m
}
func (s *aiService) modelRequest(ctx context.Context, c modelConfig, path string, body any) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("模型接口地址无效")
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client := *s.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接模型或请求超时，请检查接口地址")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		switch resp.StatusCode {
		case 401, 403:
			return nil, fmt.Errorf("模型认证失败，请检查 API Key 和权限")
		case 429:
			return nil, fmt.Errorf("模型请求额度或频率已达上限，请稍后重试")
		default:
			return nil, fmt.Errorf("模型接口返回 HTTP %s，请检查 Model、协议和参数", strconv.Itoa(resp.StatusCode))
		}
	}
	return resp, nil
}
func (s *aiService) structured(ctx context.Context, c aiSettings, instruction string, input any, out any) error {
	data, _ := json.Marshal(input)
	p := newProviderSession(c.Text, c.Prompts.System+"\n"+instruction+"\n只返回指定结构的 JSON 对象，不要 Markdown 或额外说明。", string(data), nil)
	p.Config.Stream = false
	t, err := s.turn(ctx, p, nil)
	if err != nil {
		return err
	}
	raw := strings.TrimSpace(t.Text)
	if strings.HasPrefix(raw, "```") {
		if i := strings.Index(raw, "\n"); i >= 0 {
			raw = raw[i+1:]
		}
		raw = strings.TrimSuffix(strings.TrimSpace(raw), "```")
	}
	if json.Unmarshal([]byte(raw), out) != nil {
		return fmt.Errorf("AI 返回的数据结构无效，请重试")
	}
	return nil
}
