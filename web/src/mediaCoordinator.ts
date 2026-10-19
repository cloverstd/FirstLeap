// Every playback entry point participates, including delayed sentence repeats.
export const MEDIA_EVENT = "firstleap:media";
export function claimMedia(media: HTMLMediaElement) {
  document
    .querySelectorAll<HTMLMediaElement>("video, audio")
    .forEach((other) => {
      if (other !== media) other.pause();
    });
  window.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail: media }));
}
