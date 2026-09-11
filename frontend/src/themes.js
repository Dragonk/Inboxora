import { brandSvg } from './brandMark.js';
export const THEMES = {
  // Ink leads the object on purpose: the appearance tab iterates THEMES in
  // insertion order, so the new default theme is also the first suggestion.
  ink: {
    label: 'Ink',
    tone: 'light',
    description: 'Paper and fountain-pen indigo — the default light theme',
    preview: ['#f6f5f1', '#edece6', '#35548a', '#212b36'],
    vars: {
      '--bg-primary': '#f6f5f1',
      '--bg-secondary': '#edece6',
      '--bg-tertiary': '#e5e4dc',
      '--bg-elevated': '#fbfaf7',
      '--bg-hover': '#e0dfd6',
      '--border': '#d2d0c5',
      '--border-subtle': '#e2e0d7',
      '--text-primary': '#212b36',
      '--text-secondary': '#4d586b',
      '--text-tertiary': '#939aa3',
      '--accent': '#35548a',
      '--accent-text': '#ffffff',
      '--accent-dim': '#e3e9f2',
      '--accent-glow': 'rgba(53,84,138,0.14)',
      '--green': '#35793a',
      '--red': '#a32e2e',
      '--amber': '#a87518',
    }
  },

  dark_ink: {
    label: 'Dark ink',
    tone: 'dark',
    description: 'Dark paper and fountain-pen indigo — the dark counterpart of Ink',
    preview: ['#14171c', '#1a1e25', '#8aa5dd', '#e8e6df'],
    vars: {
      '--bg-primary': '#14171c',
      '--bg-secondary': '#1a1e25',
      '--bg-tertiary': '#21262f',
      '--bg-elevated': '#262c36',
      '--bg-hover': '#2c333e',
      '--border': '#363d49',
      '--border-subtle': '#262c36',
      '--text-primary': '#e8e6df',
      '--text-secondary': '#a9b0bd',
      '--text-tertiary': '#6b7480',
      '--accent': '#8aa5dd',
      '--accent-text': '#10141b',
      '--accent-dim': '#242f47',
      '--accent-glow': 'rgba(138,165,221,0.16)',
      '--green': '#6fbf7e',
      '--red': '#e08a8a',
      '--amber': '#d9ab55',
    }
  },

  dark: {
    label: 'Dark',
    tone: 'dark',
    description: 'Neutral dark — the former dark default',
    preview: ['#0f0f11', '#161619', '#7c6af7', '#e8e8ed'],
    vars: {
      '--bg-primary': '#0f0f11',
      '--bg-secondary': '#161619',
      '--bg-tertiary': '#1e1e23',
      '--bg-elevated': '#242429',
      '--bg-hover': '#2a2a30',
      '--border': '#2e2e35',
      '--border-subtle': '#232328',
      '--text-primary': '#e8e8ed',
      '--text-secondary': '#9898a8',
      '--text-tertiary': '#5a5a6a',
      '--accent': '#7c6af7',
      '--accent-text': '#ffffff',
      '--accent-dim': '#3d3569',
      '--accent-glow': 'rgba(124,106,247,0.15)',
      '--green': '#4ade80',
      '--red': '#f87171',
      '--amber': '#fbbf24',
    }
  },

  light: {
    label: 'Light',
    tone: 'light',
    description: 'Neutral light — the former light default',
    preview: ['#f8f8fc', '#ffffff', '#6366f1', '#1a1a2e'],
    vars: {
      '--bg-primary': '#f0f0f5',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#f5f5fa',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#ebebf5',
      '--border': '#d8d8e8',
      '--border-subtle': '#e8e8f0',
      '--text-primary': '#1a1a2e',
      '--text-secondary': '#4a4a6a',
      '--text-tertiary': '#8888aa',
      '--accent': '#6366f1',
      '--accent-text': '#ffffff',
      '--accent-dim': '#e0e0ff',
      '--accent-glow': 'rgba(99,102,241,0.12)',
      '--green': '#16a34a',
      '--red': '#dc2626',
      '--amber': '#d97706',
    }
  },

  gtd: {
    label: 'GTD',
    tone: 'dark',
    description: 'Getting Things Done — dark, per-state accents',
    preview: ['#0f0f11', '#161619', '#4A9EDD', '#e8e8ed'],
    vars: {
      '--bg-primary': '#0f0f11',
      '--bg-secondary': '#161619',
      '--bg-tertiary': '#1e1e23',
      '--bg-elevated': '#242429',
      '--bg-hover': '#2a2a30',
      '--border': '#2e2e35',
      '--border-subtle': '#232328',
      '--text-primary': '#e8e8ed',
      '--text-secondary': '#9898a8',
      '--text-tertiary': '#5a5a6a',
      '--accent': '#4A9EDD',
      '--accent-text': '#ffffff',
      '--accent-dim': '#10293f',
      '--accent-glow': 'rgba(74,158,221,0.15)',
      '--green': '#2FBD85',
      '--red': '#E56A6A',
      '--amber': '#D9B430',
    }
  },

  gruvbox: {
    label: 'Gruvbox',
    tone: 'dark',
    description: 'Retro groove',
    preview: ['#282828', '#3c3836', '#d79921', '#ebdbb2'],
    vars: {
      '--bg-primary': '#1d2021',
      '--bg-secondary': '#282828',
      '--bg-tertiary': '#32302f',
      '--bg-elevated': '#3c3836',
      '--bg-hover': '#504945',
      '--border': '#504945',
      '--border-subtle': '#3c3836',
      '--text-primary': '#ebdbb2',
      '--text-secondary': '#d5c4a1',
      '--text-tertiary': '#928374',
      '--accent': '#d79921',
      '--accent-text': '#ffffff',
      '--accent-dim': '#3c3401',
      '--accent-glow': 'rgba(215,153,33,0.15)',
      '--green': '#b8bb26',
      '--red': '#fb4934',
      '--amber': '#fe8019',
    }
  },

  catppuccin_mocha: {
    label: 'Catppuccin Mocha',
    tone: 'dark',
    description: 'Soothing pastel dark',
    preview: ['#1e1e2e', '#181825', '#cba6f7', '#cdd6f4'],
    vars: {
      '--bg-primary': '#1e1e2e',
      '--bg-secondary': '#181825',
      '--bg-tertiary': '#313244',
      '--bg-elevated': '#45475a',
      '--bg-hover': '#585b70',
      '--border': '#45475a',
      '--border-subtle': '#313244',
      '--text-primary': '#cdd6f4',
      '--text-secondary': '#bac2de',
      '--text-tertiary': '#6c7086',
      '--accent': '#cba6f7',
      '--accent-text': '#ffffff',
      '--accent-dim': '#2a1f3d',
      '--accent-glow': 'rgba(203,166,247,0.15)',
      '--green': '#a6e3a1',
      '--red': '#f38ba8',
      '--amber': '#fab387',
    }
  },

  catppuccin_latte: {
    label: 'Catppuccin Latte',
    tone: 'light',
    description: 'Soothing pastel light',
    preview: ['#eff1f5', '#e6e9ef', '#8839ef', '#4c4f69'],
    vars: {
      '--bg-primary': '#eff1f5',
      '--bg-secondary': '#e6e9ef',
      '--bg-tertiary': '#dce0e8',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#ccd0da',
      '--border': '#ccd0da',
      '--border-subtle': '#dce0e8',
      '--text-primary': '#4c4f69',
      '--text-secondary': '#5c5f77',
      '--text-tertiary': '#9ca0b0',
      '--accent': '#8839ef',
      '--accent-text': '#ffffff',
      '--accent-dim': '#e5d4fc',
      '--accent-glow': 'rgba(136,57,239,0.1)',
      '--green': '#40a02b',
      '--red': '#d20f39',
      '--amber': '#df8e1d',
    }
  },

  nord: {
    label: 'Nord',
    tone: 'dark',
    description: 'Arctic, north-bluish',
    preview: ['#2e3440', '#3b4252', '#88c0d0', '#eceff4'],
    vars: {
      '--bg-primary': '#2e3440',
      '--bg-secondary': '#3b4252',
      '--bg-tertiary': '#434c5e',
      '--bg-elevated': '#4c566a',
      '--bg-hover': '#5a6477',
      '--border': '#4c566a',
      '--border-subtle': '#434c5e',
      '--text-primary': '#eceff4',
      '--text-secondary': '#e5e9f0',
      '--text-tertiary': '#7b88a1',
      '--accent': '#88c0d0',
      '--accent-text': '#ffffff',
      '--accent-dim': '#1e3040',
      '--accent-glow': 'rgba(136,192,208,0.15)',
      '--green': '#a3be8c',
      '--red': '#bf616a',
      '--amber': '#ebcb8b',
    }
  },

  tokyo_night: {
    label: 'Tokyo Night',
    tone: 'dark',
    description: 'City lights after dark',
    preview: ['#1a1b26', '#16161e', '#7aa2f7', '#c0caf5'],
    vars: {
      '--bg-primary': '#1a1b26',
      '--bg-secondary': '#16161e',
      '--bg-tertiary': '#1f2335',
      '--bg-elevated': '#24283b',
      '--bg-hover': '#292e42',
      '--border': '#292e42',
      '--border-subtle': '#1f2335',
      '--text-primary': '#c0caf5',
      '--text-secondary': '#a9b1d6',
      '--text-tertiary': '#565f89',
      '--accent': '#7aa2f7',
      '--accent-text': '#ffffff',
      '--accent-dim': '#1a2342',
      '--accent-glow': 'rgba(122,162,247,0.15)',
      '--green': '#9ece6a',
      '--red': '#f7768e',
      '--amber': '#e0af68',
    }
  },

  solarized: {
    label: 'Solarized Dark',
    tone: 'dark',
    description: 'Precision colors for machines',
    preview: ['#002b36', '#073642', '#268bd2', '#839496'],
    vars: {
      '--bg-primary': '#002b36',
      '--bg-secondary': '#073642',
      '--bg-tertiary': '#083f4d',
      '--bg-elevated': '#0a4555',
      '--bg-hover': '#0d5060',
      '--border': '#0d5060',
      '--border-subtle': '#083f4d',
      '--text-primary': '#839496',
      '--text-secondary': '#657b83',
      '--text-tertiary': '#4a6068',
      '--accent': '#268bd2',
      '--accent-text': '#ffffff',
      '--accent-dim': '#0a2a3d',
      '--accent-glow': 'rgba(38,139,210,0.15)',
      '--green': '#859900',
      '--red': '#dc322f',
      '--amber': '#b58900',
    }
  },

  dracula: {
    label: 'Dracula',
    tone: 'dark',
    description: 'Dark theme for the night owl',
    preview: ['#282a36', '#1e1f29', '#bd93f9', '#f8f8f2'],
    vars: {
      '--bg-primary': '#282a36',
      '--bg-secondary': '#1e1f29',
      '--bg-tertiary': '#313244',
      '--bg-elevated': '#44475a',
      '--bg-hover': '#4d5068',
      '--border': '#44475a',
      '--border-subtle': '#313244',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#e0e0e8',
      '--text-tertiary': '#6272a4',
      '--accent': '#bd93f9',
      '--accent-text': '#ffffff',
      '--accent-dim': '#2a1f45',
      '--accent-glow': 'rgba(189,147,249,0.15)',
      '--green': '#50fa7b',
      '--red': '#ff5555',
      '--amber': '#ffb86c',
    }
  },

  rose_pine: {
    label: 'Rosé Pine',
    tone: 'dark',
    description: 'All natural pine, faux fur',
    preview: ['#191724', '#1f1d2e', '#c4a7e7', '#e0def4'],
    vars: {
      '--bg-primary': '#191724',
      '--bg-secondary': '#1f1d2e',
      '--bg-tertiary': '#26233a',
      '--bg-elevated': '#2a2837',
      '--bg-hover': '#31304a',
      '--border': '#31304a',
      '--border-subtle': '#26233a',
      '--text-primary': '#e0def4',
      '--text-secondary': '#c5c3d6',
      '--text-tertiary': '#6e6a86',
      '--accent': '#c4a7e7',
      '--accent-text': '#ffffff',
      '--accent-dim': '#2a1f3d',
      '--accent-glow': 'rgba(196,167,231,0.15)',
      '--green': '#9ccfd8',
      '--red': '#eb6f92',
      '--amber': '#f6c177',
    }
  },

  midnight_blue: {
    label: 'Midnight Blue',
    tone: 'dark',
    description: 'Deep navy with electric blue — bold and immersive',
    preview: ['#070d1a', '#0d1629', '#3b9eff', '#c8e0ff'],
    vars: {
      '--bg-primary': '#070d1a',
      '--bg-secondary': '#0d1629',
      '--bg-tertiary': '#112040',
      '--bg-elevated': '#162850',
      '--bg-hover': '#1c3060',
      '--border': '#1c3060',
      '--border-subtle': '#112040',
      '--text-primary': '#c8e0ff',
      '--text-secondary': '#7aacff',
      '--text-tertiary': '#3a5880',
      '--accent': '#3b9eff',
      '--accent-text': '#ffffff',
      '--accent-dim': '#0a1e40',
      '--accent-glow': 'rgba(59,158,255,0.15)',
      '--green': '#4ade80',
      '--red': '#f87171',
      '--amber': '#fbbf24',
    }
  },

  cyberpunk: {
    label: 'Cyberpunk',
    tone: 'dark',
    description: 'Dark neon with hot pink — electric and futuristic',
    preview: ['#0a0010', '#110020', '#ff00aa', '#f0d0ff'],
    vars: {
      '--bg-primary': '#0a0010',
      '--bg-secondary': '#110020',
      '--bg-tertiary': '#1a0030',
      '--bg-elevated': '#240040',
      '--bg-hover': '#2e0050',
      '--border': '#3d0070',
      '--border-subtle': '#1a0030',
      '--text-primary': '#f0d0ff',
      '--text-secondary': '#c080ff',
      '--text-tertiary': '#803080',
      '--accent': '#ff00aa',
      '--accent-text': '#ffffff',
      '--accent-dim': '#3d0025',
      '--accent-glow': 'rgba(255,0,170,0.18)',
      '--green': '#00ff9d',
      '--red': '#ff3860',
      '--amber': '#ffdd00',
    }
  },

  forest: {
    label: 'Forest',
    tone: 'dark',
    description: 'Deep green with emerald — lush and organic',
    preview: ['#0a1a0d', '#0f2214', '#00c896', '#c8f0d0'],
    vars: {
      '--bg-primary': '#0a1a0d',
      '--bg-secondary': '#0f2214',
      '--bg-tertiary': '#152d1a',
      '--bg-elevated': '#1c3a21',
      '--bg-hover': '#244a2a',
      '--border': '#244a2a',
      '--border-subtle': '#152d1a',
      '--text-primary': '#c8f0d0',
      '--text-secondary': '#7acc90',
      '--text-tertiary': '#3a6644',
      '--accent': '#00c896',
      '--accent-text': '#ffffff',
      '--accent-dim': '#003325',
      '--accent-glow': 'rgba(0,200,150,0.15)',
      '--green': '#5af0a0',
      '--red': '#ff6b6b',
      '--amber': '#ffd166',
    }
  },

  sunset: {
    label: 'Sunset',
    tone: 'dark',
    description: 'Warm dark amber with golden orange — rich and warm',
    preview: ['#130b00', '#1e1100', '#ff9900', '#ffe8c8'],
    vars: {
      '--bg-primary': '#130b00',
      '--bg-secondary': '#1e1100',
      '--bg-tertiary': '#2a1800',
      '--bg-elevated': '#382200',
      '--bg-hover': '#452c00',
      '--border': '#503500',
      '--border-subtle': '#2a1800',
      '--text-primary': '#ffe8c8',
      '--text-secondary': '#e0b880',
      '--text-tertiary': '#805030',
      '--accent': '#ff9900',
      '--accent-text': '#ffffff',
      '--accent-dim': '#3d2200',
      '--accent-glow': 'rgba(255,153,0,0.15)',
      '--green': '#7cb87a',
      '--red': '#ff5555',
      '--amber': '#ffcc44',
    }
  },

  executive: {
    label: 'Executive',
    tone: 'dark',
    description: 'Dark navy with antique gold — formal and authoritative',
    preview: ['#0a0d1a', '#101525', '#c8a840', '#ddd0b0'],
    vars: {
      '--bg-primary': '#0a0d1a',
      '--bg-secondary': '#101525',
      '--bg-tertiary': '#161d32',
      '--bg-elevated': '#1e273f',
      '--bg-hover': '#25304e',
      '--border': '#2c3a5a',
      '--border-subtle': '#161d32',
      '--text-primary': '#ddd0b0',
      '--text-secondary': '#b0a080',
      '--text-tertiary': '#605840',
      '--accent': '#c8a840',
      '--accent-text': '#ffffff',
      '--accent-dim': '#2d2000',
      '--accent-glow': 'rgba(200,168,64,0.15)',
      '--green': '#6ab87a',
      '--red': '#c85050',
      '--amber': '#d4933a',
    }
  },

  parchment: {
    label: 'Parchment',
    tone: 'light',
    description: 'Cream and sepia — classic and scholarly',
    preview: ['#f5f0e8', '#ede7d8', '#8b4513', '#2a1f10'],
    vars: {
      '--bg-primary': '#f5f0e8',
      '--bg-secondary': '#ede7d8',
      '--bg-tertiary': '#e5ddc8',
      '--bg-elevated': '#f8f4ec',
      '--bg-hover': '#ddd5c0',
      '--border': '#c8bea8',
      '--border-subtle': '#e0d8c5',
      '--text-primary': '#2a1f10',
      '--text-secondary': '#5a4830',
      '--text-tertiary': '#9a8868',
      '--accent': '#8b4513',
      '--accent-text': '#ffffff',
      '--accent-dim': '#f0e8d8',
      '--accent-glow': 'rgba(139,69,19,0.12)',
      '--selection-bg': 'rgba(139,69,19,0.25)',
      '--green': '#3a7a3a',
      '--red': '#9a2020',
      '--amber': '#b87820',
    }
  },

  slate_pro: {
    label: 'Slate Pro',
    tone: 'dark',
    description: 'Blue-grey with sky blue — professional and crisp',
    preview: ['#1a1f2e', '#1f2540', '#4a90d9', '#d0d8f0'],
    vars: {
      '--bg-primary': '#1a1f2e',
      '--bg-secondary': '#1f2540',
      '--bg-tertiary': '#252c4a',
      '--bg-elevated': '#2c3455',
      '--bg-hover': '#333d64',
      '--border': '#3a4570',
      '--border-subtle': '#252c4a',
      '--text-primary': '#d0d8f0',
      '--text-secondary': '#90a0c8',
      '--text-tertiary': '#505880',
      '--accent': '#4a90d9',
      '--accent-text': '#ffffff',
      '--accent-dim': '#0a1a30',
      '--accent-glow': 'rgba(74,144,217,0.15)',
      '--green': '#5ab880',
      '--red': '#e86060',
      '--amber': '#dba840',
    }
  },

  monokai: {
    label: 'Monokai',
    tone: 'dark',
    description: 'The classic developer color scheme',
    preview: ['#272822', '#1e1f1a', '#ae81ff', '#f8f8f2'],
    vars: {
      '--bg-primary': '#272822',
      '--bg-secondary': '#1e1f1a',
      '--bg-tertiary': '#2d2e27',
      '--bg-elevated': '#383930',
      '--bg-hover': '#44453c',
      '--border': '#44453c',
      '--border-subtle': '#2d2e27',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#cfcfc2',
      '--text-tertiary': '#75715e',
      '--accent': '#ae81ff',
      '--accent-text': '#ffffff',
      '--accent-dim': '#2a1f45',
      '--accent-glow': 'rgba(174,129,255,0.15)',
      '--green': '#a6e22e',
      '--red': '#f92672',
      '--amber': '#e6db74',
    }
  },

  high_contrast: {
    label: 'High Contrast',
    tone: 'dark',
    description: 'Pure black with vivid yellow — maximum readability',
    preview: ['#000000', '#0a0a0a', '#f5e642', '#ffffff'],
    vars: {
      '--bg-primary': '#000000',
      '--bg-secondary': '#0a0a0a',
      '--bg-tertiary': '#111111',
      '--bg-elevated': '#1a1a1a',
      '--bg-hover': '#222222',
      '--border': '#333333',
      '--border-subtle': '#1a1a1a',
      '--text-primary': '#ffffff',
      '--text-secondary': '#cccccc',
      '--text-tertiary': '#888888',
      '--accent': '#f5e642',
      '--accent-text': '#000000',
      '--accent-dim': '#2a2600',
      '--accent-glow': 'rgba(245,230,66,0.15)',
      '--green': '#00ff00',
      '--red': '#ff4444',
      '--amber': '#ffaa00',
    }
  },

  espresso: {
    label: 'Espresso',
    tone: 'dark',
    description: 'Coffee brown with copper — warm and inviting',
    preview: ['#1a1008', '#221508', '#d4773a', '#f5e8d0'],
    vars: {
      '--bg-primary': '#1a1008',
      '--bg-secondary': '#221508',
      '--bg-tertiary': '#2e1d0d',
      '--bg-elevated': '#3c2714',
      '--bg-hover': '#4a321c',
      '--border': '#5a3d22',
      '--border-subtle': '#2e1d0d',
      '--text-primary': '#f5e8d0',
      '--text-secondary': '#d0b080',
      '--text-tertiary': '#806040',
      '--accent': '#d4773a',
      '--accent-text': '#ffffff',
      '--accent-dim': '#3d1800',
      '--accent-glow': 'rgba(212,119,58,0.15)',
      '--green': '#7aaa6a',
      '--red': '#d45555',
      '--amber': '#e0a040',
    }
  },

  winxp: {
    label: 'Windows XP',
    tone: 'light',
    description: 'Luna blue and silver — early-2000s Windows',
    preview: ['#ece9d8', '#ffffff', '#2a5fd8', '#0a0a0a'],
    vars: {
      '--bg-primary': '#ece9d8',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#f4f2e8',
      '--bg-elevated': '#ffffff',
      '--bg-hover': '#d8e6fb',
      '--border': '#aca899',
      '--border-subtle': '#d4d0c8',
      '--text-primary': '#0a0a0a',
      '--text-secondary': '#48453c',
      '--text-tertiary': '#7c7868',
      '--accent': '#2a5fd8',
      '--accent-text': '#ffffff',
      '--accent-dim': '#cbdcf7',
      '--accent-glow': 'rgba(42,95,216,0.18)',
      '--green': '#2f9e2f',
      '--red': '#d42d2d',
      '--amber': '#e39400',
    }
  },

  win9x: {
    label: 'Windows Classic',
    tone: 'light',
    description: 'Battleship grey and navy — 95/98/2000 chrome',
    preview: ['#c0c0c0', '#ffffff', '#000080', '#000000'],
    vars: {
      '--bg-primary': '#c0c0c0',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#cececa',
      '--bg-elevated': '#c0c0c0',
      '--bg-hover': '#cddaf0',
      '--border': '#808080',
      '--border-subtle': '#dfdfdf',
      '--text-primary': '#000000',
      '--text-secondary': '#3d3d3d',
      '--text-tertiary': '#6e6e6e',
      '--accent': '#000080',
      '--accent-text': '#ffffff',
      '--accent-dim': '#c6d4ec',
      '--accent-glow': 'rgba(0,0,128,0.15)',
      '--green': '#008000',
      '--red': '#a80000',
      '--amber': '#9a6a00',
    }
  },
};

