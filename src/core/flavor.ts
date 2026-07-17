// ---------------------------------------------------------------------------
// MUD & STEEL — Hold the Line, 1916
// flavor.ts — narrative flavour generation.
//
// Everything here is a pure function of the caller-supplied PRNG. No imports,
// no I/O, no module state beyond immutable fragment pools (allocated once at
// load). None of these functions run per-frame; they fire between waves.
//
// The letters are the heart of the game. The voice throughout is 1916
// British: understated, wry where it dares, and quiet about the worst of it.
// Men wrote around the horror, not into it.
// ---------------------------------------------------------------------------

export interface LetterCtx {
  authorFirst: string;
  authorLast: string;
  rank: string;
  regiment: string;
  wave: number;
  dateStr: string;
  weather: 'clear' | 'rain' | 'fog' | 'night';
  kills: number;
  lostMate: string | null;
  sawTank: boolean;
  sawGas: boolean;
  mud: boolean;
  morale: 'high' | 'steady' | 'shaken';
  /** The author's own despatch citation, e.g. "for coolness under heavy fire". */
  citedDeed?: string | null;
  /** Waves the author has served — a veteran writes with a different weight. */
  wavesServed?: number;
  /** A fallen mate's citation, honoured in passing. */
  lostMateDeed?: string | null;
}

type Morale = LetterCtx['morale'];
type Weather = LetterCtx['weather'];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function pickIndex(rand: () => number, len: number): number {
  let i = Math.floor(rand() * len);
  if (i < 0) i = 0;
  else if (i >= len) i = len - 1;
  return i;
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[pickIndex(rand, arr.length)] as T;
}

/** Pick an entry not yet used this call; linear-probes so a degenerate PRNG
 *  (constant output) still cycles the pool instead of repeating itself. */
function pickUnused<T>(rand: () => number, arr: readonly T[], used: Set<number>): T | null {
  if (used.size >= arr.length) return null;
  const start = pickIndex(rand, arr.length);
  for (let step = 0; step < arr.length; step++) {
    const j = (start + step) % arr.length;
    if (!used.has(j)) {
      used.add(j);
      return arr[j] as T;
    }
  }
  return null;
}

function countWords(s: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ws = c === 32 || c === 10 || c === 9 || c === 13;
    if (!ws && !inWord) {
      n++;
      inWord = true;
    } else if (ws) {
      inWord = false;
    }
  }
  return n;
}

function ordSuffix(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function ordNum(n: number): string {
  return `${n}${ordSuffix(n)}`;
}

const ORD_WORDS: readonly string[] = [
  '', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh',
  'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth', 'Thirteenth',
  'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth',
  'Nineteenth',
];
const TENS_CARDINAL: readonly string[] = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
];
const TENS_ORDINAL: readonly string[] = [
  '', '', 'Twentieth', 'Thirtieth', 'Fortieth', 'Fiftieth', 'Sixtieth',
  'Seventieth', 'Eightieth', 'Ninetieth',
];

function ordinalWord(n: number): string {
  const v = Math.max(1, Math.floor(n));
  if (v < 20) return ORD_WORDS[v] as string;
  if (v < 100) {
    const tens = Math.floor(v / 10);
    const unit = v % 10;
    if (unit === 0) return TENS_ORDINAL[tens] as string;
    return `${TENS_CARDINAL[tens]}-${ORD_WORDS[unit]}`;
  }
  return ordNum(v);
}

// ---------------------------------------------------------------------------
// fieldDate — 1 July 1916, two days on per wave, correct ordinals & rollover
// ---------------------------------------------------------------------------

const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function daysInMonth(month: number, year: number): number {
  switch (month) {
    case 1:
      return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
    case 3:
    case 5:
    case 8:
    case 10:
      return 30;
    default:
      return 31;
  }
}

export function fieldDate(wave: number): string {
  const w = Math.max(1, Math.floor(wave));
  let day = 1 + (w - 1) * 2;
  let month = 6; // July
  let year = 1916;
  while (day > daysInMonth(month, year)) {
    day -= daysInMonth(month, year);
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }
  return `${ordNum(day)} ${MONTH_NAMES[month]}, ${year}`;
}

// ---------------------------------------------------------------------------
// Names & regiments
// ---------------------------------------------------------------------------

const FIRST_NAMES: readonly string[] = [
  // English
  'Albert', 'Alfred', 'Archibald', 'Arthur', 'Bertram', 'Cecil', 'Charles',
  'Christopher', 'Clarence', 'Claude', 'Clifford', 'Cyril', 'Edgar', 'Edmund',
  'Edward', 'Edwin', 'Ernest', 'Frank', 'Frederick', 'George', 'Gilbert',
  'Godfrey', 'Harold', 'Harry', 'Henry', 'Herbert', 'Horace', 'Hubert',
  'Isaac', 'Jack', 'James', 'Jesse', 'John', 'Joseph', 'Lawrence', 'Leonard',
  'Leslie', 'Matthew', 'Maurice', 'Norman', 'Oliver', 'Oswald', 'Percy',
  'Philip', 'Ralph', 'Raymond', 'Reginald', 'Richard', 'Robert', 'Roland',
  'Samuel', 'Septimus', 'Sidney', 'Silas', 'Stanley', 'Theodore', 'Thomas',
  'Victor', 'Walter', 'Wilfred',
  // Scottish
  'Alasdair', 'Alec', 'Angus', 'Archie', 'Callum', 'Donald', 'Dougal',
  'Duncan', 'Ewan', 'Fergus', 'Gordon', 'Hamish', 'Hector', 'Kenneth',
  'Malcolm', 'Murdo', 'Neil', 'Ronald', 'Stuart',
  // Welsh
  'Aled', 'Bryn', 'Dafydd', 'Emlyn', 'Evan', 'Glyn', 'Gwilym', 'Huw',
  'Idris', 'Ifor', 'Llewelyn', 'Owen', 'Rhys',
  // Irish
  'Brendan', 'Colm', 'Cormac', 'Dennis', 'Desmond', 'Eamon', 'Eugene',
  'Francis', 'Hugh', 'Kevin', 'Martin', 'Michael', 'Patrick', 'Peter',
  'Seamus',
];

