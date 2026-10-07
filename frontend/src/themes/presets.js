// Palette adaptations for EasyPaper. See public/theme-licenses for upstream notices.
const rows = [
  ['easypaper-light','EasyPaper Light','light','#f8fafc','#ffffff','#f1f5f9','#0f172a','#475569','#2563eb','easypaper'],
  ['easypaper-dark','EasyPaper Dark','dark','#06050a','#0d0b16','#171426','#f3f4f6','#a1a1aa','#2563eb','easypaper'],
  ['catppuccin-latte','Catppuccin Latte','light','#eff1f5','#e6e9ef','#dce0e8','#4c4f69','#6c6f85','#8839ef','catppuccin'],
  ['catppuccin-mocha','Catppuccin Mocha','dark','#1e1e2e','#181825','#313244','#cdd6f4','#a6adc8','#cba6f7','catppuccin'],
  ['one-light','One Light','light','#fafafa','#f0f0f0','#e5e5e6','#383a42','#696c77','#4078f2','one'],
  ['one-dark','One Dark','dark','#282c34','#21252b','#2c313a','#abb2bf','#828997','#61afef','one'],
  ['github-light','GitHub Light','light','#ffffff','#f6f8fa','#eaeef2','#24292f','#57606a','#0969da','github'],
  ['github-dark','GitHub Dark','dark','#0d1117','#161b22','#21262d','#c9d1d9','#8b949e','#58a6ff','github'],
  ['catppuccin-frappe','Catppuccin Frappé','dark','#303446','#292c3c','#414559','#c6d0f5','#a5adce','#ca9ee6','catppuccin'],
  ['catppuccin-macchiato','Catppuccin Macchiato','dark','#24273a','#1e2030','#363a4f','#cad3f5','#a5adcb','#c6a0f6','catppuccin'],
  ['dracula','Dracula','dark','#282a36','#21222c','#44475a','#f8f8f2','#b5b9d4','#bd93f9','dracula'],
  ['nord','Nord','dark','#2e3440','#3b4252','#434c5e','#eceff4','#d8dee9','#88c0d0','nord'],
  ['tokyo-night','Tokyo Night','dark','#1a1b26','#16161e','#292e42','#c0caf5','#a9b1d6','#7aa2f7','tokyo'],
  ['tokyo-storm','Tokyo Night Storm','dark','#24283b','#1f2335','#343b58','#c0caf5','#a9b1d6','#7aa2f7','tokyo'],
  ['tokyo-day','Tokyo Night Day','light','#e1e2e7','#d5d6db','#c4c8da','#3760bf','#6172b0','#2e7de9','tokyo'],
  ['rose-pine','Rosé Pine','dark','#191724','#1f1d2e','#26233a','#e0def4','#908caa','#c4a7e7','rose'],
  ['rose-moon','Rosé Pine Moon','dark','#232136','#2a273f','#393552','#e0def4','#908caa','#c4a7e7','rose'],
  ['rose-dawn','Rosé Pine Dawn','light','#faf4ed','#fffaf3','#f2e9e1','#575279','#797593','#907aa9','rose'],
  ['gruvbox-dark','Gruvbox Dark','dark','#282828','#1d2021','#3c3836','#ebdbb2','#bdae93','#d79921','gruvbox'],
  ['gruvbox-light','Gruvbox Light','light','#fbf1c7','#f9f5d7','#ebdbb2','#3c3836','#665c54','#af3a03','gruvbox'],
  ['solarized-dark','Solarized Dark','dark','#002b36','#073642','#16414b','#93a1a1','#839496','#268bd2','solarized'],
  ['solarized-light','Solarized Light','light','#fdf6e3','#eee8d5','#e6dfca','#586e75','#657b83','#268bd2','solarized'],
  ['ayu-dark','Ayu Dark','dark','#0b0e14','#0f131a','#1b2432','#bfbdb6','#969aab','#e6b450','ayu'],
  ['ayu-mirage','Ayu Mirage','dark','#1f2430','#242936','#343f4c','#cbccc6','#a2aab7','#ffcc66','ayu'],
  ['ayu-light','Ayu Light','light','#fafafa','#f3f4f5','#e7e8e9','#575f66','#787b80','#b86e00','ayu'],
  ['night-owl','Night Owl','dark','#011627','#01111d','#1d3b53','#d6deeb','#a7b7c9','#82aaff','owl'],
  ['light-owl','Light Owl','light','#fbfbfb','#f0f0f0','#e0e0e0','#403f53','#5f6874','#4876d6','owl'],
  ['everforest-dark','Everforest Dark','dark','#2d353b','#272e33','#343f44','#d3c6aa','#9da9a0','#a7c080','everforest'],
  ['everforest-light','Everforest Light','light','#fdf6e3','#f4f0d9','#efebd4','#5c6a72','#708089','#697d2f','everforest'],
  ['monokai','Monokai','dark','#272822','#1e1f1c','#3e3d32','#f8f8f2','#cfcfc2','#a6e22e','vscode'],
  ['vscode-dark','VS Code Dark+','dark','#1e1e1e','#252526','#333333','#d4d4d4','#a6a6a6','#007acc','vscode'],
  ['vscode-light','VS Code Light+','light','#ffffff','#f3f3f3','#e8e8e8','#333333','#616161','#007acc','vscode'],
]
export const THEME_SOURCES = {
  easypaper: 'https://github.com/orion-gz/EasyPaper',
  catppuccin: 'https://github.com/catppuccin/palette',
  one: 'https://github.com/atom/one-dark-syntax',
  github: 'https://github.com/primer/github-vscode-theme',
  dracula: 'https://github.com/dracula/visual-studio-code',
  nord: 'https://github.com/nordtheme/visual-studio-code',
  tokyo: 'https://github.com/enkia/tokyo-night-vscode-theme',
  rose: 'https://github.com/rose-pine/vscode',
  gruvbox: 'https://github.com/jdinhlife/vscode-theme-gruvbox',
  solarized: 'https://github.com/altercation/solarized',
  ayu: 'https://github.com/ayu-theme/vscode-ayu',
  owl: 'https://github.com/sdras/night-owl-vscode-theme',
  everforest: 'https://github.com/sainnhe/everforest-vscode',
  vscode: 'https://github.com/microsoft/vscode',
}
// Semantic adaptations: upstream diagnostic/ANSI colors and editor selection colors.
// Provenance and mapping policy: docs/custom-themes.md.
const semanticColors = {
  'catppuccin-latte': ['#40a02b', '#df8e1d', '#d20f39', '#1e66f5', '#acb0be'],
  'catppuccin-mocha': ['#a6e3a1', '#f9e2af', '#f38ba8', '#89b4fa', '#585b70'],
  'catppuccin-frappe': ['#a6d189', '#e5c890', '#e78284', '#8caaee', '#626880'],
  'catppuccin-macchiato': ['#a6da95', '#eed49f', '#ed8796', '#8aadf4', '#5b6078'],
  'one-dark': ['#98c379', '#e5c07b', '#e06c75', '#61afef', '#3e4451'],
  'one-light': ['#50a14f', '#c18401', '#e45649', '#4078f2', '#e5e5e6'],
  'nord': ['#a3be8c', '#ebcb8b', '#bf616a', '#81a1c1', '#434c5ecc'],
  'tokyo-night': ['#41a6b5', '#e0af68', '#db4b4b', '#0da0ba', '#515c7e4d'],
  'tokyo-storm': ['#73daca', '#e0af68', '#db4b4b', '#0da0ba', '#6f7bb640'],
  'tokyo-day': ['#33635c', '#8f5e15', '#bd4040', '#0da0ba', '#acb0bf40'],
  'rose-pine': ['#31748f', '#f6c177', '#eb6f92', '#9ccfd8', '#6e6a8633'],
  'rose-moon': ['#3e8fb0', '#f6c177', '#eb6f92', '#9ccfd8', '#817c9c26'],
  'rose-dawn': ['#286983', '#ea9d34', '#b4637a', '#56949f', '#6e6a8614'],
  'everforest-dark': ['#a7c080', '#bf983d', '#da6362', '#5a93a2', '#475258c0'],
  'everforest-light': ['#8da101', '#e4b649', '#f1706f', '#6cb3c6', '#e6e2cca0'],
  'night-owl': ['#22da6e', '#b39554', '#ef5350', '#82aaff', '#1d3b53'],
  'light-owl': ['#08916a', '#daaa01', '#e64d49', '#288ed7', '#e0e0e0'],
  'monokai': ['#86b42b', '#b3b42b', '#c4265e', '#6a7ec8', '#878b9180'],
  'solarized-dark': ['#859900', '#b58900', '#dc322f', '#268bd2', '#274642'],
  'solarized-light': ['#859900', '#b58900', '#dc322f', '#268bd2', '#eee8d5'],
  'dracula': ['#50fa7b', '#f1fa8c', '#ff5555', '#8be9fd', '#44475a'],
  'github-dark': ['#85e89d', '#ffea7f', '#f97583', '#79b8ff', '#032f62'],
  'github-light': ['#22863a', '#f9c513', '#cb2431', '#005cc5', '#dbedff'],
  'gruvbox-dark': ['#98971a', '#d79921', '#cc241d', '#458588', '#504945'],
  'gruvbox-light': ['#98971a', '#d79921', '#cc241d', '#458588', '#d5c4a1'],
  'ayu-dark': ['#aad94c', '#ffb454', '#f07178', '#59c2ff', '#3388ff40'],
  'ayu-mirage': ['#d5ff80', '#ffcd66', '#f28779', '#73d0ff', '#409fff40'],
  'ayu-light': ['#86b300', '#eba400', '#f07171', '#22a4e6', '#035bd626'],
  'vscode-dark': ['#73c991', '#cca700', '#f48771', '#3794ff', '#264f78'],
  'vscode-light': ['#16825d', '#bf8803', '#a1260d', '#006ab1', '#add6ff'],
}
export const PRESETS = rows.map(([id, name, scheme, base, surface, elevated, text, secondary, accent, source]) => {
  const semantic = semanticColors[id]
  const colors = { base, surface, elevated, text, secondary, accent }
  if (semantic) {
    const [success, warning, error, info, selection] = semantic
    Object.assign(colors, { success, warning, error, info, selection })
  }
  return Object.freeze({ id, name, scheme, source: THEME_SOURCES[source], license: `/theme-licenses/${source}.txt`, colors: Object.freeze(colors) })
})