// ── Sender avatar color ───────────────────────────────────────────────────────

const SENDER_PALETTE = [
  '#dc2626', // red
  '#ea580c', // orange
  '#d97706', // amber
  '#65a30d', // lime
  '#16a34a', // green
  '#059669', // emerald
  '#0d9488', // teal
  '#0891b2', // cyan
  '#0284c7', // sky
  '#2563eb', // blue
  '#4f46e5', // indigo
  '#7c3aed', // violet
  '#9333ea', // purple
  '#c026d3', // fuchsia
  '#db2777', // pink
  '#e11d48', // rose
];

function hashIndex(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % SENDER_PALETTE.length;
}

export function senderColor(email) {
  const key = (email || '').toLowerCase().trim();
  return SENDER_PALETTE[key ? hashIndex(key) : 0];
}

// ── Custom CSS injection ───────────────────────────────────────────────────────

const CUSTOM_CSS_ID = 'mailflow-custom-css';

export function applyCustomCss(css) {
  let el = document.getElementById(CUSTOM_CSS_ID);
  if (!css) {
    if (el) el.remove();
    refreshAccentDerived(); // revert favicon/logo if the removed CSS was overriding --accent
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = CUSTOM_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
  refreshAccentDerived(); // flow a custom --accent override through to favicon/logo
}

// ── Light/dark theme defaults ─────────────────────────────────────────────────

// Ink is the default light appearance and Dark ink its dark counterpart. A user
// can pick a different theme for each appearance separately (Settings →
// Appearance → Theme), and the mode decides which one is used: follow the OS
// colour scheme, or force light/dark.
export const DEFAULT_LIGHT_THEME = 'ink';
export const DEFAULT_DARK_THEME = 'dark_ink';
export const THEME_MODES = ['system', 'light', 'dark'];

export const THEME_MODE_STORAGE_KEYS = {
  mode: 'mailflow_theme_mode',
  light: 'mailflow_theme_light',
  dark: 'mailflow_theme_dark',
};

// A theme is either a light or a dark appearance. The metadata lives on the theme
// itself so the two pickers can group themes without a second list to maintain.
export function themeTone(name) {
  return THEMES[name]?.tone === 'light' ? 'light' : 'dark';
}

export function themesByTone(tone) {
  return Object.entries(THEMES).filter(([, theme]) => theme.tone === tone);
}

export function normalizeThemeMode(mode) {
  return THEME_MODES.includes(mode) ? mode : 'system';
}

// matchMedia is guarded so an environment without it (tests, SSR) never throws and
// simply resolves to the light appearance.
export function systemPrefersDark() {
  try {
    return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  } catch { return false; }
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// The stored default light/dark themes plus the mode. A legacy single `theme`
// choice (stored before separate defaults existed) becomes an explicit mode for
// its own tone, so an upgrade never silently changes someone's appearance.
export function readThemePrefs() {
  const storedMode = readStored(THEME_MODE_STORAGE_KEYS.mode);
  if (storedMode) {
    const storedLight = readStored(THEME_MODE_STORAGE_KEYS.light);
    const storedDark = readStored(THEME_MODE_STORAGE_KEYS.dark);
    return {
      mode: normalizeThemeMode(storedMode),
      light: THEMES[storedLight] ? storedLight : DEFAULT_LIGHT_THEME,
      dark: THEMES[storedDark] ? storedDark : DEFAULT_DARK_THEME,
    };
  }
  const legacy = readStored('mailflow_theme');
  if (legacy && THEMES[legacy]) {
    return themeTone(legacy) === 'light'
      ? { mode: 'light', light: legacy, dark: DEFAULT_DARK_THEME }
      : { mode: 'dark', light: DEFAULT_LIGHT_THEME, dark: legacy };
  }
  return { mode: 'system', light: DEFAULT_LIGHT_THEME, dark: DEFAULT_DARK_THEME };
}

// The theme that should render for a set of preferences: light/dark is forced by
// the mode, while `system` follows the operating system colour scheme.
export function resolveTheme(prefs = readThemePrefs()) {
  const light = THEMES[prefs?.light] ? prefs.light : DEFAULT_LIGHT_THEME;
  const dark = THEMES[prefs?.dark] ? prefs.dark : DEFAULT_DARK_THEME;
  const mode = normalizeThemeMode(prefs?.mode);
  if (mode === 'light') return light;
  if (mode === 'dark') return dark;
  return systemPrefersDark() ? dark : light;
}

// The theme to use before any stored/server preference is known — i.e. on the
// login screen and the very first visit: the configured light default when the OS
// is light, the configured dark default when it prefers dark.
export function getInitialTheme() {
  return resolveTheme();
}

// ── Theme application ─────────────────────────────────────────────────────────

// The favicon follows the same vector master and effective accent as the app.
export function buildFaviconSvg(accent) {
  return `data:image/svg+xml,${encodeURIComponent(brandSvg(accent))}`;
}

// ── Effective accent (theme value, or a custom-CSS override of --accent) ───────

// The accent actually in effect. A custom-CSS override of --accent wins over the
// theme's declared value, so JS-driven chrome (favicon, PWA theme-color, the logo
// mark) reads the *computed* value to match what var(--accent) resolves to in CSS.
export function getEffectiveAccent(fallback = '#7c6af7') {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return v || fallback;
  } catch { return fallback; }
}

// Subscribers (e.g. the logo mark) notified when the effective accent changes, so
// they update on a custom-CSS accent override too — not only on a theme switch.
const _accentListeners = new Set();
export function subscribeAccent(fn) {
  _accentListeners.add(fn);
  return () => { _accentListeners.delete(fn); };
}

// ── Mail body surface ─────────────────────────────────────────────────────────

// HTML mail renders inside a sandboxed iframe — a separate document that cannot see
// the app's CSS custom properties, and whose own user-agent defaults follow the
// *operating system* rather than the app theme. Unstyled bodies therefore inherited
// black text, which on a dark theme landed on the dark panel — black on dark.
//
// The frame is given the surface explicitly instead, from the same tokens the
// surrounding panel uses, so the default text colour always matches the surface it
// actually sits on. Values are read from the *computed* root style, so a custom-CSS
// override of --message-body-bg or --text-primary flows through, exactly like
// getEffectiveAccent().
//
// Anything that is not a plain CSS colour is discarded before it reaches the frame's
// stylesheet, so a hand-written custom CSS value can never break out of the rule.
const CSS_COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.%,\s/]+\)|hsla?\(\s*[\d.%,\s/deg]+\)|[a-z]{3,20})$/i;