const SURNAMES: readonly string[] = [
  'Atkins', 'Ashworth', 'Bagley', 'Baker', 'Barnes', 'Bartlett', 'Beckett',
  'Bell', 'Bentley', 'Berry', 'Bevan', 'Birch', 'Blackwood', 'Bowen', 'Boyd',
  'Bradley', 'Bramble', 'Brennan', 'Briggs', 'Brogan', 'Buckley', 'Burns',
  'Byrne', 'Cairns', 'Callaghan', 'Cameron', 'Campbell', 'Carter',
  'Cartwright', 'Chadwick', 'Clarke', 'Cobb', 'Coleman', 'Collins',
  'Connolly', 'Cooper', 'Craddock', 'Craig', 'Crane', 'Croft', 'Cunningham',
  'Dalton', 'Davies', 'Dawson', 'Doyle', 'Drummond', 'Duffy', 'Dunbar',
  'Eccles', 'Edwards', 'Ellis', 'Evans', 'Fairbairn', 'Farley', 'Faulkner',
  'Fenwick', 'Ferguson', 'Finch', 'Fitzgerald', 'Fletcher', 'Flynn',
  'Forsyth', 'Fox', 'Fraser', 'Gallagher', 'Garrett', 'Gibbs', 'Gilchrist',
  'Goode', 'Grady', 'Graham', 'Grant', 'Greenwood', 'Gregory', 'Griffiths',
  'Haines', 'Hall', 'Hanley', 'Harding', 'Hargreaves', 'Harris', 'Hartley',
  'Hayes', 'Healy', 'Heath', 'Higgins', 'Hobbs', 'Hodgson', 'Holt',
  'Hopkins', 'Howell', 'Hughes', 'Hume', 'Hunt', 'Inglis', 'Jarvis',
  'Jenkins', 'Jones', 'Kavanagh', 'Keating', 'Kemp', 'Kennedy', 'Kerr',
  'Kirkwood', 'Lacey', 'Lambert', 'Leach', 'Lewis', 'Lloyd', 'Lynch',
  'MacBride', 'MacDonald', 'MacGregor', 'MacIntyre', 'MacKay', 'MacLean',
  'MacPherson', 'Maddox', 'Maguire', 'Marsh', 'Mason', 'McCarthy',
  'Meredith', 'Milburn', 'Miller', 'Moffat', 'Molloy', 'Morgan', 'Morris',
  'Mortimer', 'Murphy', 'Nash', 'Naylor', 'Nolan', 'Oakes', "O'Brien",
  "O'Connell", "O'Neill", 'Osborne', 'Owens', 'Parr', 'Payne', 'Pembroke',
  'Perkins', 'Phillips', 'Pickering', 'Platt', 'Pollard', 'Powell', 'Price',
  'Pritchard', 'Quigley', 'Radford', 'Ramsay', 'Redfern', 'Rees', 'Reid',
  'Riley', 'Roberts', 'Robson', 'Rourke', 'Rowntree', 'Ryan', 'Salter',
  'Saunders', 'Shaw', 'Sheridan', 'Sinclair', 'Slater', 'Smedley', 'Snow',
  'Spence', 'Stanton', 'Stewart', 'Stokes', 'Sullivan', 'Sutcliffe',
  'Tanner', 'Thackeray', 'Thomas', 'Thorne', 'Tibbs', 'Todd', 'Travers',
  'Tremaine', 'Tudor', 'Turnbull', 'Vaughan', 'Wade', 'Walsh', 'Watkins',
  'Webb', 'Whitfield', 'Whittaker', 'Wickham', 'Williams', 'Willoughby',
  'Winterbottom', 'Wood', 'Wray', 'Yardley', 'Yates',
];

export function makeSoldierName(rand: () => number): { first: string; last: string } {
  return { first: pick(rand, FIRST_NAMES), last: pick(rand, SURNAMES) };
}

const SHIRES: readonly string[] = [
  'Loamshire', 'Barsetshire', 'Glebeshire', 'Wintonshire', 'Marshbrook',
  'Netherdale', 'Kingscote', 'Ashcombe', 'Harfield', 'Redemoor', 'Fenshire',
  'Milverton', 'Wealdon', 'Ottermere', 'Dunsley', 'Colbridge',
  // Welsh & Irish flavoured
  'Caerwyn', 'Bryngower', 'Ballyduffin', 'Kilmarron', 'Glendorragh',
];

const SCOTS_NAMES: readonly string[] = [
  'Strathdour', 'Glenmorrow', 'Dunrannoch', 'Kilbrae', 'Lochfern', 'Craigmuir',
];

const LINE_TYPES: readonly string[] = [
  'Rifles', 'Fusiliers', 'Light Infantry', 'Borderers',
];

const PALS_TOWNS: readonly string[] = [
  'Marlford', 'Kettlebridge', 'Ollerton', 'Brackwell', 'Dunhampton',
  'Swaledon', 'Netherby', 'Oldcastle',
];

function irange(rand: () => number, span: number): number {
  return pickIndex(rand, span);
}

