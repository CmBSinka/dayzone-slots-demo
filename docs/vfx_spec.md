# VFX Effect for Casino Icon (React + PixiJS)

## Задача
Нужно реализовать **высококачественный VFX эффект** для иконки (огненный шар) в веб-интерфейсе казино (slot UI).

Цель:
- Сделать эффект **дорогим визуально**
- Не просто CSS glow, а **реальный GPU VFX**
- Эффект должен выглядеть как в слотах (Stake / Pragmatic / Hacksaw)

---

##  Основная идея

Не использовать DOM/CSS для эффектов.

Вместо этого:
 Рендерить иконку через **PixiJS (WebGL)**  
Применять **post-processing filters**  
 Анимировать через **GSAP**

PixiJS использует GPU и позволяет применять фильтры и шейдеры к объектам сцены :contentReference[oaicite:0]{index=0}

---

##  Технологический стек

Обязательно использовать:

- pixi.js
- @pixi/react
- pixi-filters
- gsap

```bash
npm install pixi.js @pixi/react pixi-filters gsap