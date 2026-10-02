// All words the visitor reads. Plain language, no jargon. Edit here, not in the scene code.
// Each stop = one room. `beats` are the three short thoughts of the guided tour (about 12s each).
// `props` are the clickable things in Explore mode; ids match the builders in scene.js.

export const STOPS = [
  {
    id: 'door',
    short: 'Front door',
    title: 'The front door',
    kicker: 'You type, it listens',
    beats: [
      { focus: 'slot', text: 'This is where it all starts. You type a sentence, like "fix the broken button", and press Enter. A program you talk to by typing is called a command-line tool.' },
      { focus: 'lamp', text: 'There are no buttons or menus. Just one line of text. It looks small, but everything else in this house sits behind this door.' },
      { focus: 'scroll', text: 'On its own, a language model is a very well-read mind with no home. Athena is the house built around it, so it can actually help you.' },
    ],
    props: [
      { id: 'slot', name: 'The message slot', text: 'Your request goes in here as plain words. Whatever you type is what the house reads.' },
      { id: 'lamp', name: 'The porch lamp', text: 'A little light that says "someone is home". The program is waiting for you to speak first.' },
      { id: 'scroll', name: 'Your note', text: 'Your request, rolled up and sent inside. Short and ordinary is fine: "what does this folder do?"' },
    ],
  },
  {
    id: 'study',
    short: 'Study',
    title: 'The study',
    kicker: 'Where the thinking happens',
    beats: [
      { focus: 'owl', text: 'Inside lives the model: a brilliant owl who has read nearly everything. It reads your note and thinks about what you want.' },
      { focus: 'glass', text: 'But look at the glass. The owl can only talk. It cannot open a file, change anything, or see your screen. Words are all it has.' },
      { focus: 'orb', text: 'So the house gives it ways to reach out, one careful step at a time. The next rooms are about exactly that.' },
    ],
    props: [
      { id: 'owl', name: 'The owl', text: 'The language model. It writes and reasons very well, but only in words.' },
      { id: 'glass', name: 'The glass pane', text: 'A clear wall between the owl and the real world. It can see your note, and nothing else, until the house hands it something.' },
      { id: 'orb', name: 'The thought', text: 'Its next idea, like "I should look at that file first". An idea is just words until a tool acts on it.' },
      { id: 'books', name: 'The books', text: 'Everything the owl learned before it met you. Wide, but frozen in time. It does not know your project yet.' },
    ],
  },
  {
    id: 'tools',
    short: 'Tool wall',
    title: 'The tool wall',
    kicker: 'Hands for the thinker',
    beats: [
      { focus: 'magnifier', text: 'When the owl wants to do something, it asks for a tool by name. The magnifying glass reads a file. The house runs it and hands back what it found.' },
      { focus: 'hammer', text: 'The hammer changes things: it writes or edits a file. The cog runs a command, like starting a test. Each tool does one clear job.' },
      { focus: 'slash', text: 'The signs are shortcuts for you. Type a slash, like /help, and the house does a ready-made chore without asking the owl at all.' },
    ],
    props: [
      { id: 'magnifier', name: 'Look at a file', text: 'Reads what is inside a file or folder, so the owl is working from the real thing rather than a guess.' },
      { id: 'hammer', name: 'Change a file', text: 'Writes or edits a file. This is the kind of tool the gatekeeper watches most closely.' },
      { id: 'cog', name: 'Run a command', text: 'Starts a small program on your computer, like checking that your work still passes its tests.' },
      { id: 'slash', name: 'Shortcut signs', text: 'Typing a slash and a word, like /help, triggers a ready-made action. Handy for you, quick for the house.' },
    ],
  },
  {
    id: 'lodge',
    short: 'Gatekeeper',
    title: 'The gatekeeper\'s lodge',
    kicker: 'Nothing risky leaves without a nod',
    beats: [
      { focus: 'keeper', text: 'Here the gatekeeper watches the door. When the owl wants to do something that could change things, it waits. You see the request and you say yes or no.' },
      { focus: 'ropes', text: 'Some places are always closed. Important system folders sit behind a red rope. No answer, from anyone, opens them.' },
      { focus: 'stamp', text: 'You can also tell the gatekeeper which projects you trust. Trusted ones get fewer questions. Strangers always get the full check.' },
    ],
    props: [
      { id: 'keeper', name: 'The gatekeeper', text: 'Stops anything risky and shows you exactly what is about to happen, in plain words.' },
      { id: 'ropes', name: 'The red rope', text: 'Always off-limits. These protected places cannot be changed, however the question is asked.' },
      { id: 'stamp', name: 'The "yes" stamp', text: 'Your approval. One stamp allows one thing, and it can be as narrow or as wide as you choose.' },
      { id: 'gate', name: 'The barrier', text: 'Down by default. It only lifts after a clear yes.' },
    ],
  },
  {
    id: 'notes',
    short: 'Notebook',
    title: 'The notebook room',
    kicker: 'It remembers',
    beats: [
      { focus: 'book', text: 'The owl writes down what it learns about your project: how you like things done, where things live. Tomorrow it does not start from zero.' },
      { focus: 'journal', text: 'It also keeps a journal of what really happened. Entries record facts, and guesses are scored against the outcome so it learns honestly.' },
      { focus: 'drawer', text: 'Your keys stay in a locked drawer on your own computer. They never travel to another machine, and they never go into shared files.' },
    ],
    props: [
      { id: 'book', name: 'The project notebook', text: 'Lasting notes about your project, so help gets better the longer you work together.' },
      { id: 'journal', name: 'The journal', text: 'A day-by-day record of what happened, kept so the house can check its own memory against the facts.' },
      { id: 'drawer', name: 'The locked drawer', text: 'Where your private keys are stored, on this machine only. Each computer sets up its own.' },
      { id: 'calendar', name: 'The calendar', text: 'Memory across days. Notes written on Monday are still here on Friday.' },
    ],
  },
  {
    id: 'annex',
    short: 'Workshop',
    title: 'The workshop annex',
    kicker: 'Add your own tools',
    beats: [
      { focus: 'socket', text: 'This little workshop is for you. See the empty slot? Anyone can build a new tool and plug it in. That is what a plugin is.' },
      { focus: 'bench', text: 'Plug one in and it appears on the tool wall, ready to use. A tool that checks your spelling, files a ticket, or reads a spreadsheet.' },
      { focus: 'blocks', text: 'You can add shortcuts and helpers too. The house is not fixed. It grows to fit the way you work.' },
    ],
    props: [
      { id: 'socket', name: 'The empty slot', text: 'Where a new tool plugs in. It ships empty on purpose.' },
      { id: 'bench', name: 'The workbench', text: 'Where tools get made. Building one is a small job, not a research project.' },
      { id: 'blocks', name: 'The building blocks', text: 'Tools, shortcuts and helpers you can snap together.' },
    ],
  },
  {
    id: 'balcony',
    short: 'Balcony',
    title: 'The balcony',
    kicker: 'Talk instead of type',
    beats: [
      { focus: 'mic', text: 'Step outside and you do not have to type at all. Say a short wake word, then speak. The owl answers out loud.' },
      { focus: 'waves', text: 'This matters most for people who cannot easily use a screen. Everything the house does can be spoken and heard.' },
      { focus: 'moon', text: 'Permission works by voice too, and it is strict. A vague "uh huh" does not count. The gatekeeper needs a clear yes.' },
    ],
    props: [
      { id: 'mic', name: 'The microphone', text: 'Listens for the wake word, then your request. It works hands-free.' },
      { id: 'waves', name: 'The sound waves', text: 'Your voice going in, and the owl\'s voice coming back.' },
      { id: 'moon', name: 'The quiet night', text: 'Voice is optional. Many people never turn it on, and the rest of the house works just the same.' },
    ],
  },
  {
    id: 'house',
    short: 'Whole house',
    title: 'The whole house',
    kicker: 'You can build your own',
    finale: true,
    beats: [
      { focus: null, text: 'A door to speak at. A thinker. Hands. A gatekeeper. A notebook. A workshop. A voice. That is the whole of it.' },
      { focus: null, text: 'None of this is magic. It is rooms and rules around a language model, and you can build your own, one room at a time.' },
    ],
    props: [],
  },
]

export const SITE = {
  title: 'Inside Athena',
  tagline: 'A language model is a clever mind. A command-line tool is the house that lets it see, reach, remember and act safely. Take a walk through one.',
}