export function makeRegiment(rand: () => number): string {
  const r = rand();
  if (r < 0.26) {
    // "2nd Loamshire Rifles"
    return `${ordNum(1 + irange(rand, 12))} ${pick(rand, SHIRES)} ${pick(rand, LINE_TYPES)}`;
  }
  if (r < 0.5) {
    // Kitchener's New Army: "9th (Service) Battalion, The Glebeshire Regiment"
    const tail = pick(rand, ['Regiment', 'Rifles', 'Fusiliers'] as const);
    return `${ordNum(6 + irange(rand, 8))} (Service) Battalion, The ${pick(rand, SHIRES)} ${tail}`;
  }
  if (r < 0.68) {
    // Territorial style: "1/5th Fenshire Light Infantry"
    return `1/${ordNum(4 + irange(rand, 5))} ${pick(rand, SHIRES)} ${pick(rand, LINE_TYPES)}`;
  }
  if (r < 0.85) {
    // Pals battalion: "14th Battalion, The Wealdon Regiment (Ollerton Pals)"
    return `${ordNum(10 + irange(rand, 8))} Battalion, The ${pick(rand, SHIRES)} Regiment (${pick(rand, PALS_TOWNS)} Pals)`;
  }
  // "2nd Strathdour Highlanders"
  return `${ordNum(1 + irange(rand, 3))} ${pick(rand, SCOTS_NAMES)} Highlanders`;
}

// ---------------------------------------------------------------------------
// Epitaphs — in the tradition of the IWGC personal inscriptions
// ---------------------------------------------------------------------------

const EPITAPHS: readonly string[] = [
  // Scripture-adjacent
  'Greater love hath no man than this',
  'Until the day break and the shadows flee away',
  'He giveth His beloved sleep',
  'Thy will be done',
  'Peace, perfect peace, with loved ones far away',
  'In sure and certain hope',
  'Well done, thou good and faithful servant',
  'Not dead, but gone before',
  'The Lord gave, and the Lord hath taken',
  'Asleep in Jesus, far from home',
  'Into Thy hands, O Lord',
  // Plain, from the men
  'A good pal, sadly missed',
  'One of the best',
  'He did his bit',
  'A soldier, a son, a friend',
  'Duty called, and he answered',
  'He played the game',
  'For ever with the regiment',
  'He died as he lived, thinking of others',
  'Steadfast to the last',
  'He answered the call of duty gladly',
  // From the mothers
  'Our dear boy, ever in our thoughts',
  'Good night, son, till we meet again',
  'The dearly loved son of a sorrowing mother',
  'Sleep on, dear son, your duty done',
  'To the world a soldier, to me the world',
  'His mother thinks of him at evening',
  'Loved beyond the telling of it',
  'He was all we had',
  'Some day we will understand',
  'Absent from the body, present with the Lord',
];

type EpitaphBuilder = (first: string, kind: string, wave: number) => string;

const EPITAPH_BUILDERS: readonly EpitaphBuilder[] = [
  (first) => `Sleep on, dear ${first}, and take thy rest`,
  (first) => `Good night, ${first}, till we meet again`,
  (first) => `${first}, beloved son, one of the many`,
  (first) => `Our ${first}, his duty nobly done`,
  (first) => `${first} sleeps here, far from the hills`,
  (_first, kind) => `A finer ${kind} never stood a watch`,
  (_first, kind) => `A ${kind} of the line, faithful always`,
  (_first, _kind, wave) => `Fell ${fieldDate(wave)}, holding the line`,
  (_first, _kind, wave) => `Fell ${fieldDate(wave)}, his face to the foe`,
  (_first, _kind, wave) => `He kept the trench, ${fieldDate(wave)}`,
];

/** Service record a man carried to his grave, for the honoured-apart epitaphs. */
export interface EpitaphService {
  /** Despatch citations, e.g. ["for coolness under heavy fire"]. */
  deeds: readonly string[];
  wavesServed: number;
}

// Epitaphs reserved for the decorated and the long-serving — the men whose
// deaths sting. These lean on the citation and the length of service.
const VETERAN_EPITAPH_BUILDERS: readonly ((first: string, kind: string, wave: number, svc: EpitaphService) => string)[] = [
  (_f, _k, _w, svc) => `Mentioned in despatches ${svc.deeds[0] ?? 'for devotion to duty'}`,
  (_f, _k, _w, svc) => `He served through ${svc.wavesServed} attacks, and fell in the last`,
  (first, _k, _w, svc) => `${first}, an old hand of ${svc.wavesServed} fights, at rest`,
  (_f, kind, _w) => `A veteran ${kind}, and the steadiest of us`,
  (_f, _k, _w, svc) => `Long in the line, mentioned ${svc.deeds[0] ?? 'for his good service'}`,
];

export function makeEpitaph(
  rand: () => number,
  fullName: string,
  kindName: string,
  wave: number,
  service?: EpitaphService,
): string {
  const spaceAt = fullName.indexOf(' ');
  const first = spaceAt > 0 ? fullName.slice(0, spaceAt) : fullName;
  // A decorated or long-serving man is more likely to be honoured by name and deed.
  if (service && (service.deeds.length > 0 || service.wavesServed >= 4) && rand() < 0.72) {
    return pick(rand, VETERAN_EPITAPH_BUILDERS)(first, kindName, wave, service);
  }
  if (rand() < 0.62) return pick(rand, EPITAPHS);
  return pick(rand, EPITAPH_BUILDERS)(first, kindName, wave);
}

// ---------------------------------------------------------------------------
// Letter fragments
// ---------------------------------------------------------------------------

const GREETINGS: readonly string[] = [
  'Dear Mother', 'My dear Mother', 'Dear Mother and all at home',
  'My dear little Mother', 'Dearest Nell', 'Dear Nell', 'My dear Alice',
  'Dear Alice', 'My dear Wife', 'My dearest Flo', 'Dear Flo', 'Dear May',
  'My dear Kate', 'Dear Bess', 'My own dear Ivy', 'Dear Ted', 'Dear old Ted',
  'Dear Harry', 'Dear George', 'Dear Sis', 'Dear Aunt Polly',
  'Dear Uncle Albert', 'My dear old Bill',
];

