/** Read-aloud for the Agent (Web Speech synthesis). One utterance at a time. */
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

export function speak(text: string, onDone?: () => void) {
  if (!canSpeak()) { onDone?.(); return; }
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  u.onend = () => onDone?.();
  u.onerror = () => onDone?.();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel();
}
