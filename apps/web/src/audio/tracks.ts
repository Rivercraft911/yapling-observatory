export type MusicTrack = {
  id: string;
  title: string;
  url: string;
  credit: string;
  creditUrl: string;
  licenseUrl: string;
};

export const musicTracks: readonly MusicTrack[] = [
  {
    id: 'brittle-rille',
    title: 'Brittle Rille',
    url: '/audio/kevin-macleod/brittle-rille.mp3',
    credit:
      '"Brittle Rille" Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 License.',
    creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1200047',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    id: 'frozen-star',
    title: 'Frozen Star',
    url: '/audio/kevin-macleod/frozen-star.mp3',
    credit:
      '"Frozen Star" Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 License.',
    creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100356',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    id: 'impact-lento',
    title: 'Impact Lento',
    url: '/audio/kevin-macleod/impact-lento.mp3',
    credit:
      '"Impact Lento" Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 License.',
    creditUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100619',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
];