const OPENERS: Record<Morale, readonly string[]> = {
  high: [
    'Just a line to say I am in the pink, and hope this finds you the same.',
    'Your parcel came up with the rations and caused a sensation in our dug-out.',
    'I received your welcome letter on Tuesday and read it twice through by candle-end.',
    'We are out of the worst of it now and I am fit as a butcher’s dog.',
    'No need to fret over the papers; we are all grinning here like Cheshire cats.',
    'The socks arrived and were fought over like the Crown Jewels.',
    'I am well, and eating like a horse, which will please you.',
    'Thank Mrs. Dobbs for the cake. It never stood a chance.',
    'I got the fags and the peppermints, and am the most popular man in the platoon.',
    'We have had quite a lively time of it, but I am A1 and in good heart.',
    'Your letter found me in fine fettle and better for the reading of it.',
    'I write this sitting on a biscuit tin like a lord in his study.',
  ],
  steady: [
    'Just a few lines to let you know I am quite well.',
    'I received your letter safely and was glad of all the news.',
    'We came out of the line last night and I take my chance to write.',
    'I am keeping well, and have no complaints worth the ink.',
    'Your parcel arrived in good order and the cake went down well.',
    'There is not much I may say, but I am safe, and that is the main thing.',
    'I am well, though we have been kept busy of late.',
    'We have had a warmish time, but I have come through all right.',
    'I write by candle in the dug-out, so excuse the pencil.',
    'All is much as before with us, and I am in good health.',
    'I had your letter of the 14th and it was very welcome.',
    'We are back in supports for a spell, so I have a moment at last.',
  ],
  shaken: [
    'Just a line. I am all right.',
    'I am safe. That is the chief thing.',
    'Forgive the short letter. We have been busy.',
    'I had your letter. It helped more than I can say.',
    'I am well enough. Excuse the hand; it is cold.',
    'We are out of the line now. I am whole.',
    'Do not mind the smudges. It has been a long week.',
    'I am all right, though tired down to my boots.',
    'There is little I can put in a letter. I am safe.',
    'Your letter came at the right time. I kept it in my breast pocket.',
  ],
};

const WEATHER_LINES: Record<Weather, readonly string[]> = {
  clear: [
    'The weather has turned fine at last, and the larks were up over the wire this morning, singing fit to burst.',
    'We have had a spell of proper summer, and the men lie out like cats when the sun finds the trench.',
    'It is beautiful weather, which seems a queer thing to write from here.',
    'The sky has been that clean blue you get over the allotments in June.',
    'Fine and dry, and the ground gone hard as the parade square.',
    'The sun was out all day and the sandbags steamed like fresh loaves.',
    'Grand weather. You would not credit what a difference a dry firestep makes.',
    'The evenings are long and gold just now, and the poplars behind us look almost like home.',
    'It has been hot enough to fry an egg on a shovel, and Perks tried it.',
    'Clear skies all week, which the airmen like and we are less sure of.',
  ],
  rain: [
    'It has rained three days without pause, and everything a man owns is wet through.',
    'The rain here is not like rain at home; it has a spite to it.',
    'It is coming down like stair-rods as I write, drumming on the corrugated iron.',
    'We are all of us wet to the skin and past minding it.',
    'The rain finds its way into everything: the bread, the boots, the letters.',
    'It rains, it stops to gather strength, and it rains again.',
    'You may tell Dad the drains at home are nothing to what we contrive here in a downpour.',
    'Rain again. The sump is a pond and the pond has ambitions.',
    'My groundsheet has given up the profession entirely.',
    'The wet gets into your bones and sets up house there.',
  ],
  fog: [
    'A thick white fog has sat on us for two days, and the sentries stare themselves half blind.',
    'Fog again this morning, so heavy you could lean on it.',
    'The mist comes up out of the low ground at dawn like something poured.',
    'Everything drips in this fog: the wire, the bags, the ends of a man’s moustache.',
    'We stood-to twice in the night for shapes that were only fog.',
    'It is queer weather, all milk and silence, and no man loves it.',
    'You cannot see thirty yards, which cuts both ways, as the corporal says.',
    'The fog muffles the guns till they sound like doors shutting far off in a big house.',
  ],
  night: [
    'I write this by the stub of a candle, with the flares going up all along the line like Brock’s benefit.',
    'The nights are the busy time here; we sleep by day like owls in reverse.',
    'It was a quiet night for once, only the machine guns talking to one another.',
    'The star-shells are pretty, if a man could forget what they are for.',
    'There is no dark at home like the dark here between flares.',
    'All night the working parties went up and down, cursing softly, like a church congregation.',
    'The moon was up and full, and nobody thanked it.',
    'Night watches are long, but a man learns every sound, same as you know the house creaks at home.',
  ],
};

const MUD_LINES: readonly string[] = [
  'The mud must be seen to be believed; it pulled the boot clean off Ashworth and kept it.',
  'We are mud to the eyebrows, all of us, and past caring.',
  'The mud here is a living thing, and it is winning.',
  'I have given up on my boots ever being boots again.',
  'You would laugh to see us, plastered like navvies from head to foot.',
  'A limber went into the mud by the crossroads Tuesday, and I believe it is in Australia by now.',
  'The trench boards float in places, and a man walks like he is at sea.',
  'Do not send anything white. Nothing stays white here above an hour.',
  'The mud takes a spoon out of your hand if you look away.',
  'Between the duckboards is a country a man does not visit twice.',
];

