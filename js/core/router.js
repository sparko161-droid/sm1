import { Utils } from './utils.js';

export class Router {
  static init(containerSelector = '#content') {
    this.container = document.querySelector(containerSelector);
    this.navLinks = Array.from(document.querySelectorAll('.nav-link'));
    window.addEventListener('hashchange', () => this.handleRoute());
    this.handleRoute();
  }
  static handleRoute() {
    const section = location.hash.replace('#', '') || 'home';
    this.container.classList.add('fade-out');
    setTimeout(() => {
      this.updateActive(section);
      this.container.dataset.section = section;
      Utils.autoInitPage(section, this.container);
      this.container.classList.remove('fade-out');
      this.container.classList.add('fade-in');
      setTimeout(() => this.container.classList.remove('fade-in'), 400);
    }, 300);
  }
  static updateActive(section) {
    this.navLinks.forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.section === section)
    );
  }
}
