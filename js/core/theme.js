const THEME_KEY = 'portal-theme';

export class Theme {
  static init(buttonSelector = '#themeToggle') {
    this.body = document.body;
    this.toggleBtn = document.querySelector(buttonSelector);
    const savedTheme = localStorage.getItem(THEME_KEY);
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = savedTheme || (systemDark ? 'dark' : 'light');
    this.apply(theme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(THEME_KEY)) {
        this.apply(e.matches ? 'dark' : 'light');
      }
    });
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => {
        const current = this.body.dataset.theme || 'light';
        const next = current === 'light' ? 'dark' : 'light';
        this.apply(next, true);
      });
    }
  }
  static apply(theme, save = false) {
    this.body.dataset.theme = theme;
    this.body.classList.remove('dark-theme', 'light-theme');
    this.body.classList.add(`${theme}-theme`);
    if (save) localStorage.setItem(THEME_KEY, theme);
  }
}