// Fighting lines. The tally shapes which pool we draw from; morale shapes
// the sentences. Shaken men write short and leave things unsaid.
const FIGHT_QUIET: Record<Morale, readonly string[]> = {
  high: [
    'It is quiet on our stretch just now, only the usual morning hate and the whizz-bangs at tea time, regular as church bells.',
    'Nothing doing here worth the name. The guns grumble away down south like somebody else’s thunder, and we let them.',
    'All quiet with us. Jerry and we have an understanding at breakfast time, and both sides respect the bacon.',
    'Fritz has been on his best behaviour this week, which we put down to the weather or his sergeant-major.',
  ],
  steady: [
    'It has been quiet on our front, only the ordinary shelling, which a man comes to treat like weather.',
    'Little to report. Working parties, sentry-go, and the guns muttering. The war goes on at its own pace.',
    'We have had a quiet spell, for which nobody complains. Quiet is a wage out here.',
    'Nothing much doing on our stretch. A few whizz-bangs over daily, and no great harm done.',
  ],
  shaken: [
    'It is quieter now. Nobody quite trusts it.',
    'Little doing at present. The quiet has its own weight.',
    'Things are still. After last week, still is enough.',
  ],
};

const FIGHT_MODEST: Record<Morale, readonly string[]> = {
  high: [
    'We had a small affair in the week, soon settled, and the score in our favour.',
    'A few of Fritz’s patrols came calling and were sent home with fleas in their ears.',
    'There was a lively half-hour on Tuesday, more noise than harm, and the noise mostly ours.',
    'Jerry tried a little raid and thought better of it halfway across. Sensible fellow.',
  ],
  steady: [
    'There was a small action here in the week. It came to nothing much, and we lost little by it.',
    'We had a brush with their patrols. It was soon over, and our end of it well managed.',
    'Some shelling and a half-hearted rush one morning. We dealt with it, and the day went on.',
    'A raid came against the company on our left and got nothing for its trouble.',
  ],
  shaken: [
    'There was a scrap in the week. We came off best. I did not care for it.',
    'A raid came in the night. It was seen off. Nights are long here.',
    'There was some trouble Tuesday. It is over now. That is the main thing.',
  ],
};

const FIGHT_WARM: Record<Morale, readonly string[]> = {
  high: [
    'We had a warm day of it Thursday, and gave them a far warmer reception than they had booked for.',
    'Fritz came over in the morning, very confident, and went home a good deal thinner and not confident at all.',
    'They tried our stretch and found us at home to visitors, with everything laid on.',
    'It was brisk work while it lasted, and the old battalion stood up like guardsmen. You may be proud of us; I am.',
    'Jerry paid a call in strength. The bill for it was his entirely.',
    'They came on shoulder to shoulder, poor devils, and our rifles hardly had time to cool.',
  ],
  steady: [
    'We had a sharp attack in the week. It was beaten off well short of the wire, and our line stands where it stood.',
    'There was heavy work here Thursday. We held, and gave better than we got.',
    'The enemy came over in numbers and we saw them off. The Sergeant-Major allowed it was tidily done, which from him is a citation.',
    'We were attacked in the morning and it was warm for an hour. The line held, and I came through without a scratch.',
    'They made a push against us and it failed. I will leave the descriptions to the papers, who were not here.',
  ],
  shaken: [
    'They came over. They did not get in. I will not write more of it.',
    'There was an attack Thursday. We held the line. We are fewer tonight.',
    'It was a hard day. We stopped them. I am glad you cannot see this place.',
    'The worst of it was an hour long. It felt a year. We held.',
  ],
};

const GAS_LINES: Record<Morale, readonly string[]> = {
  high: [
    'The gongs went in the night and we sat in our masks like a congregation of frogs until the all-clear. Some sight we must be.',
    'We had a gas alert Wednesday. The helmets are hateful things, but I bless every stitch of mine, and so may you.',
    'Fritz sent his chemistry over on the wind. The wind changed its mind, which we took as a personal kindness.',
  ],
  steady: [
    'There was gas over on the right. We had the masks on smart; the drill is second nature now, so do not fret on that account.',
    'You will maybe read of gas in the papers. We are well drilled and were not caught, and I will leave it at that.',
    'The gas came over with the dawn mist. We knew it by the smell, like a chemist’s shop gone wrong, and were ready for it.',
  ],
  shaken: [
    'The gas came again. I will not write of it. We were quick with the masks, and that is what matters.',
    'Gas in the night. The gongs, then the waiting. We came through.',
    'There was gas. The masks did their work. I am done writing of it.',
  ],
};

const TANK_LINES: Record<Morale, readonly string[]> = {
  high: [
    'Now Fritz has got himself great steel machines, big as a cottage and twice as loud. We stopped them all the same, and had a good look after.',
    'You will not credit it, but they sent iron landships against us, crawling like toads. The guns settled the argument.',
    'They have machines now that walk over wire as you would over daisies. They burn like anything, which evens the account.',
  ],
  steady: [
    'The enemy brought up armoured machines against our stretch. Queer crawling things. The guns found them, which is some comfort.',
    'We have seen their new machines now. Great iron affairs. We managed, but it is a new war every month out here.',
    'They put their landships at us in the morning. It is a strange thing to stand against, but stand we did.',
  ],
  shaken: [
    'They sent machines against us. Iron things. I did not believe my eyes and do not much want to.',
    'The machines came in the morning. The ground shook. We held, and I will leave it there.',
    'I have seen their iron beasts now. I am in no hurry to see them again.',
  ],
};

type LostLine = (name: string) => string;

const LOST_LINES: readonly LostLine[] = [
  (n) => `I am sorry to tell you ${n} was killed this week. We buried him by the support line, decent and proper, and the padre said the words.`,
  (n) => `${n} has gone west. He was beside me at stand-to that morning, and I can tell his mother truly that he did not suffer.`,
  (n) => `You will remember ${n} from my letters. He is gone, poor lad, and the platoon is a quieter place without him.`,
  (n) => `We lost ${n} on Tuesday. I have his watch and his letters, and I will see they get home if it takes me the rest of the war.`,
  (n) => `${n} was hit going up with the rations. It was quick, which is the one mercy going out here, and he had it.`,
  (n) => `Poor ${n} has been done in. He owed me a franc from cards, and I would give a year’s pay to be owed it still.`,
  (n) => `We put ${n} to rest behind the line, with a cross made from a ration box and the whole section standing to see it done.`,
  (n) => `${n} is gone. He shared every parcel he ever got, and there is no better character a man earns out here.`,
];

