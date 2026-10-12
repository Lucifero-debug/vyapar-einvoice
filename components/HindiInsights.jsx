'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { factsFrom, insightsFrom, speechChunks } from '@/lib/hindiInsights.mjs';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';

/**
 * The dashboard's figures, said in Hindi -- on screen and out loud.
 *
 * The sentences are built from the figures already on the dashboard
 * (lib/hindiInsights.mjs), so they always match the cards below. An optional
 * "AI summary" asks a model to say the same facts more naturally, and is
 * labelled as AI-written.
 *
 * THE VOICE IS THE BROWSER'S OWN (the Web Speech API): free, no key, nothing
 * leaves the device. Chrome on Android and Edge on Windows carry a Hindi
 * voice; some PCs do not, and the card says so rather than reading Hindi in
 * an English voice -- or in silence -- with no explanation.
 */

const TONE = {
  good: 'border-emerald-500',
  warn: 'border-amber-500',
  info: 'border-border',
};

const hasSpeech = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** The best Hindi voice on this device, by name -- or '' when it has none. */
const hindiVoiceName = () => {
  if (!hasSpeech()) return '';
  const hindi = window.speechSynthesis.getVoices().filter((v) => /^hi([-_]|$)/i.test(v.lang));
  // A local voice works offline and starts at once; Google's online voice
  // sounds better where it exists. Prefer that, then any local, then any.
  const best =
    hindi.find((v) => /google/i.test(v.name)) || hindi.find((v) => v.localService) || hindi[0];
  return best ? best.name : '';
};

/**
 * Voices load late (Chrome fills the list after the page starts), so the
 * name is read as an external store and re-read on `voiceschanged`. A string
 * snapshot, so an unchanged list does not re-render.
 */
const subscribeVoices = (onChange) => {
  if (!hasSpeech()) return () => {};
  window.speechSynthesis.addEventListener('voiceschanged', onChange);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', onChange);
};

export default function HindiInsights({ data, preset, topParty }) {
  const facts = useMemo(() => factsFrom(data, { preset, topParty }), [data, preset, topParty]);
  const insights = useMemo(() => insightsFrom(facts), [facts]);
  const factsKey = useMemo(() => JSON.stringify(facts), [facts]);

  const voiceName = useSyncExternalStore(subscribeVoices, hindiVoiceName, () => '');
  const speechReady = useSyncExternalStore(subscribeVoices, hasSpeech, () => false);

  // Which text is being read: 'insights', 'ai', or null.
  const [speaking, setSpeaking] = useState(null);
  const run = useRef(0);

  const [aiAvailable, setAiAvailable] = useState(false);
  const [ai, setAi] = useState({ forKey: '', text: '', busy: false, error: '' });
  // An AI summary of last month's figures is not a summary of this month's.
  const aiText = ai.forKey === factsKey ? ai.text : '';
  const aiError = ai.forKey === factsKey ? ai.error : '';

  useEffect(() => {
    let live = true;
    fetch('/api/insights-ai')
      .then((res) => res.json())
      .then((body) => live && setAiAvailable(Boolean(body?.available)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const stop = useCallback(() => {
    run.current += 1;
    if (hasSpeech()) window.speechSynthesis.cancel();
    setSpeaking(null);
  }, []);

  // Never leave the voice talking over a page that has gone.
  useEffect(() => () => hasSpeech() && window.speechSynthesis.cancel(), []);

  const speak = useCallback(
    (which, text) => {
      if (!hasSpeech()) return;
      const synth = window.speechSynthesis;
      synth.cancel();
      const mine = ++run.current;
      const voice = synth.getVoices().find((v) => v.name === voiceName) || null;
      const pieces = speechChunks(text);
      if (!pieces.length) return;

      pieces.forEach((piece, index) => {
        const utterance = new SpeechSynthesisUtterance(piece);
        utterance.lang = 'hi-IN';
        if (voice) utterance.voice = voice;
        utterance.rate = 0.95;
        const finish = () => {
          // A later Play or Stop has taken over; this run's ending is not news.
          if (run.current === mine) setSpeaking(null);
        };
        if (index === pieces.length - 1) utterance.onend = finish;
        utterance.onerror = finish;
        synth.speak(utterance);
      });
      setSpeaking(which);
    },
    [voiceName]
  );

  const askAi = async () => {
    stop();
    setAi({ forKey: factsKey, text: '', busy: true, error: '' });
    try {
      const res = await fetch('/api/insights-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts }),
      });
      const { ok, body, message } = await readResponse(res);
      setAi({
        forKey: factsKey,
        text: ok ? String(body.summary || '') : '',
        busy: false,
        error: ok ? '' : message,
      });
    } catch {
      setAi({ forKey: factsKey, text: '', busy: false, error: NETWORK_ERROR });
    }
  };

  if (!insights.length) return null;

  const allText = insights.map((i) => i.text).join(' ');

  return (
    <div className="panel mb-4 no-print">
      <div className="panel-head flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">
          इनसाइट्स <span className="text-sm font-normal text-muted-foreground">· Hindi insights</span>
        </h2>
        <div className="flex flex-wrap gap-2">
          {speechReady &&
            (speaking === 'insights' ? (
              <button type="button" className="btn btn-sm btn-secondary" onClick={stop}>
                ■ रोकें
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => speak('insights', allText)}
                aria-label="Listen to the insights in Hindi"
              >
                ▶ सुनें
              </button>
            ))}
          {aiAvailable && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={askAi}
              disabled={ai.busy}
            >
              {ai.busy ? 'लिख रहा है…' : 'AI सारांश'}
            </button>
          )}
        </div>
      </div>

      <div className="panel-body">
        <ul className="space-y-2" lang="hi">
          {insights.map((item) => (
            <li
              key={item.key}
              className={`border-l-4 pl-3 text-sm leading-relaxed ${TONE[item.tone] || TONE.info}`}
            >
              {item.text}
            </li>
          ))}
        </ul>

        {speechReady && !voiceName && (
          <p className="field-hint mt-3">
            This device has no Hindi voice installed, so it may read in another voice or not at all.
            On Windows: Settings → Time &amp; language → Speech → Add voices → Hindi. On Android,
            Chrome uses Google&apos;s Hindi voice.
          </p>
        )}
        {!speechReady && (
          <p className="field-hint mt-3">This browser cannot read text aloud.</p>
        )}

        {aiError && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {aiError}
          </p>
        )}

        {aiText && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                AI-written from the figures above. Check any amount against the cards before acting
                on it.
              </p>
              {speechReady &&
                (speaking === 'ai' ? (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={stop}>
                    ■ रोकें
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => speak('ai', aiText)}
                    aria-label="Listen to the AI summary in Hindi"
                  >
                    ▶ सुनें
                  </button>
                ))}
            </div>
            <p className="text-sm leading-relaxed" lang="hi">
              {aiText}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
