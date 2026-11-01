'use client';

import { useEffect, useState } from 'react';
import { Mukta, Mukta_Mahee, Mukta_Malar, Mukta_Vaani } from 'next/font/google';
import styles from './auth.module.css';

// One type family drawn in India for each script, so every greeting has the same voice.
const devanagari = Mukta({ weight: '700', subsets: ['devanagari', 'latin'], display: 'swap' });
const gujarati = Mukta_Vaani({ weight: '700', subsets: ['gujarati'], display: 'swap' });
const gurmukhi = Mukta_Mahee({ weight: '700', subsets: ['gurmukhi'], display: 'swap' });
const tamil = Mukta_Malar({ weight: '700', subsets: ['tamil'], display: 'swap' });

const GREETINGS = [
  { text: 'नमस्ते', lang: 'hi', font: devanagari.className },
  { text: 'કેમ છો', lang: 'gu', font: gujarati.className },
  { text: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ', lang: 'pa', font: gurmukhi.className },
  { text: 'வணக்கம்', lang: 'ta', font: tamil.className },
  { text: 'Hello', lang: 'en', font: devanagari.className },
];

/** Says hello in a few of India's scripts, one after another. Still for reduced motion. */
export function Greeting() {
  const [i, setI] = useState(0);
  const [still, setStill] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    setStill(reduce.matches);
    if (reduce.matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % GREETINGS.length), 2800);
    return () => clearInterval(t);
  }, []);
  const g = GREETINGS[still ? 0 : i];
  return (
    <p className={styles.greeting} aria-hidden="true">
      <span key={g.text} lang={g.lang} className={`${styles.word} ${g.font}`}>
        {g.text}
      </span>
    </p>
  );
}