const LOST_SHAKEN: readonly LostLine[] = [
  (n) => `${n} is gone. I will not write more of it. He was the best of us.`,
  (n) => `We buried ${n} on Wednesday. The padre said the words. I have nothing to add to them.`,
  (n) => `${n} was beside me. Now he is not. Forgive me if I leave it there.`,
];

const HOMESICK: readonly string[] = [
  'I think of the garden a good deal, and whether the runner beans have come to anything.',
  'Is the shop keeping busy? Some nights I can smell the sawdust of it plain as anything.',
  'Tell me how the Rovers are getting on. We had a game ourselves behind the lines, officers and all, and no prisoners taken.',
  'I dreamed of Sunday dinner last week, Yorkshire pudding and all, and woke up bitter about it.',
  'Has our Winnie had word from Cardew’s yet? She was always the clever one of us.',
  'Remember me to the men at the works, and tell Simmons he still owes me a pint from Whitsun.',
  'I would give a week’s pay for an hour on the towpath with a rod and my own thoughts.',
  'How does the allotment go? Keep the rhubarb in heart and I will see to the rest when I am back.',
  'Is the piano still in tune? I have been humming the same three songs for a month.',
  'Tell Elsie I have her photograph safe, and it has been admired by better judges than me.',
  'I thought of the fair coming to the common about now, and the toffee apples.',
  'Do you still walk to chapel the old way, past the mill? I walk it in my head most evenings.',
  'How is the old dog? Tell him I said stand-to, and see if his ears go up.',
  'I should like a look at the sea again, the proper grey one at home, not the Channel.',
  'Ask Dad whether he ever mended the gate, or whether it still sings in the wind.',
  'The plums will be coming on at home about now, I should think.',
  'Tell Grandad the French farmers plough right up to the road. He would approve.',
  'I miss the quiet of the reading room, and old Mr. Veale telling us to hush.',
  'Some of the fellows here have never seen a proper market day. I have promised them ours is the best in England.',
  'Is little Tom walking yet? He will be a stranger to me at this rate, so send a photograph.',
  'I keep thinking of the kettle on the range and the cat stealing my chair.',
  'You might send the local paper when you write. Even the auction notices read like poetry out here.',
  'How did the harvest go? We watched the French get theirs in, old men and girls doing the work of twenty.',
  'Tell the vicar I have kept my promise, mostly.',
  'Have they mended the clock at St. Anne’s? A town wants its clock.',
  'I have been teaching Welsh hymns to a Cockney, so you see we keep busy.',
  'Send word how the pigeons are doing. Bassett here keeps birds too, and we talk of little else.',
  'I miss the smell of the bakery of a morning more than I can politely say.',
];

const EXTRAS: readonly string[] = [
  'The rats here are the size of terriers and about as shy.',
  'We get the rum ration at stand-down, and it is voted the finest minute of the day.',
  'The bread comes up four men to a loaf, and we watch the cutting of it like magistrates.',
  'There is an estaminet back in the village that does egg and chips, and we speak of it in church voices.',
  'Perks has learned the mouth organ, which is a heavier trial than the shelling.',
  'The tea tastes of petrol from the cans, but a man gets partial to it in time.',
  'We had a concert party Tuesday. The sergeant sang, which wants courage of a kind.',
  'The bully beef and biscuit goes down better than you would think, with hunger for gravy.',
  'My feet are dry today, which out here is worth putting in a letter.',
  'The candles you sent are worth their weight in gold, and trade at about that rate.',
  'We have a cat in the dug-out now, a French cat, very particular about which rats it eats.',
  'The post corporal is the most loved man in France and knows it.',
  'I have learned enough French to buy eggs and apologise, which covers most events.',
  'The guns were at it all night down south, like weather that belongs to someone else.',
  'Our officer is a decent young fellow and shares his parcels, which is the measure of a man out here.',
  'I am grown a fair hand at darning, and shall be useful to you yet.',
  'The whizz-bangs give no notice worth the name, so we have given up ducking on principle.',
  'Jerry sent over his morning hate at breakfast, punctual as a landlord.',
  'The relief came up late and muddy and swearing in a fine Scotch accent.',
  'There is talk of leave. There is always talk of leave. It is our best subject.',
  'A man learns to sleep through the guns and wake at a whisper. Queer, but so it is.',
  'We spend our evenings chatting, which is not talk but hunting the seams of our shirts. Very sociable.',
  'The Maconochie ration is a stew of sorts, and the man who calls it a dinner is an optimist.',
  'They say Blighty leave comes to those who wait. We are all become very good at waiting.',
];

const CLOSINGS: Record<Morale, readonly string[]> = {
  high: [
    'Do not worry about me one ounce; I was born under a lucky star and intend to go on presuming upon it.',
    'Keep smiling, keep my place at the table, and have the kettle on for the duration.',
    'Mind you do not spoil that dog while I am away. Spoiling him is my job, and I mean to resume it.',
    'Save the top of the milk against my return.',
    'Tell Dad the Army has not taught me to like parsnips, and it has taught me everything else.',
    'Do not believe the papers, good news or bad. Believe me, and I say we are all right.',
    'No more now, as the candle is voting to adjourn.',
    'Keep the home fires banked, not blazing; coal is dear, and I shall want some warming when I get back.',
  ],
  steady: [
    'Do not worry over me. I am careful, and the boys look out for one another here.',
    'Mind the coal now the nights draw in, and see Mother does not go short.',
    'Kiss the little ones for me and tell them their Dad thinks of them last thing every night.',
    'Write when you can. Letters are worth more than rations out here, and I mean that plainly.',
    'Look after yourselves first and me second; I am better placed than you would think.',
    'Take care of the garden and the girls, and I will take care of myself.',
    'That is all my news that will pass the censor. The rest will keep till I am home.',
    'God keep you all till I see you again.',
  ],
  shaken: [
    'Do not worry. I am all right.',
    'Write soon. Your letters do me good, more than you know.',
    'Take care of Mother. Tell her I am well.',
    'That is all for now. Think of me sometimes of an evening.',
    'Keep my things as they are. I shall want them again.',
    'Say a prayer for the boys out here. That is all I ask.',
    'I am tired, so I will end. I am safe, and I love you all.',
    'Mind the coal. Mind each other. I will write again soon.',
  ],
};

