import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import vm from 'node:vm';
import ts from 'typescript';

const scratch = await mkdtemp(join(tmpdir(), 'yapling-music-test-'));
try {
  const output = join(scratch, 'player.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./musicPlayer.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: output,
    logLevel: 'warning',
  });
  const { MusicPlayer, musicEnabledPreference } = await import(pathToFileURL(output).href);
  const preferences = new Map();
  globalThis.localStorage = {
    getItem: (key) => preferences.get(key) ?? null,
    setItem: (key, value) => preferences.set(key, value),
  };
  const tracks = ['one', 'two', 'three'].map((id) => ({
    id,
    title: id,
    url: `/audio/${id}.mp3`,
    credit: 'Author',
    creditUrl: 'https://example.test/author',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  }));
  class AudioFake extends EventTarget {
    paused = true;
    ended = false;
    error = null;
    volume = 1;
    muted = false;
    playbackRate = 1;
    preload = 'auto';
    currentTime = 0;
    loads = 0;
    plays = 0;
    pauses = 0;
    listeners = new Map();
    _src = '';
    nextPlay;
    set src(value) {
      this._src = value;
      this.currentTime = 0;
      this.error = null;
      this.ended = false;
    }
    get src() {
      return this._src;
    }
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
      super.addEventListener(name, listener);
    }
    removeEventListener(name, listener) {
      this.listeners.delete(name);
      super.removeEventListener(name, listener);
    }
    play() {
      this.plays++;
      this.paused = false;
      const result = this.nextPlay ?? Promise.resolve();
      this.nextPlay = undefined;
      return result;
    }
    pause() {
      this.pauses++;
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
    load() {
      this.loads++;
      this.error = null;
      this.ended = false;
    }
    removeAttribute(name) {
      assert.equal(name, 'src');
      this._src = '';
    }
    emit(name) {
      this.dispatchEvent(new Event(name));
    }
  }
  const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  function fixture(enabled = musicEnabledPreference()) {
    const audios = [],
      updates = [];
    const player = new MusicPlayer(
      tracks,
      (state) => updates.push(state),
      enabled,
      () => {
        const audio = new AudioFake();
        audios.push(audio);
        return audio;
      },
    );
    return { player, audios, updates };
  }
  assert.equal(musicEnabledPreference(), true);
  const f = fixture();
  assert.equal(f.player.state.enabled, true);
  assert.equal(f.audios.length, 0, 'Default enabled must not fetch/create audio before activation');
  f.player.activate();
  await settle();
  const a = f.audios[0];
  assert.equal(f.audios.length, 1);
  assert.equal(a.src, '/audio/one.mp3');
  assert.equal(a.preload, 'none');
  assert.equal(a.volume, 0.15);
  assert.equal(a.playbackRate, 1);
  assert.equal(f.player.state.playing, true);
  a.currentTime = 42;
  f.player.setVisible(false);
  assert.equal(a.paused, true);
  assert.equal(f.player.state.enabled, true);
  assert.equal(f.player.state.playing, false);
  const loads = a.loads;
  f.player.setVisible(true);
  await settle();
  assert.equal(f.player.state.playing, true);
  assert.equal(a.currentTime, 42);
  assert.equal(a.loads, loads, 'Visibility resumes the same track position');
  f.player.setEnabled(false);
  assert.equal(a.muted, true);
  assert.equal(a.paused, true);
  assert.equal(musicEnabledPreference(), false);
  f.player.activate();
  await settle();
  assert.equal(a.paused, true, 'Ordinary gestures never override saved mute');
  const reloaded = fixture();
  assert.equal(reloaded.player.state.enabled, false);
  reloaded.player.activate();
  assert.equal(reloaded.audios.length, 0);
  reloaded.player.dispose();
  f.player.setEnabled(true);
  await settle();
  assert.equal(a.muted, false);
  assert.equal(musicEnabledPreference(), true);
  assert.equal(a.currentTime, 42);
  for (const expected of ['two', 'three', 'one']) {
    a.ended = true;
    a.paused = true;
    a.emit('ended');
    await settle();
    assert.equal(a.src, `/audio/${expected}.mp3`);
    assert.equal(f.player.state.playing, true);
  }
  assert.equal(f.audios.length, 1, 'Playlist uses one persistent media element');
  const played = a.plays;
  f.player.activate();
  await settle();
  assert.equal(a.plays, played, 'Unrelated gestures/workspace rerenders do not restart playback');
  const updates = f.updates.length;
  f.player.dispose();
  assert.equal(a.paused, true);
  assert.equal(a.src, '');
  assert.equal(a.listeners.size, 0);
  assert.equal(a.loads, loads + 4, 'Cleanup removes the source and resets media');
  a.emit('ended');
  a.emit('playing');
  assert.equal(f.updates.length, updates);
  f.player.dispose();
  // Finishing at a mute/visibility boundary advances once, even if ended is queued late.
  for (const action of ['mute', 'hide'])
    for (const delivered of [true, false]) {
      const boundary = fixture(true);
      boundary.player.activate();
      await settle();
      const media = boundary.audios[0];
      media.ended = true;
      media.paused = true;
      if (action === 'mute') boundary.player.setEnabled(false);
      else boundary.player.setVisible(false);
      const loadsAtEnd = media.loads;
      if (delivered) {
        media.emit('ended');
        media.emit('ended');
      }
      assert.equal(
        media.loads,
        loadsAtEnd,
        'Inactive completion updates bookkeeping without fetching',
      );
      if (action === 'mute') boundary.player.setEnabled(true);
      else boundary.player.setVisible(true);
      await settle();
      assert.equal(media.src, '/audio/two.mp3');
      media.emit('ended');
      await settle();
      assert.equal(media.src, '/audio/two.mp3', 'Late duplicate cannot skip another track');
      boundary.player.dispose();
    }
  // Policy failure preserves preference and retries on a later normal gesture.
  const blocked = fixture(true);
  blocked.player.activate();
  const b = blocked.audios[0];
  await settle();
  blocked.player.setVisible(false);
  b.nextPlay = Promise.reject({ name: 'NotAllowedError' });
  blocked.player.setVisible(true);
  await settle();
  assert.equal(blocked.player.state.blocked, true);
  assert.equal(blocked.player.state.error, false);
  assert.equal(blocked.player.state.enabled, true);
  assert.equal(musicEnabledPreference(), true);
  blocked.player.activate();
  await settle();
  assert.equal(blocked.player.state.playing, true);
  assert.equal(blocked.player.state.blocked, false);
  b.error = { code: 4 };
  b.emit('error');
  assert.equal(blocked.player.state.error, true);
  const attempts = b.plays;
  blocked.player.activate();
  assert.equal(b.plays, attempts, 'Broken media does not retry on every unrelated click');
  blocked.player.setEnabled(false);
  blocked.player.setEnabled(true);
  await settle();
  assert.equal(blocked.player.state.error, false);
  assert.equal(blocked.player.state.playing, true);
  blocked.player.dispose();
  // A late rejection cannot undo a newer successful play; mute/hide/unmount win races.
  for (const action of ['mute', 'hide', 'dispose', 'newer']) {
    const r = fixture(true);
    r.player.activate();
    await settle();
    const audio = r.audios[0];
    r.player.setVisible(false);
    let resolve;
    audio.nextPlay = new Promise((done) => (resolve = done));
    r.player.setVisible(true);
    if (action === 'mute') r.player.setEnabled(false);
    else if (action === 'hide') r.player.setVisible(false);
    else if (action === 'dispose') r.player.dispose();
    else {
      r.player.setVisible(false);
      r.player.setVisible(true);
      await settle();
    }
    audio.paused = false;
    resolve();
    await settle();
    assert.equal(audio.paused, action !== 'newer');
    assert.equal(r.player.state.playing, action === 'newer');
    r.player.dispose();
  }
  const hidden = fixture(true);
  hidden.player.setVisible(false);
  hidden.player.activate();
  assert.equal(hidden.audios.length, 0);
  hidden.player.setVisible(true);
  await settle();
  assert.equal(hidden.audios.length, 1);
  hidden.player.dispose();
  preferences.set('yapling-music-enabled', 'false');
  assert.equal(musicEnabledPreference(), false);
  preferences.clear();
  globalThis.localStorage = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
  };
  assert.equal(musicEnabledPreference(), true);
  const privateMode = fixture();
  privateMode.player.setEnabled(false);
  assert.equal(privateMode.player.state.enabled, false);
  privateMode.player.dispose();
  // Exercise the actual component's document event ownership and ordinary rerenders.
  const slots = [];
  let cursor = 0,
    effects = [];
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[i],
        (value) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(setup, deps) {
      const i = cursor++;
      if (!slots[i])
        effects.push(() => {
          slots[i] = { cleanup: setup(), deps };
        });
    },
  };
  const buttonNode = { contains: (target) => target === buttonNode };
  const jsx = (type, props) => {
    if (type === 'button' && props.ref) props.ref.current = buttonNode;
    return { type, props };
  };
  const handlers = new Map();
  const doc = {
    hidden: false,
    addEventListener: (name, listener) => handlers.set(name, listener),
    removeEventListener: (name, listener) => {
      assert.equal(handlers.get(name), listener);
      handlers.delete(name);
    },
  };
  const made = [];
  globalThis.Audio = class extends AudioFake {
    constructor() {
      super();
      made.push(this);
    }
  };
  const component = await readFile(new URL('./MusicControl.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(component, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    document: doc,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === './tracks') return { musicTracks: tracks };
      if (name === './musicPlayer') return { MusicPlayer, musicEnabledPreference };
      if (name === './music-control.css') return {};
      throw new Error(name);
    },
  });
  const render = () => {
    cursor = 0;
    effects = [];
    const tree = exports.MusicControl();
    for (const effect of effects) effect();
    return tree;
  };
  let tree = render();
  assert.equal(made.length, 0);
  assert.equal(handlers.size, 4);
  handlers.get('pointerdown')({ type: 'pointerdown', target: buttonNode, button: 0 });
  assert.equal(made.length, 0, 'Clicking mute must not briefly activate music first');
  tree.props.onClick();
  tree = render();
  assert.equal(tree.props['aria-label'], 'Enable music');
  handlers.get('pointerdown')({ type: 'pointerdown', target: {}, button: 0 });
  assert.equal(made.length, 0);
  tree.props.onClick();
  await settle();
  tree = render();
  assert.equal(tree.props['data-playing'], true);
  assert.equal(made.length, 1);
  doc.hidden = true;
  handlers.get('visibilitychange')();
  tree = render();
  assert.equal(tree.props['data-playing'], false);
  doc.hidden = false;
  handlers.get('visibilitychange')();
  await settle();
  tree = render();
  assert.equal(tree.props['data-playing'], true);
  assert.equal(made.length, 1);
  const componentAudio = made[0];
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(handlers.size, 0, 'Component removes every document listener');
  assert.equal(componentAudio.paused, true);
  assert.equal(componentAudio.src, '');
  assert.equal(componentAudio.listeners.size, 0);
  slots.length = 0;
  const previousAudioCount = made.length;
  tree = render();
  handlers.get('pointerdown')({ type: 'pointerdown', target: {}, button: 0, pointerType: 'touch' });
  assert.equal(
    made.length,
    previousAudioCount,
    'Touch pointerdown waits for activation-triggering pointerup',
  );
  handlers.get('pointerup')({ type: 'pointerup', target: {}, button: 0, pointerType: 'touch' });
  await settle();
  tree = render();
  assert.equal(made.length, previousAudioCount + 1);
  assert.equal(tree.props['data-playing'], true);
  for (const slot of slots) slot?.cleanup?.();
  assert.equal(handlers.size, 0);
  delete globalThis.Audio;
  console.log(
    'Music lifecycle checks passed: gesture-only loading, default-enabled/persistent mute, one-element playlist, fixed volume/rate, policy rejection, media error, tab visibility, late-play races and complete teardown.',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
