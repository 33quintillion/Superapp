'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Tabs as the WAI-ARIA pattern describes them: one Tab stop for the whole row (the selected
 * tab), arrow keys move between tabs and select them, Home and End jump to the ends, and the
 * panel is labelled by its tab.
 */
export function Tabs<T extends string>({ tabs, selected, onSelect, children }: { tabs: readonly (readonly [T, string])[]; selected: T; onSelect: (id: T) => void; children: ReactNode }) {
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const tabId = (id: T) => `${base}-tab-${id}`;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const i = tabs.findIndex(([id]) => id === selected);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const [id] = tabs[(next + tabs.length) % tabs.length]!;
    onSelect(id);
    refs.current.get(id)?.focus();
  };
  return (
    <>
      <nav className="tabs" role="tablist" onKeyDown={onKeyDown}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            ref={(el) => void (el ? refs.current.set(id, el) : refs.current.delete(id))}
            id={tabId(id)}
            role="tab"
            type="button"
            aria-selected={selected === id}
            aria-controls={`${base}-panel`}
            tabIndex={selected === id ? 0 : -1}
            className={selected === id ? 'btn small' : 'btn quiet small'}
            onClick={() => onSelect(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={tabId(selected)}>
        {children}
      </div>
    </>
  );
}