// ---------------------------------------------------------------------------
// writeLetterHome
// ---------------------------------------------------------------------------

// A man reporting his own mention in despatches — understated, as they were.
// `cite` already reads "for coolness under heavy fire", so it slots straight on.
const DESPATCH_LINES: readonly ((cite: string) => string)[] = [
  (c) => `The Major was good enough to mention me in despatches ${c}. I make nothing of it, but thought it would please you.`,
  (c) => `You may hear that I was mentioned in despatches ${c}. It was no more than the next man did, and I would sooner have the leave.`,
  (c) => `They have gone and put my name in despatches ${c}. Do not tell the whole street; you know you will.`,
  (c) => `There is to be a mention in despatches ${c}, they tell me. Keep it by you, and do not let Dad crow at the works.`,
];

// The long-served man writes with the weight of it.
const VETERAN_LINES: readonly ((n: number) => string)[] = [
  (n) => `This is my ${ordinalWord(n).toLowerCase()} time in the line, and I have learned to sleep standing and eat near anything.`,
  (n) => `I have seen ${n} of their attacks off now, and am reckoned an old hand — which out here means only that I am still here.`,
  (n) => `The new drafts ask me how it is done. ${n} times over the same ground teaches a man to keep his head down and his humour up.`,
];

function buildDynamicExtras(ctx: LetterCtx): string[] {
  const out: string[] = [
    `It was ${ctx.dateStr} when I began this letter, though the days out here run together like the rain.`,
    `You may tell them at the Institute that the ${ctx.regiment} is holding its own and a little over.`,
  ];
  if (ctx.wave >= 8) {
    out.push('We are old soldiers now by the reckoning of this place, and the new drafts look at us as if we were furniture.');
  }
  return out;
}

/**
 * Compose a letter home: 60-130 words, greeting through closing sentence.
 * The valediction and signature are the caller's affair.
 */
export function writeLetterHome(ctx: LetterCtx, rand: () => number): string {
  const morale = ctx.morale;

  const greeting = pick(rand, GREETINGS);
  const opener = pick(rand, OPENERS[morale]);
  const weather = pick(rand, WEATHER_LINES[ctx.weather]);
  const homesick = pick(rand, HOMESICK);
  const closing = pick(rand, CLOSINGS[morale]);

  // The oblique reference to the fighting. Gas outranks armour outranks
  // the plain tally, because that is what a man would mention first.
  let fight: string;
  if (ctx.sawGas) fight = pick(rand, GAS_LINES[morale]);
  else if (ctx.sawTank) fight = pick(rand, TANK_LINES[morale]);
  else if (ctx.kills >= 10) fight = pick(rand, FIGHT_WARM[morale]);
  else if (ctx.kills > 0) fight = pick(rand, FIGHT_MODEST[morale]);
  else fight = pick(rand, FIGHT_QUIET[morale]);

  const lost: string | null =
    ctx.lostMate !== null && ctx.lostMate.length > 0
      ? pick(rand, morale === 'shaken' ? LOST_SHAKEN : LOST_LINES)(ctx.lostMate)
      : null;

  let words =
    countWords(greeting) + countWords(opener) + countWords(weather) +
    countWords(fight) + countWords(homesick) + countWords(closing) +
    (lost !== null ? countWords(lost) : 0);

  const para1: string[] = [opener, weather];

  if (ctx.mud) {
    const mudLine = pick(rand, MUD_LINES);
    const w = countWords(mudLine);
    if (words + w <= 126) {
      para1.push(mudLine);
      words += w;
    }
  }

  // When a friend has died and the letter is already heavy, the fighting
  // itself goes unmentioned — the reader will understand.
  let includeFight = true;
  if (lost !== null && words > 128) {
    includeFight = false;
    words -= countWords(fight);
  }
  if (includeFight) {
    para1.push(fight);
    // A wave with both gas and armour earns a second line of disbelief.
    if (ctx.sawGas && ctx.sawTank) {
      const second = pick(rand, TANK_LINES[morale]);
      const w = countWords(second);
      if (words + w <= 122) {
        para1.push(second);
        words += w;
      }
    }
  }

  // A despatch mention of the author's own, reported in the period manner.
  if (ctx.citedDeed && words <= 110) {
    const line = pick(rand, DESPATCH_LINES)(ctx.citedDeed);
    const w = countWords(line);
    if (words + w <= 128) { para1.push(line); words += w; }
  }
  // A veteran of many attacks writes with that weight (kept occasional).
  const served = ctx.wavesServed ?? 0;
  if (served >= 3 && words <= 108 && rand() < 0.6) {
    const line = pick(rand, VETERAN_LINES)(served);
    const w = countWords(line);
    if (words + w <= 126) { para1.push(line); words += w; }
  }

  // Pad short letters with trench-life colour until they earn their stamp.
  const used = new Set<number>();
  while (words < 64) {
    const extra = pickUnused(rand, EXTRAS, used);
    if (extra === null) break;
    para1.push(extra);
    words += countWords(extra);
  }
  if (rand() < 0.4) {
    const extra = pickUnused(rand, EXTRAS, used);
    if (extra !== null) {
      const w = countWords(extra);
      if (words + w <= 122) {
        para1.push(extra);
        words += w;
      }
    }
  }
  if (rand() < 0.35) {
    const dyn = pick(rand, buildDynamicExtras(ctx));
    const w = countWords(dyn);
    if (words + w <= 124) {
      para1.push(dyn);
      words += w;
    }
  }

  const para2: string[] = [homesick, closing];

  // A fallen mate who had been decorated is honoured in passing.
  let lostPara = lost;
  if (lostPara !== null && ctx.lostMateDeed) {
    lostPara += ` He had been mentioned in despatches ${ctx.lostMateDeed}, and deserved a kinder end than this place gives.`;
  }

  const paras: string[] = [para1.join(' ')];
  if (lostPara !== null) paras.push(lostPara);
  paras.push(para2.join(' '));

  return `${greeting},\n\n${paras.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// intelFlavor — one dry staff-officer sentence on the coming attraction
// ---------------------------------------------------------------------------

type IntelLine = (intent: string) => string;

const INTEL_LINES: readonly IntelLine[] = [
  (i) => `Corps intelligence appreciates the enemy's intention as ${i}; the ration of optimism remains unchanged.`,
  (i) => `Divisional summary, for what it is worth, promises ${i} before the week is out.`,
  (i) => `Prisoner statements point to ${i}; prisoners, of course, will say anything for a cigarette.`,
  (i) => `Aerial observation suggests ${i}, weather permitting, which it seldom does.`,
  (i) => `Staff appreciation: expect ${i}. The staff, as ever, will observe the matter from a comfortable distance.`,
  (i) => `Intelligence has it on good authority — one deserter and a pigeon — that ${i} is intended.`,
  (i) => `The summary reads "${i}"; the men are advised to draw their own conclusions and extra ammunition.`,
  (i) => `Corps expects ${i} and requests that units be so good as to survive it.`,
  (i) => `Brigade signals ${i} within twenty-four hours, brigade having been wrong before, but never twice in one day.`,
  (i) => `Listening posts report sounds consistent with ${i}; they also report rats, which are consistent with everything.`,
  (i) => `The map at Corps shows ${i} in blue pencil, and the map at Corps is rarely troubled by events.`,
  (i) => `Expect ${i} at or about dawn; dawn remains the enemy's favourite hour and nobody has written to complain.`,
  (i) => `G.H.Q. anticipates ${i} and has expressed complete confidence in the men, from a distance of thirty miles.`,
  (i) => `All indications point to ${i}. Units will stand to from one hour before first light, as if they needed telling.`,
];

