import type { MusicTrack } from './tracks';

const preferenceKey = 'yapling-music-enabled';
export function musicEnabledPreference() {
  try {
    return localStorage.getItem(preferenceKey) !== 'false';
  } catch {
    return true;
  }
}
export interface MusicState {
  enabled: boolean;
  playing: boolean;
  blocked: boolean;
  error: boolean;
}

/** One media element, independent of simulation time and workspace navigation. */
export class MusicPlayer {
  state: MusicState;
  private audio: HTMLAudioElement | null = null;
  private index = 0;
  private loadedIndex = -1;
  private activated = false;
  private visible = true;
  private pending = false;
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly tracks: readonly MusicTrack[],
    private readonly onChange: (state: MusicState) => void,
    enabled = musicEnabledPreference(),
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {
    this.state = { enabled, playing: false, blocked: false, error: false };
  }
  private update(patch: Partial<MusicState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
  private listeners = {
    playing: () => {
      if (!this.audio || this.audio.paused || this.audio.error) return;
      if (!this.state.enabled || !this.visible || this.disposed) this.audio?.pause();
      else this.update({ playing: true, blocked: false, error: false });
    },
    pause: () => {
      if (this.audio?.paused) this.update({ playing: false });
    },
    waiting: () => this.update({ playing: false }),
    ended: () => {
      if (!this.audio?.ended || this.disposed || this.loadedIndex < 0) return;
      this.index = (this.index + 1) % this.tracks.length;
      this.loadedIndex = -1;
      this.pending = false;
      this.update({ playing: false });
      void this.play();
    },
    error: () => {
      if (!this.audio?.error || this.disposed) return;
      this.generation++;
      this.pending = false;
      this.audio.pause();
      this.update({ playing: false, blocked: false, error: true });
    },
  };
  activate() {
    this.activated = true;
    if (
      this.state.enabled &&
      this.visible &&
      !this.pending &&
      !this.state.playing &&
      !this.state.error
    )
      void this.play();
  }
  setEnabled(enabled: boolean) {
    if (this.disposed) return;
    try {
      localStorage.setItem(preferenceKey, String(enabled));
    } catch {}
    if (this.audio) this.audio.muted = !enabled;
    this.update({ enabled, blocked: false, error: false });
    if (enabled) this.activate();
    else this.pause();
  }
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) this.pause();
    else if (this.activated && this.state.enabled && !this.state.error) void this.play();
  }
  private pause() {
    this.generation++;
    this.pending = false;
    this.audio?.pause();
    this.update({ playing: false });
  }
  private async play() {
    if (this.disposed || !this.visible || !this.state.enabled || !this.tracks.length) return;
    // A queued ended event may arrive after the tab resumes or music is re-enabled.
    if (this.audio?.ended && this.loadedIndex === this.index) {
      this.index = (this.index + 1) % this.tracks.length;
      this.loadedIndex = -1;
    }
    const generation = ++this.generation;
    this.pending = true;
    try {
      if (!this.audio) {
        this.audio = this.createAudio();
        this.audio.preload = 'none';
        this.audio.volume = 0.15;
        for (const [name, listener] of Object.entries(this.listeners))
          this.audio.addEventListener(name, listener);
      }
      const audio = this.audio;
      audio.muted = false;
      audio.playbackRate = 1;
      if (this.loadedIndex !== this.index || audio.error) {
        audio.src = this.tracks[this.index].url;
        this.loadedIndex = this.index;
        audio.load();
      }
      this.update({ blocked: false, error: false });
      await audio.play();
      if (this.disposed || !this.visible || !this.state.enabled) {
        audio.pause();
        return;
      }
      if (generation !== this.generation) return;
      this.pending = false;
      this.update({ playing: !audio.paused });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.pending = false;
      this.audio?.pause();
      const blocked =
        !!error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError';
      this.update({ playing: false, blocked, error: !blocked });
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.pending = false;
    const audio = this.audio;
    if (!audio) return;
    for (const [name, listener] of Object.entries(this.listeners))
      audio.removeEventListener(name, listener);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.audio = null;
  }
}
