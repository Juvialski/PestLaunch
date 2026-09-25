export function visibleCallError(requestError: string | null, persistedError: string | null): string | null {
  if (requestError?.trim()) return requestError;
  if (persistedError?.trim()) return persistedError;
  return null;
}

export const AUDIO_PLAYBACK_ERROR = "This recording could not be played. Reopen the call and try again.";
