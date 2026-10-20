import { describe, expect, it } from "vitest";
import {
  readySpeechDuration,
  speechCharacterCount,
  speechPosition,
} from "./aiSpeech";
import type { SpeechAudio } from "./ai";

const audio: SpeechAudio = {
  id: "fixture",
  script: "讲课稿",
  status: "generating",
  segments: [
    { text: "第一段", url: "/first", duration: 10 },
    { text: "第二段", url: "/second", duration: 15 },
    { text: "第三段", duration: 0 },
  ],
};
describe("speech character usage", () => {
  it("counts all synthesis inputs, including ungenerated segments and Unicode", () => {
    expect(
      speechCharacterCount({
        ...audio,
        script: "中🙂。\n\nHi! A\nB",
        segments: [
          { text: "中🙂。", url: "/first", duration: 10 },
          { text: "Hi! A\nB", duration: 0 },
        ],
      }),
    ).toBe(10);
    expect(speechCharacterCount({ ...audio, segments: [] })).toBe(0);
  });
});
describe("segmented lecture timeline", () => {
  it("only exposes the contiguous playable duration", () => {
    expect(readySpeechDuration(audio)).toBe(25);
    expect(
      readySpeechDuration({
        ...audio,
        segments: [audio.segments[0], audio.segments[2], audio.segments[1]],
      }),
    ).toBe(10);
    expect(readySpeechDuration(null)).toBe(0);
  });
  it("maps seeks across boundaries and clamps to generated audio", () => {
    expect(speechPosition(audio, -3)).toEqual({
      index: 0,
      offset: 0,
      start: 0,
    });
    expect(speechPosition(audio, 10)).toEqual({
      index: 1,
      offset: 0,
      start: 10,
    });
    expect(speechPosition(audio, 14)).toEqual({
      index: 1,
      offset: 4,
      start: 10,
    });
    expect(speechPosition(audio, 100)).toEqual({
      index: 1,
      offset: 15,
      start: 10,
    });
  });
});