function safeColor(value, fallback) {
  const candidate = String(value ?? '').trim();
  return CSS_COLOR_RE.test(candidate) ? candidate : fallback;
}

function effectiveToken(name, fallback) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch { return fallback; }
}

// The surface for the mail/description iframe of the given theme. `tone` lets the
// frame declare its colour scheme, and the two colours are the panel background and
// its default text colour.
export function getEmailSurface(themeName) {
  const name = THEMES[themeName] ? themeName : DEFAULT_LIGHT_THEME;
  const vars = THEMES[name].vars;
  return {
    tone: themeTone(name),
    background: safeColor(
      typeof document === 'undefined' ? null : effectiveToken('--message-body-bg', vars['--bg-secondary']),
      vars['--bg-secondary'],
    ),
    foreground: safeColor(
      typeof document === 'undefined' ? null : effectiveToken('--text-primary', vars['--text-primary']),
      vars['--text-primary'],
    ),
  };
}

function refreshBrandSurface() {
  const probe = document.createElement('span');
  probe.style.color = 'var(--bg-primary)';
  probe.style.display = 'none';
  document.documentElement.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  const channels = [...rgb.matchAll(/\d+(?:\.\d+)?/g)]
    .slice(0, 3)
    .map(match => Number(match[0]) / 255);
  if (channels.length !== 3) return;

  const luminance = channels.reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  document.documentElement.setAttribute('data-inboxora-surface', luminance > 0.45 ? 'light' : 'dark');
}

