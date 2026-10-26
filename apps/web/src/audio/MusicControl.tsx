import { useEffect, useRef, useState } from 'react';
import { musicTracks } from './tracks';
import { MusicPlayer, musicEnabledPreference, type MusicState } from './musicPlayer';
import './music-control.css';

export function MusicControl() {
  const [state, setState] = useState<MusicState>(() => ({
    enabled: musicEnabledPreference(),
    playing: false,
    blocked: false,
    error: false,
  }));
  const player = useRef<MusicPlayer | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const current = new MusicPlayer(musicTracks, setState);
    player.current = current;
    current.setVisible(!document.hidden);
    const gesture = (event: Event) => {
      if (button.current?.contains(event.target as Node)) return;
      if (event.type === 'pointerdown' || event.type === 'pointerup') {
        const pointer = event as PointerEvent;
        if (pointer.button > 0) return;
        const mouse = !pointer.pointerType || pointer.pointerType === 'mouse';
        if ((event.type === 'pointerdown' && !mouse) || (event.type === 'pointerup' && mouse))
          return;
      }
      if (event.type === 'keydown') {
        const key = event as KeyboardEvent;
        if (
          key.repeat ||
          key.isComposing ||
          key.ctrlKey ||
          key.metaKey ||
          key.altKey ||
          ['Shift', 'Control', 'Alt', 'Meta'].includes(key.key)
        )
          return;
      }
      current.activate();
    };
    const visibility = () => current.setVisible(!document.hidden);
    document.addEventListener('pointerdown', gesture);
    document.addEventListener('pointerup', gesture);
    document.addEventListener('keydown', gesture);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('pointerdown', gesture);
      document.removeEventListener('pointerup', gesture);
      document.removeEventListener('keydown', gesture);
      document.removeEventListener('visibilitychange', visibility);
      current.dispose();
      player.current = null;
    };
  }, []);
  const label = state.enabled ? 'Mute music' : 'Enable music';
  const title = !state.enabled
    ? label
    : state.error
      ? 'Music unavailable · mute'
      : state.playing
        ? label
        : 'Music enabled · starts on interaction';
  return (
    <button
      ref={button}
      className="music-control"
      aria-label={label}
      aria-pressed={!state.enabled}
      title={title}
      data-playing={state.playing}
      onClick={() => player.current?.setEnabled(!state.enabled)}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M11 5 6 9H3v6h3l5 4Z" strokeLinejoin="round" />
        {state.enabled ? (
          <>
            <path d="M15 8a6 6 0 0 1 0 8" />
            <path d="M18 5a10 10 0 0 1 0 14" />
          </>
        ) : (
          <path d="m16 9 5 6m0-6-5 6" />
        )}
      </svg>
    </button>
  );
}
