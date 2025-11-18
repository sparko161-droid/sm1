export class Utils {
  static async autoInitPage(section, container) {
    try {
      const modulePath = `../modules/${section}/pages/main.js`;
      const module = await import(modulePath);
      if (module?.default?.init) module.default.init(container);
    } catch (err) {
      console.warn(`Utils.autoInitPage: no module for section "${section}"`, err);
    }
  }
}
