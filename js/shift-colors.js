// shift-colors.js
// Система динамического назначения цветов для шаблонов смен

/**
 * Генерирует цвет на основе индекса с использованием золотого сечения
 * для лучшего распределения цветов по спектру
 */
function generateColorForIndex(index, saturation = 65, lightness = 55, isDark = false) {
  const goldenRatioConjugate = 0.618033988749895;
  const hue = (index * goldenRatioConjugate * 360) % 360;
  
  // Корректируем насыщенность и яркость для тёмной темы
  if (isDark) {
    saturation = Math.min(saturation + 10, 75);
    lightness = Math.min(lightness + 5, 65);
  }
  
  return {
    hue: Math.round(hue),
    saturation,
    lightness
  };
}

/**
 * Создаёт CSS-переменные для фона и границы на основе HSL
 */
function createCSSVariablesForColor(hsl, isDark = false) {
  const bgOpacity = isDark ? 0.15 : 0.12;
  const borderOpacity = isDark ? 0.5 : 0.45;
  
  return {
    bg: `hsla(${hsl.hue}, ${hsl.saturation}%, ${hsl.lightness}%, ${bgOpacity})`,
    border: `hsla(${hsl.hue}, ${hsl.saturation}%, ${hsl.lightness}%, ${borderOpacity})`
  };
}

/**
 * Инициализирует цвета для всех шаблонов смен
 * Генерирует и внедряет CSS-переменные динамически
 */
function initializeShiftColors(shiftTemplatesByLine, isDarkTheme = false) {
  const styleId = 'dynamic-shift-colors';
  let styleEl = document.getElementById(styleId);
  
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  
  let cssRules = [];
  
  // Обрабатываем шаблоны для каждой линии
  ['L1', 'L2'].forEach(line => {
    const templates = shiftTemplatesByLine[line] || [];
    const linePrefix = line.toLowerCase();
    
    templates.forEach((template, index) => {
      // Пропускаем специальные смены (ВЫХ, ОТП, ДР) - у них свой цвет
      if (template.specialShortLabel) {
        return;
      }
      
      const templateId = template.id;
      const colorHSL = generateColorForIndex(index, 65, 55, isDarkTheme);
      const cssVars = createCSSVariablesForColor(colorHSL, isDarkTheme);
      
      // Генерируем CSS-класс для этого шаблона
      const className = `.shift-pill.shift-template-${linePrefix}-${templateId}`;
      
      cssRules.push(`
${className} {
  background: ${cssVars.bg};
  border-color: ${cssVars.border};
}`
      );
    });
  });
  
  styleEl.textContent = cssRules.join('\n');
}

/**
 * Получает CSS-класс для шаблона смены
 */
function getShiftTemplateClass(line, templateId) {
  if (!line || !templateId) return '';
  return `shift-template-${line.toLowerCase()}-${templateId}`;
}

/**
 * Обновляет цвета при переключении темы
 */
function updateShiftColorsForTheme(shiftTemplatesByLine, isDarkTheme) {
  initializeShiftColors(shiftTemplatesByLine, isDarkTheme);
}

// Экспортируем функции
if (typeof window !== 'undefined') {
  window.ShiftColors = {
    initialize: initializeShiftColors,
    getTemplateClass: getShiftTemplateClass,
    updateForTheme: updateShiftColorsForTheme
  };
}