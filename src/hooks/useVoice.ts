import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice layer for NEXUS:
 *  - continuous speech recognition, optionally gated by a wake word
 *  - push-to-talk (bypasses the wake word)
 *  - spoken replies via the browser speech synthesis engine
 *
 * Every behaviour is driven by NEXUS Settings → Voice (rate, pitch, language,
 * chosen synthesis voice, wake-word gating, input/output switches).
 */

type SR = any;

export type VoiceOptions = {
  outputEnabled: boolean;
  requireWakeWord: boolean;
  wakeWord: string;
  voiceURI: string;
  rate: number;
  pitch: number;
  lang: string;
};

const DEFAULTS: VoiceOptions = {
  outputEnabled: true,
  requireWakeWord: false,
  wakeWord: "nexus",
  voiceURI: "",
  rate: 1.02,
  pitch: 0.95,
  lang: "en-US",
};

function getRecognition(): SR | null {
  if (typeof window === "undefined") return null;
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/** List the synthesis voices the browser exposes (for the Settings picker). */
export function listSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices();
}

export function useVoice(onCommand: (text: string) => void, options?: Partial<VoiceOptions>) {
  const opts: VoiceOptions = { ...DEFAULTS, ...options };
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [awake, setAwake] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const recRef = useRef<SR | null>(null);
  const wantRef = useRef(false);
  const forceRef = useRef(false); // push-to-talk: skip wake word
  const awakeRef = useRef(false);
  const cmdRef = useRef(onCommand);
  cmdRef.current = onCommand;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const r = getRecognition();
    setSupported(!!r && typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  const setAwakeState = useCallback((v: boolean) => {
    awakeRef.current = v;
    setAwake(v);
  }, []);

  const handleFinal = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const o = optsRef.current;

      // Push-to-talk always bypasses wake-word gating for one utterance.
      if (forceRef.current) {
        forceRef.current = false;
        setAwakeState(false);
        cmdRef.current(text);
        return;
      }

      if (!o.requireWakeWord) {
        setAwakeState(false);
        cmdRef.current(text);
        return;
      }

      const word = (o.wakeWord || "nexus").trim().toLowerCase();
      if (awakeRef.current) {
        setAwakeState(false);
        cmdRef.current(text);
        return;
      }
      const lower = text.toLowerCase();
      const idx = word ? lower.indexOf(word) : -1;
      if (idx === -1) return; // no wake word — ignore this utterance entirely
      const remainder = text.slice(idx + word.length).replace(/^[\s,.:;!?-]+/, "").trim();
      if (remainder) {
        setAwakeState(false);
        cmdRef.current(remainder);
      } else {
        // Heard just the wake word — accept the next utterance as a command.
        setAwakeState(true);
      }
    },
    [setAwakeState],
  );

  const start = useCallback(
    (force = false) => {
      const rec = getRecognition();
      if (!rec) return;
      forceRef.current = force;
      wantRef.current = true;
      rec.lang = optsRef.current.lang || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e: any) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) handleFinal(res[0].transcript);
          else interim += res[0].transcript;
        }
        setHeard(interim);
      };
      rec.onerror = () => {};
      rec.onend = () => {
        setListening(false);
        setHeard("");
        if (wantRef.current) {
          // auto-restart so listening never silently dies
          setTimeout(() => {
            if (wantRef.current) {
              try {
                rec.start();
                setListening(true);
              } catch {}
            }
          }, 400);
        }
      };
      try {
        rec.start();
        recRef.current = rec;
        setListening(true);
      } catch {}
    },
    [handleFinal],
  );

  const stop = useCallback(() => {
    wantRef.current = false;
    forceRef.current = false;
    setAwakeState(false);
    try {
      recRef.current?.stop();
    } catch {}
    setListening(false);
    setHeard("");
  }, [setAwakeState]);

  const toggle = useCallback(() => {
    if (wantRef.current) stop();
    else start(false);
  }, [start, stop]);

  useEffect(
    () => () => {
      wantRef.current = false;
      try {
        recRef.current?.stop();
      } catch {}
    },
    [],
  );

  const speak = useCallback((text: string) => {
    const o = optsRef.current;
    if (!o.outputEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/[*_`#>|]/g, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      // Pronunciation-only fix: "Ayaan" gets read as "Iron" by most TTS engines.
      // Display text is untouched; only the spoken string is respelled as two
      // separate words, which is the only form engines reliably split.
      .replace(/Ayaan/gi, "Ah Yaahn")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 700);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    const voices = window.speechSynthesis.getVoices();
    const pick =
      (o.voiceURI ? voices.find((v) => v.voiceURI === o.voiceURI) : undefined) ||
      voices.find((v) => /Google UK English Male/i.test(v.name)) ||
      voices.find((v) => /(Daniel|Arthur|George|Ryan|Male)/i.test(v.name) && /en/i.test(v.lang)) ||
      voices.find((v) => /en-GB/i.test(v.lang)) ||
      voices.find((v) => /en/i.test(v.lang));
    if (pick) u.voice = pick;
    u.lang = o.lang || "en-US";
    u.rate = o.rate;
    u.pitch = o.pitch;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return {
    supported,
    listening,
    awake,
    heard,
    speaking,
    speakReplies: opts.outputEnabled,
    toggle,
    pushToTalk: () => start(true),
    stop,
    speak,
    stopSpeaking,
  };
}
