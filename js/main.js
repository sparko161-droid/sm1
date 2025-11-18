import { Theme } from './core/theme.js';
import { Router } from './core/router.js';
import { Utils } from './core/utils.js';
import { QuizEngine } from './modules/quiz/engine.js';

export class App {
  static async init() {
    Theme.init('#themeToggle');
    Router.init('#content');
    const content = document.querySelector('#content');
    if (content) {
      const section = content.dataset.section || 'home';
      await Utils.autoInitPage(section, content);
    }
  }
}
document.addEventListener('DOMContentLoaded', () => App.init());