/** Lower-case a fragment's leading letter so it reads naturally mid-sentence.
 *  Leaves acronyms alone ("G.H.Q. reserves" stays as written). */
function midSentence(fragment: string): string {
  if (/^[A-Z][A-Z.]/.test(fragment)) return fragment;
  return fragment.charAt(0).toLowerCase() + fragment.slice(1);
}

export function intelFlavor(intent: string, rand: () => number): string {
  return pick(rand, INTEL_LINES)(midSentence(intent));
}

// ---------------------------------------------------------------------------
// waveName — the men name what is coming for them
// ---------------------------------------------------------------------------

const WAVE_POOLS: Record<string, readonly string[]> = {
  probe: [
    'Morning Hate', 'Owl Light', 'The Feeling Hand', 'First Light Feelers',
    'The Quiet Before', 'Patrol Weather', 'The Wire Walkers',
  ],
  mass: [
    'The Big Push', 'The Grey Tide', 'Field Grey Morning',
    'The Long Grey Line', 'Shoulder to Shoulder', 'The Great Attempt',
    'The Flood',
  ],
  storm: [
    'Thunderclap', 'The Breaking Wave', 'Hurricane Hour', 'The Sudden Dark',
    'Lightning at the Parapet', 'The Rush', 'Storm Call',
  ],
  barrage_assault: [
    'Iron Rain', 'The Drumfire', 'The Steel Curtain', 'The Hammer Falls',
    'Under the Guns', 'The Creeping Wall', 'Shell Weather',
  ],
  cavalry_raid: [
    'Hooves in the Fog', 'The Grey Riders', 'Sabre Dawn',
    'Lances at Morning', 'The Wild Ride', 'Horse Thunder', 'The Last Charge',
  ],
  armour_push: [
    'The Iron Toads', 'The Crawling Forts', 'Steel Beasts at Walking Pace',
    'The Juggernaut Hour', 'Iron Weather', 'The Landships',
    'Engines in the Smoke',
  ],
  gas_attack: [
    'The Yellow Wind', 'Green Cloud Morning', 'The Chemist’s Hour',
    'The Choking Fog', 'Wind from the North', 'The Devil’s Breath',
    'Gong Weather',
  ],
  combined: [
    'Der Tag', 'The Full Orchestra', 'All Arms', 'The Kaiser’s Fist',
    'Everything at Once', 'The Grand Assault', 'The Whole Works',
  ],
};

const GENERIC_WAVE_POOL: readonly string[] = [
  'The Attack', 'The Morning Show', 'The Next Thing', 'Trouble Coming',
  'The Usual, But Worse',
];

const WAVE_FORMAL_NOUN: Record<string, string> = {
  probe: 'Reconnaissance',
  mass: 'Assault',
  storm: 'Storm',
  barrage_assault: 'Bombardment',
  cavalry_raid: 'Ride',
  armour_push: 'Advance',
  gas_attack: 'Cloud',
  combined: 'Offensive',
};

export function waveName(wave: number, template: string, rand: () => number): string {
  if (wave >= 10 && rand() < 0.45) {
    const noun = WAVE_FORMAL_NOUN[template] ?? 'Offensive';
    return `The ${ordinalWord(wave)} ${noun}`;
  }
  const pool = WAVE_POOLS[template] ?? GENERIC_WAVE_POOL;
  return pick(rand, pool);
}