// Recompute everything derived from the effective appearance (PWA theme-color
// and UI logo). Called after both applyTheme and applyCustomCss so custom
// overrides are reflected too.
function refreshAccentDerived() {
  refreshBrandSurface();
  const accent = getEffectiveAccent();
  if (!accent.startsWith('#')) return; // PWA theme-color expects a hex colour
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accent);
  // Swap the pre-JS PNG favicon for the accent-tinted IO monogram.
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon) {
    favicon.setAttribute('type', 'image/svg+xml');
    favicon.setAttribute('href', buildFaviconSvg(accent));
  }
  _accentListeners.forEach(fn => {
    try { fn(accent); } catch { /* a listener error must not break theming */ }
  });
}

export function applyTheme(themeName) {
  const theme = THEMES[themeName] || THEMES.dark;

  // Expose the active theme as an attribute so a theme can layer scoped skeuomorphic
  // chrome (beveled scrollbars, selection tint) via CSS in index.css without adding
  // structural tokens to every palette. Retro themes (winxp/win9x) use this.
  document.documentElement.setAttribute('data-mailflow-theme', THEMES[themeName] ? themeName : 'dark');

  // Inject vars via a <style> element rather than root.style.setProperty so
  // that <style id="mailflow-custom-css"> (appended afterward) can override
  // theme variables at equal specificity using normal cascade source order.
  let themeEl = document.getElementById('mailflow-theme');
  if (!themeEl) {
    themeEl = document.createElement('style');
    themeEl.id = 'mailflow-theme';
    document.head.appendChild(themeEl);
  }
  themeEl.textContent = `:root {\n${
    Object.entries(theme.vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')
  }\n}`;

  // Recompute PWA theme-color + logo from the *effective* accent. If a
  // custom-CSS override of --accent is present, getComputedStyle picks it up here;
  // applyCustomCss also re-runs this so an override applied afterwards is reflected.
  refreshAccentDerived();
}
