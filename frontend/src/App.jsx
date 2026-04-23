import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Application, extend, useTick } from "@pixi/react";
import { Container, Graphics } from "pixi.js";
import "./styles/main.css";

/*
 * Общая архитектура файла:
 * - В верхней части лежат все исходные данные игры: список символов, таблицы выплат,
 *   веса выпадения, лимиты по RTP и тексты интерфейса.
 * - Ниже идут чистые функции без React-состояния: они генерируют поле, считают выигрыш,
 *   моделируют каскады и отсеивают слишком сильные или слишком частые исходы.
 * - Дальше находятся презентационные компоненты: панели, сетка, модалки, Pixi-оверлеи.
 * - В самом низу расположен `App`, который оркестрирует весь жизненный цикл спина.
 *
 * Полный цикл одного спина выглядит так:
 * 1. Интерфейс переводится в состояние прокрутки, а колонки получают CSS-анимацию "reel spin".
 * 2. Генерируется кандидатное поле, которое проходит проверки на допустимую волатильность.
 * 3. Поле показывается игроку и проходит короткую фазу "посадки" после вращения.
 * 4. Игра проверяет scatter, обычные выигрыши и бонусную механику sticky-scatter в free spins.
 * 5. Выигрыш удерживается на экране достаточно долго, чтобы игрок успел его считать глазами.
 * 6. Затем запускаются анимации уничтожения символов и физика каскадного падения.
 * 7. Поле дозаполняется сверху, после чего цикл повторяется, пока не останется новых выигрышей.
 */

// Регистрируем Pixi-объекты один раз, чтобы их можно было использовать в React-дереве.
extend({ Container, Graphics });

// Базовый список символов, используемый генератором поля и таблицей выплат.
const SYMBOLS = [
  "Conserva",
  "Energy",
  "Vodka",
  "Tushkan",
  "Flash",
  "Stalker",
  "Bandit",
  "Plate",
  "Artefact",
  "scatter",
];

// Веса символов для обычной игры: чем больше число, тем чаще символ может появиться.
const BASE_SYMBOL_WEIGHTS = {
  Conserva: 17,
  Energy: 15,
  Vodka: 13,
  Tushkan: 11,
  Flash: 9,
  Stalker: 8,
  Bandit: 7,
  Plate: 4,
  Artefact: 3,
  scatter: 2,
};

// В бесплатных спинах используется отдельная таблица весов, чтобы бонус ощущался иначе, чем база.
const FREE_SPINS_SYMBOL_WEIGHTS = {
  Conserva: 2,
  Energy: 17,
  Vodka: 14,
  Tushkan: 12,
  Flash: 10.5,
  Stalker: 9,
  Bandit: 7.5,
  Plate: 5,
  Artefact: 4,
  scatter: 1,
};

const SYMBOL_IMAGE_MAP = {
  Conserva: "/1.png",
  Stalker: "/2.png",
  Artefact: "/3.png",
  Plate: "/4.png",
  Bandit: "/5.png",
  Flash: "/6.png",
  Tushkan: "/7.png",
  scatter: "/8.png",
  Vodka: "/11.png",
  Energy: "/12.png",
};

// Таблица выплат для механики pay-anywhere по количеству одинаковых символов на всём поле.
const PAYOUTS = {
  Conserva: { 6: 75, 8: 200, 10: 500 },
  Energy: { 6: 120, 8: 260, 10: 1000 },
  Vodka: { 6: 150, 8: 320, 10: 1200 },
  Tushkan: { 6: 220, 8: 360, 10: 2000 },
  Flash: { 6: 280, 8: 420, 10: 2600 },
  Stalker: { 6: 420, 8: 600, 10: 3200 },
  Bandit: { 6: 650, 8: 1500, 10: 4500 },
  Plate: { 6: 900, 8: 3000, 10: 7000 },
  Artefact: { 6: 3000, 8: 7500, 10: 15000 },
  scatter: { 6: 0, 8: 0, 10: 0 },
};

const PAYTABLE_SYMBOL_ORDER = [
  "Conserva",
  "Energy",
  "Vodka",
  "Tushkan",
  "Flash",
  "Stalker",
  "Bandit",
  "Plate",
  "Artefact",
];

const SCATTER_QUOTES = [
  "/Sounds/Scatter_quote_1.mp3",
  "/Sounds/Scatter_quote_2.mp3",
  "/Sounds/Scatter_quote_3.mp3",
];
const SCATTER_WIN_QUOTES = [
  "/Sounds/Scatter_win_quote_1.mp3",
  "/Sounds/Scatter_win_quote_2.mp3",
  "/Sounds/Scatter_win_quote_3.mp3",
];
const SCATTER_LOSE_QUOTE = "/Sounds/Scatter_lose_quote.mp3";
const VODKA_QUOTES = ["/Sounds/vodka_quote_1.mp3", "/Sounds/vodka_quote_2.mp3"];
const ANOMALY_QUOTE = "/Sounds/anomaly_quote.mp3";
const SYMBOL_REMOVAL_QUOTE_CHANCE = 0.25;

const SCATTER_PAYOUTS = {
  3: 400,
  4: 1000,
  5: 5000,
  6: 20000,
};

/*
 * Здесь сосредоточены настраиваемые константы математики и темпа игры.
 *
 * Главные группы параметров:
 * - экономика бонуса: FREE_SPINS_START, FREE_SPINS_RETRIGGER, BUY_FREE_SPINS_MULTIPLIER
 * - контроль волатильности: SOFT_MAX_WIN_MULTIPLIER, MAX_WIN_MULTIPLIER, лимиты по каскадам
 * - управление RTP: RTP_TARGET и мягкие/жёсткие диапазоны отклонения
 * - глубина подбора поля: MAX_SPIN_ATTEMPTS и MAX_REFILL_ATTEMPTS
 *
 * Важно по таймингам:
 * асинхронные `wait(...)` ниже специально подогнаны под длительности анимаций из `main.css`.
 * Если меняются времена вращения, удаления, падения или бонусной сцены, менять нужно обе стороны.
 */
const INITIAL_BALANCE = 100000;
const BASE_BET_AMOUNT = 200;
const FREE_SPINS_START = 7;
const FREE_SPINS_RETRIGGER = 5;
const CONSERVA_COLLECTION_BASE_REWARD = 1000;
const SIDOROVICH_LIFETIME = 1;
const BONUS_INTERNAL_CASCADE_LIMIT = 12;
const BUY_FREE_SPINS_MULTIPLIER = 50;
const ANTE_BET_MULTIPLIER = 1.25;
const ANTE_SCATTER_WEIGHT_MULTIPLIER = 2;
const BOUGHT_BONUS_FOUR_SCATTER_CHANCE = 0.18;
const BOUGHT_BONUS_FIVE_SCATTER_CHANCE = 0.04;
const MAX_SPIN_ATTEMPTS = 10;
const RTP_TARGET = 0.945;
const RTP_SOFT_BAND = 0.08;
const RTP_HARD_BAND = 0.16;
const SOFT_MAX_WIN_MULTIPLIER = 1.35;
const MAX_WIN_MULTIPLIER = 100;
const SOFT_MAX_CASCADES = 3;
const HARD_MAX_CASCADES = 5;
const MAX_REFILL_ATTEMPTS = 24;
const FORCE_BANDIT_WIN_ON_EVERY_SPIN_FOR_TESTING = false;

const BET_VALUES = [500, 1000, 2000, 3000, 4000, 5000, 10000];
const AUTOSPIN_COUNT = 10;
const BASE_VIEWPORT_WIDTH = 1920;
const BASE_VIEWPORT_HEIGHT = 1080;

const UI_TEXT = {
  player: "Игрок",
  playerName: "Игрок",
  balance: "Баланс",
  betPerLine: "Ставка",
  totalBet: "Общая ставка",
  lastWin: "Последний выигрыш",
  paytable: "Таблица выплат",
  banner: "Символы оплачиваются в любом месте на экране",
  mode: "В процессе разработки (БЕТА)",
  turbo: "Турбо",
  autoplay: "Автоигра",
  buyFreeSpins: "Купить бесплатные спины",
  freeSpinsLabel: "Бесплатные спины",
  anteBetTitle: "Ставка",
  anteBetDescription: "Двойной шанс на бонус",
  menu: "Меню",
  musicVolume: "Громкость музыки",
  resetSession: "Сбросить сессию",
  close: "Закрыть",
  ready: "Готов к игре",
  spinning: "Прокрутка...",
  turboSpinning: "Турбо прокрутка...",
  freeSpinSpinning: "Бесплатные спины",
  noWin: "Без выигрыша",
  insufficient: "Недостаточно баланса",
  fullscreenError: "Полноэкранный режим недоступен",
  sessionReset: "Сессия сброшена",
  autospinStarted: "Автоигра запущена",
  autospinStopped: "Автоигра остановлена",
  freeSpinsStarted: "Бесплатные спины запущены",
  freeSpinsBought: "Бесплатные спины куплены",
  freeSpinsFinished: "Бесплатные спины завершены",
  boughtBonusSpinning: "Покупка бесплатных спинов...",
  bonusTitle: "ПОЗДРАВЛЯЕМ",
  bonusIntroText: "Вы получили",
  bonusSummaryText: "Вы выиграли",
  bonusIntroFooter: "Бесплатных спинов",
  bonusSummaryFooter: "За бонусную игру",
  bonusContinue: "Нажмите, чтобы продолжить",
};

// Выбираем, какая таблица весов должна использоваться в текущем игровом режиме.
function getSpinWeights(isFreeSpins = false, anteBetActive = false) {
  if (isFreeSpins) {
    return FREE_SPINS_SYMBOL_WEIGHTS;
  }

  if (!anteBetActive) {
    return BASE_SYMBOL_WEIGHTS;
  }

  return {
    ...BASE_SYMBOL_WEIGHTS,
    scatter: BASE_SYMBOL_WEIGHTS.scatter * ANTE_SCATTER_WEIGHT_MULTIPLIER,
  };
}

// Символ scatter в одной колонке допускается только один, поэтому иногда нужна таблица весов без scatter.
function getNonScatterWeights(isFreeSpins = false) {
  const sourceWeights = isFreeSpins ? FREE_SPINS_SYMBOL_WEIGHTS : BASE_SYMBOL_WEIGHTS;

  return {
    ...sourceWeights,
    scatter: 0,
  };
}

function removeScatterWeight(weights) {
  return {
    ...weights,
    scatter: 0,
  };
}

// Генерируем одну колонку так, чтобы внутри неё не появлялось больше одного scatter.
function generateColumn(length, weights, existingSymbols = []) {
  const column = [...existingSymbols];
  let hasScatter = column.includes("scatter");
  const nonScatterWeights = removeScatterWeight(weights);

  while (column.length < length) {
    const nextSymbol = hasScatter
      ? randomSymbolForWeights(nonScatterWeights)
      : randomSymbolForWeights(weights);

    if (nextSymbol === "scatter") {
      hasScatter = true;
    }

    column.push(nextSymbol);
  }

  return column;
}

// Общий helper для случайного выбора символа по весам в базе и при дозаполнении каскадов.
function randomSymbolForWeights(weights) {
  const symbols = Object.keys(weights);
  const totalWeight = symbols.reduce((sum, symbol) => sum + (weights[symbol] || 0), 0);
  let roll = Math.random() * totalWeight;

  for (const symbol of symbols) {
    roll -= weights[symbol] || 0;
    if (roll <= 0) {
      return symbol;
    }
  }

  return symbols[symbols.length - 1];
}

function generateGrid(isFreeSpins = false, anteBetActive = false) {
  const weights = getSpinWeights(isFreeSpins, anteBetActive);

  return Array.from({ length: 5 }, () => generateColumn(5, weights));
}

// Служебная функция для тестов и отладки: принудительно создаёт гарантированный выигрышный расклад.
function forceWinningSymbolGrid(grid, symbol, count = 6) {
  const forcedGrid = grid.map((column) => [...column]);
  const positions = [];

  for (let rowIndex = 0; rowIndex < 5; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < 5; columnIndex += 1) {
      positions.push([columnIndex, rowIndex]);
    }
  }

  for (let index = 0; index < Math.min(count, positions.length); index += 1) {
    const [columnIndex, rowIndex] = positions[index];
    forcedGrid[columnIndex][rowIndex] = symbol;
  }

  return forcedGrid;
}

function getBoughtBonusScatterCount() {
  const roll = Math.random();

  if (roll < BOUGHT_BONUS_FIVE_SCATTER_CHANCE) {
    return 5;
  }

  if (roll < BOUGHT_BONUS_FIVE_SCATTER_CHANCE + BOUGHT_BONUS_FOUR_SCATTER_CHANCE) {
    return 4;
  }

  return 3;
}

function generateBoughtBonusGrid() {
  /*
   * Генерация купленного бонуса строже, чем генерация обычного спина:
   * - сначала создаётся поле без естественных scatter,
   * - затем вручную добавляются 3/4/5 scatter по заданным шансам,
   * - после этого отбрасываются поля, где одновременно возникал бы обычный выигрыш.
   *
   * Это нужно для "чистой" бонусной сцены на входе:
   * игрок должен увидеть понятный триггер бонуса, а не смешанный исход
   * вида "scatter + обычный выигрыш + каскад" в один и тот же кадр.
   */
  const weights = getNonScatterWeights(false);
  let fallbackGrid = Array.from({ length: 5 }, () => generateColumn(5, weights));

  for (let attempt = 0; attempt < MAX_SPIN_ATTEMPTS * 2; attempt += 1) {
    const grid = Array.from({ length: 5 }, () => generateColumn(5, weights));
    const scatterCount = getBoughtBonusScatterCount();
    const columns = Array.from({ length: 5 }, (_, index) => index).sort(() => Math.random() - 0.5);

    for (let index = 0; index < scatterCount; index += 1) {
      const columnIndex = columns[index];
      const rowIndex = Math.floor(Math.random() * 5);
      grid[columnIndex][rowIndex] = "scatter";
    }

    fallbackGrid = grid;

    if (!hasRegularWinsAlongsideScatter(evaluateGridWin(grid, BASE_BET_AMOUNT))) {
      return grid;
    }
  }

  return fallbackGrid;
}

function getSymbolLabel(type) {
  const labelMap = {
    Conserva: "Conserva",
    Energy: "Energy",
    Vodka: "Vodka",
    Tushkan: "Tushkan",
    Flash: "Flash",
    Stalker: "Stalker",
    Bandit: "Bandit",
    Plate: "Plate",
    Artefact: "Artefact",
    scatter: "Scatter",
  };

  return labelMap[type] || type;
}

function getSymbolImage(type) {
  return SYMBOL_IMAGE_MAP[type] || "";
}

function getSymbolPayout(symbol, count) {
  if (symbol === "scatter") {
    if (count >= 6) return SCATTER_PAYOUTS[6];
    if (count >= 5) return SCATTER_PAYOUTS[5];
    if (count >= 4) return SCATTER_PAYOUTS[4];
    if (count >= 3) return SCATTER_PAYOUTS[3];
    return 0;
  }

  const payoutTable = PAYOUTS[symbol];

  if (!payoutTable) return 0;
  if (count >= 10) return payoutTable[10];
  if (count >= 8) return payoutTable[8];
  if (count >= 6) return payoutTable[6];
  return 0;
}

function scalePayout(basePayout, betAmount) {
  return (basePayout * betAmount) / BASE_BET_AMOUNT;
}

// Целевое RTP вынесено в отдельную функцию, чтобы все фильтры сравнивали исходы одинаково.
function getTargetRtp() {
  return RTP_TARGET;
}

function getFreeSpinsAward(scatterCount) {
  if (scatterCount >= 5) return 9;
  if (scatterCount >= 4) return 8;
  return FREE_SPINS_START;
}

function formatCurrency(value) {
  return `${Number(value).toLocaleString("ru-RU")} \u20BD`;
}

function getCellKey(columnIndex, rowIndex) {
  return `${columnIndex}-${rowIndex}`;
}

function cloneGrid(grid) {
  return grid.map((column) => [...column]);
}

function findSymbolPositions(grid, symbol) {
  const positions = [];

  grid.forEach((column, columnIndex) => {
    column.forEach((cell, rowIndex) => {
      if (cell !== symbol) return;

      positions.push({
        columnIndex,
        rowIndex,
        key: getCellKey(columnIndex, rowIndex),
      });
    });
  });

  return positions;
}

// Sticky-scatter в режиме бесплатных спинов должен переживать обычное удаление выигрышных символов.
function normalizeFreeSpinScatterGrid(grid, stickyScatters = []) {
  const normalizedGrid = cloneGrid(grid);
  const scatterPositions = findSymbolPositions(normalizedGrid, "scatter");
  const stickyByKey = new Map(stickyScatters.map((sticky) => [sticky.key, sticky]));
  const nextStickyScatters = [...stickyScatters];
  let appearedThisSpin = false;

  scatterPositions.forEach((position) => {
    if (stickyByKey.has(position.key)) return;

    const nextSticky = {
      ...position,
      lifetime: SIDOROVICH_LIFETIME,
      justAppeared: true,
    };

    stickyByKey.set(position.key, nextSticky);
    nextStickyScatters.push(nextSticky);
    appearedThisSpin = true;
  });

  nextStickyScatters.forEach((sticky) => {
    normalizedGrid[sticky.columnIndex][sticky.rowIndex] = "scatter";
  });

  return {
    grid: normalizedGrid,
    stickyScatters: nextStickyScatters,
    appearedThisSpin,
  };
}

function clearCellsByKeySet(grid, keys, stickyScatters = []) {
  const stickyKeys = new Set(stickyScatters.map((sticky) => sticky.key));

  return grid.map((column, columnIndex) =>
    column.map((cell, rowIndex) => {
      const key = getCellKey(columnIndex, rowIndex);

      if (!keys.has(key)) return cell;
      if (stickyKeys.has(key)) return cell;
      return null;
    }),
  );
}

function removeStickyScattersFromGrid(grid, stickyScatters = []) {
  if (!stickyScatters.length) return grid;
  const stickyKeys = new Set(stickyScatters.map((sticky) => sticky.key));

  return grid.map((column, columnIndex) =>
    column.map((cell, rowIndex) =>
      stickyKeys.has(getCellKey(columnIndex, rowIndex)) ? null : cell,
    ),
  );
}

function clearMatchedCells(grid, matched) {
  return grid.map((column, columnIndex) =>
    column.map((cell, rowIndex) => (matched.has(getCellKey(columnIndex, rowIndex)) ? null : cell)),
  );
}

function collapseGrid(grid, isFreeSpins = false, anteBetActive = false, stickyScatters = []) {
  const weights = getSpinWeights(isFreeSpins, anteBetActive);

  return grid.map((column, columnIndex) => {
    const lockedRows = new Set(
      stickyScatters
        .filter((sticky) => sticky.columnIndex === columnIndex)
        .map((sticky) => sticky.rowIndex),
    );
    const nextColumn = Array(column.length).fill(null);

    lockedRows.forEach((rowIndex) => {
      nextColumn[rowIndex] = "scatter";
    });

    let writeRow = column.length - 1;

    for (let readRow = column.length - 1; readRow >= 0; readRow -= 1) {
      if (lockedRows.has(readRow)) {
        continue;
      }

      const symbol = column[readRow];
      if (!symbol) continue;

      while (lockedRows.has(writeRow)) {
        writeRow -= 1;
      }

      if (writeRow < 0) break;

      nextColumn[writeRow] = symbol;
      writeRow -= 1;
    }

    const refillWeights = nextColumn.includes("scatter") ? removeScatterWeight(weights) : weights;

    while (writeRow >= 0) {
      if (lockedRows.has(writeRow)) {
        writeRow -= 1;
        continue;
      }

      nextColumn[writeRow] = randomSymbolForWeights(refillWeights);
      writeRow -= 1;
    }

    return nextColumn;
  });
}

// Готовим данные для анимации падения: откуда каждая клетка визуально "прилетела" после каскада.
function getCollapseFallMap(clearedGrid, collapsedGrid, stickyScatters = []) {
  const fallMap = {};

  clearedGrid.forEach((column, columnIndex) => {
    const lockedRows = new Set(
      stickyScatters
        .filter((sticky) => sticky.columnIndex === columnIndex)
        .map((sticky) => sticky.rowIndex),
    );
    const availableRows = column.map((_, rowIndex) => rowIndex).filter((rowIndex) => !lockedRows.has(rowIndex));
    const survivorRows = column.reduce((rows, symbol, rowIndex) => {
      if (symbol && !lockedRows.has(rowIndex)) {
        rows.push(rowIndex);
      }
      return rows;
    }, []);

    const missingCount = availableRows.length - survivorRows.length;

    availableRows.forEach((rowIndex, availableIndex) => {
      const symbol = collapsedGrid[columnIndex][rowIndex];
      if (!symbol) return;

      let distance = 0;

      if (availableIndex < missingCount) {
        distance = missingCount + (missingCount - availableIndex);
      } else {
        const survivorIndex = availableIndex - missingCount;
        const previousRow = survivorRows[survivorIndex];

        if (typeof previousRow === "number") {
          distance = rowIndex - previousRow;
        }
      }

      if (distance > 0) {
        fallMap[getCellKey(columnIndex, rowIndex)] = distance;
      }
    });
  });

  return fallMap;
}

// Считаем все выигрыши на всём поле, включая отдельный учёт scatter и набор выигрышных клеток.
function evaluateGridWin(grid, betAmount, options = {}) {
  const ignoreScatterPayouts = options.ignoreScatterPayouts === true;
  let totalWin = 0;
  const matched = new Set();
  const winningSymbols = new Set();

  const symbolCounts = new Map();
  const symbolPositions = new Map();

  grid.forEach((column, columnIndex) => {
    column.forEach((symbol, rowIndex) => {
      symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1);

      if (!symbolPositions.has(symbol)) {
        symbolPositions.set(symbol, []);
      }

      symbolPositions.get(symbol).push([columnIndex, rowIndex]);
    });
  });

  symbolCounts.forEach((count, symbol) => {
    if (ignoreScatterPayouts && symbol === "scatter") {
      return;
    }

    const payout = getSymbolPayout(symbol, count);

    if (!payout) return;

    totalWin += scalePayout(payout, betAmount);
    winningSymbols.add(symbol);
    symbolPositions.get(symbol).forEach(([column, row]) => matched.add(getCellKey(column, row)));
  });

  return {
    totalWin,
    matched,
    scatterCount: symbolCounts.get("scatter") || 0,
    winningSymbols,
  };
}

function hasScatterFeatureTrigger(result) {
  return result.scatterCount >= 3 && result.scatterCount <= 5;
}

function hasRegularWinsAlongsideScatter(result, isFreeSpins = false) {
  if (isFreeSpins) {
    return false;
  }

  return hasScatterFeatureTrigger(result) && [...result.winningSymbols].some((symbol) => symbol !== "scatter");
}

function simulateSpinSequence(
  grid,
  betAmount,
  isFreeSpins = false,
  anteBetActive = false,
  stickyScatters = [],
) {
  /*
   * Сухая симуляция для эвристик генератора.
   *
   * Функция прогоняет весь каскадный сценарий без изменения React-состояния.
   * Это позволяет ещё до показа поля игроку понять:
   * - сколько в сумме выплатит такой стартовый расклад,
   * - сколько каскадов он породит,
   * - не окажется ли исход слишком жирным для текущей сессии.
   */
  let workingGrid = grid.map((column) => [...column]);
  let totalWin = 0;
  let cascades = 0;

  while (true) {
    const { totalWin: cascadeWin, matched } = evaluateGridWin(workingGrid, betAmount, {
      ignoreScatterPayouts: isFreeSpins,
    });

    if (!matched.size || cascadeWin <= 0) {
      return { grid, totalWin, cascades };
    }

    cascades += 1;
    totalWin += cascadeWin;
    workingGrid = collapseGrid(
      clearMatchedCells(workingGrid, matched),
      isFreeSpins,
      anteBetActive,
      stickyScatters,
    );
  }
}

function generateResolvedCollapseGrid(
  clearedGrid,
  betAmount,
  currentCascadeIndex,
  isFreeSpins = false,
  anteBetActive = false,
  stickyScatters = [],
) {
  /*
   * Этап дозаполнения после удаления символов.
   *
   * Здесь подбирается не первое попавшееся поле, а несколько кандидатных вариантов,
   * чтобы ритм каскадов оставался правдоподобным:
   * - ранние каскады ещё могут продолжаться,
   * - длинные цепочки начинают жёстче подавляться,
   * - поздние и слишком жирные продолжения чаще отбрасываются.
   *
   * Это не только математическая функция, но и функция "ощущения игры":
   * именно она сильно влияет на то, насколько слот кажется щедрым, нервным или вязким.
   */
  let fallbackGrid = collapseGrid(clearedGrid, isFreeSpins, anteBetActive, stickyScatters);

  for (let attempt = 0; attempt < MAX_REFILL_ATTEMPTS; attempt += 1) {
    const candidateGrid = collapseGrid(clearedGrid, isFreeSpins, anteBetActive, stickyScatters);
    const candidateResult = evaluateGridWin(candidateGrid, betAmount, {
      ignoreScatterPayouts: isFreeSpins,
    });
    const outcome = simulateSpinSequence(candidateGrid, betAmount, isFreeSpins, anteBetActive, stickyScatters);
    fallbackGrid = candidateGrid;

    if (hasRegularWinsAlongsideScatter(candidateResult, isFreeSpins)) {
      continue;
    }

    if (currentCascadeIndex >= HARD_MAX_CASCADES) {
      if (outcome.totalWin === 0) {
        return candidateGrid;
      }
      continue;
    }

    if (currentCascadeIndex >= 4) {
      if (
        outcome.cascades === 1 &&
        outcome.totalWin <= betAmount * 0.45 &&
        Math.random() < 0.08
      ) {
        return candidateGrid;
      }
      if (outcome.totalWin === 0) {
        return candidateGrid;
      }
      continue;
    }

    if (currentCascadeIndex === 3) {
      if (
        outcome.cascades === 1 &&
        outcome.totalWin <= betAmount * 0.7 &&
        Math.random() < 0.18
      ) {
        return candidateGrid;
      }
      if (outcome.totalWin === 0) {
        return candidateGrid;
      }
      continue;
    }

    if (currentCascadeIndex < 3 && outcome.cascades <= 2 && outcome.totalWin <= betAmount * 0.95) {
      return candidateGrid;
    }
  }

  return fallbackGrid;
}

// Проверяем, вписывается ли исход спина в заданные рамки RTP, волатильности и длины каскадов.
function shouldAcceptSpinOutcome(outcome, betAmount, stats, targetRtp) {
  if (outcome.totalWin === 0) return true;
  if (outcome.cascades > HARD_MAX_CASCADES) return false;

  const winMultiplier = outcome.totalWin / betAmount;
  const projectedWagered = stats.totalWagered + betAmount;
  const projectedPaid = stats.totalPaid + outcome.totalWin;
  const projectedRtp = projectedWagered > 0 ? projectedPaid / projectedWagered : 0;
  const maxAllowedWin = betAmount * MAX_WIN_MULTIPLIER;

  if (outcome.totalWin > maxAllowedWin) return false;

  if (projectedRtp > targetRtp + RTP_HARD_BAND) {
    if (outcome.cascades >= 5) return Math.random() < 0.005;
    if (outcome.cascades === 4) return Math.random() < 0.02;
    if (outcome.cascades === 3) return Math.random() < 0.08;
    if (winMultiplier > 1) return Math.random() < 0.04;
    return Math.random() < 0.12;
  }

  if (projectedRtp > targetRtp + RTP_SOFT_BAND) {
    if (outcome.cascades >= 5) return Math.random() < 0.01;
    if (outcome.cascades === 4) return Math.random() < 0.04;
    if (outcome.cascades === 3) return Math.random() < 0.14;
    if (winMultiplier > 1.15) return Math.random() < 0.08;
    if (outcome.cascades === 2) return Math.random() < 0.16;
    return Math.random() < 0.3;
  }

  if (projectedRtp < targetRtp - RTP_HARD_BAND) {
    if (outcome.cascades >= 5) return Math.random() < 0.02;
    if (outcome.cascades === 4) return Math.random() < 0.08;
    if (outcome.cascades === 3) return Math.random() < 0.28;
    if (winMultiplier <= 1.15) return Math.random() < 0.92;
    return Math.random() < 0.55;
  }

  if (projectedRtp < targetRtp - RTP_SOFT_BAND) {
    if (outcome.cascades >= 5) return Math.random() < 0.015;
    if (outcome.cascades === 4) return Math.random() < 0.06;
    if (outcome.cascades === 3) return Math.random() < 0.22;
    if (winMultiplier <= 1.05) return Math.random() < 0.78;
    return Math.random() < 0.42;
  }

  if (winMultiplier > SOFT_MAX_WIN_MULTIPLIER) {
    if (outcome.cascades >= 5) return Math.random() < 0.01;
    if (outcome.cascades === 4) return Math.random() < 0.04;
    if (outcome.cascades === 3) return Math.random() < 0.16;
    return Math.random() < 0.12;
  }

  if (outcome.cascades >= 5) {
    return Math.random() < 0.01;
  }

  if (outcome.cascades === 4) {
    return Math.random() < 0.05;
  }

  if (outcome.cascades === 3) {
    return Math.random() < 0.18;
  }

  if (outcome.cascades === 2 && winMultiplier > 1) {
    return Math.random() < 0.2;
  }

  if (outcome.cascades === 1 && winMultiplier > 1) {
    return Math.random() < 0.28;
  }

  return true;
}

function generateApprovedGrid(betAmount, stats, isFreeSpins = false, anteBetActive = false) {
  if (FORCE_BANDIT_WIN_ON_EVERY_SPIN_FOR_TESTING) {
    return forceWinningSymbolGrid(generateGrid(isFreeSpins, anteBetActive), "Bandit", 6);
  }

  let fallbackGrid = generateGrid(isFreeSpins, anteBetActive);
  const targetRtp = getTargetRtp();

  for (let attempt = 0; attempt < MAX_SPIN_ATTEMPTS; attempt += 1) {
    const candidateGrid = generateGrid(isFreeSpins, anteBetActive);
    const candidateResult = evaluateGridWin(candidateGrid, betAmount, {
      ignoreScatterPayouts: isFreeSpins,
    });
    const outcome = simulateSpinSequence(candidateGrid, betAmount, isFreeSpins, anteBetActive);
    fallbackGrid = candidateGrid;

    if (hasRegularWinsAlongsideScatter(candidateResult, isFreeSpins)) {
      continue;
    }

    if (shouldAcceptSpinOutcome(outcome, betAmount, stats, targetRtp)) {
      return candidateGrid;
    }
  }

  return fallbackGrid;
}

// Маленькая карточка-статистика для боковых панелей.
function PanelStat({ label, value, accent = false }) {
  return (
    <div className="panel-card">
      <div className="panel-label">{label}</div>
      <div className={`panel-value ${accent ? "panel-value-accent" : ""}`}>{value}</div>
    </div>
  );
}

function getRemovalEffectTypeForSymbol(symbol) {
  if (symbol === "Vodka") return "vodka-spill";
  if (symbol === "Energy") return "energy-shock";
  if (symbol === "Flash") return "gravi-heavy";
  if (symbol === "Tushkan") return "gravi-light";
  return null;
}

function buildRemovalEffects(grid, matched) {
  /*
   * Превращаем логические выигрышные клетки в описание визуальных эффектов.
   * Базовое удаление обслуживается CSS-классами, а часть символов дополнительно
   * порождает Pixi-оверлей с более дорогой и заметной сценой уничтожения.
   */
  const effects = [];

  grid.forEach((column, columnIndex) => {
    column.forEach((symbol, rowIndex) => {
      const key = getCellKey(columnIndex, rowIndex);
      if (!matched.has(key)) return;

      const type = getRemovalEffectTypeForSymbol(symbol);
      if (!type) return;

      effects.push({
        id: `${type}-${key}-${Date.now()}-${effects.length}`,
        key,
        type,
      });
    });
  });

  return effects;
}

function getSingleRemovalQuoteSources(grid, matched) {
  /*
   * Подбираем одиночную тематическую реплику под удаление.
   *
   * Реплика проигрывается только если в текущем remove-событии участвует ровно один тип символа.
   * Это ограничение нужно для читаемости сцены: при смешанном удалении аудио начинало бы спорить
   * с визуалом и создавать ощущение случайной, а не осмысленной реакции.
   */
  const matchedSymbols = new Set();

  grid.forEach((column, columnIndex) => {
    column.forEach((symbol, rowIndex) => {
      if (!matched.has(getCellKey(columnIndex, rowIndex))) return;
      matchedSymbols.add(symbol);
    });
  });

  if (matchedSymbols.size !== 1) return null;

  const [symbol] = [...matchedSymbols];
  if (symbol === "Vodka") return VODKA_QUOTES;
  if (symbol === "Tushkan" || symbol === "Flash") return ANOMALY_QUOTE;
  return null;
}

// Ниже идут Pixi-компоненты, которые рисуют временные визуальные эффекты поверх обычной HTML-сетки.
function VodkaSpillEffect({ effect, turbo }) {
  const graphicsRef = useRef(null);
  const progressRef = useRef(0);
  // Длительность подогнана под CSS-анимацию, чтобы наклон и след жидкости читались как одно событие.
  const duration = turbo ? 320 : 760;

  useTick((ticker) => {
    /*
     * Эффект строится вручную из простых примитивов:
     * - кривой струи,
     * - овальной лужицы,
     * - нескольких капель с разными фазами задержки.
     *
     * Важна не физическая точность, а мгновенно считываемая ассоциация:
     * символ "пролился", распался и освободил клетку для каскада.
     */
    const graphics = graphicsRef.current;
    if (!graphics) return;

    progressRef.current = Math.min(1, progressRef.current + ticker.deltaMS / duration);
    const progress = progressRef.current;
    const splash = Math.sin(progress * Math.PI);
    const cellLeft = effect.x + effect.width * 0.08;
    const cellRight = effect.x + effect.width * 0.92;
    const cellBottom = effect.y + effect.height * 0.92;
    const sourceX = effect.x + effect.width * 0.26;
    const sourceY = effect.y + effect.height * 0.32;
    const streamMidX = effect.x + effect.width * (0.18 - progress * 0.02);
    const streamMidY = effect.y + effect.height * (0.56 + progress * 0.04);
    const streamEndX = effect.x + effect.width * (0.22 + progress * 0.03);
    const streamEndY = Math.min(cellBottom - effect.height * 0.08, effect.y + effect.height * (0.78 + progress * 0.04));
    const puddleX = Math.max(cellLeft + effect.width * 0.12, Math.min(cellRight - effect.width * 0.16, effect.x + effect.width * 0.26));
    const puddleY = Math.min(cellBottom - effect.height * 0.05, effect.y + effect.height * 0.84);

    graphics.clear();

    graphics.moveTo(sourceX, sourceY);
    graphics.bezierCurveTo(
      sourceX - effect.width * 0.06,
      sourceY + effect.height * 0.08,
      streamMidX,
      streamMidY,
      streamEndX,
      streamEndY,
    );
    graphics.stroke({
      width: Math.max(3, effect.width * (0.058 - progress * 0.016)),
      color: 0xe8fff2,
      alpha: 0.36 + splash * 0.18,
    });

    graphics.ellipse(
      puddleX,
      puddleY,
      effect.width * (0.1 + progress * 0.08),
      effect.height * (0.026 + progress * 0.022),
    );
    graphics.fill({
      color: 0xd8ffea,
      alpha: 0.1 + progress * 0.12,
    });

    for (let index = 0; index < 3; index += 1) {
      const dropProgress = Math.max(0, progress - index * 0.12);
      if (dropProgress <= 0 || dropProgress >= 1) continue;

      graphics.circle(
        Math.max(cellLeft, sourceX - effect.width * 0.02 - dropProgress * effect.width * 0.06 + effect.width * 0.03 * index),
        Math.min(cellBottom - effect.height * 0.04, sourceY + dropProgress * effect.height * (0.2 + index * 0.08)),
        Math.max(1.2, effect.width * (0.016 - dropProgress * 0.006)),
      );
      graphics.fill({
        color: 0xf7fff9,
        alpha: 0.22 * (1 - dropProgress),
      });
    }
  });

  return <pixiGraphics ref={graphicsRef} />;
}

function EnergyShockEffect({ effect, turbo }) {
  const graphicsRef = useRef(null);
  const progressRef = useRef(0);
  // Двухтактная сцена: сначала короткая дрожь-зарядка, потом явный электрический разряд.
  const duration = turbo ? 280 : 620;

  useTick((ticker) => {
    /*
     * Внутренний ритм эффекта разделён на две части:
     * - первая часть даёт телеграф: символ дрожит и накапливает напряжение,
     * - вторая часть выпускает наружу кольцо и электрические дуги.
     *
     * Такое разделение делает удаление понятным даже на высокой скорости turbo.
     */
    const graphics = graphicsRef.current;
    if (!graphics) return;

    progressRef.current = Math.min(1, progressRef.current + ticker.deltaMS / duration);
    const progress = progressRef.current;
    const centerX = effect.x + effect.width / 2;
    const centerY = effect.y + effect.height / 2;
    const phase = progress < 0.38 ? "shake" : "shock";

    graphics.clear();

    if (phase === "shake") {
      const jitter = Math.sin(progress * 60) * effect.width * 0.04;
      graphics.roundRect(
        effect.x + effect.width * 0.18 + jitter,
        effect.y + effect.height * 0.14,
        effect.width * 0.64,
        effect.height * 0.72,
        12,
      );
      graphics.stroke({
        width: Math.max(2, effect.width * 0.04),
        color: 0xa8ff59,
        alpha: 0.6,
      });
      return;
    }

    const pulse = (progress - 0.38) / 0.62;
    graphics.circle(centerX, centerY, effect.width * (0.18 + pulse * 0.32));
    graphics.stroke({
      width: Math.max(2, effect.width * 0.032),
      color: 0xb8ff5e,
      alpha: 0.42 * (1 - pulse),
    });

    const arcSets = [
      [
        [effect.x + effect.width * 0.3, effect.y + effect.height * 0.16],
        [effect.x + effect.width * 0.54, effect.y + effect.height * 0.28],
        [effect.x + effect.width * 0.4, effect.y + effect.height * 0.48],
        [effect.x + effect.width * 0.62, effect.y + effect.height * 0.72],
      ],
      [
        [effect.x + effect.width * 0.74, effect.y + effect.height * 0.22],
        [effect.x + effect.width * 0.52, effect.y + effect.height * 0.36],
        [effect.x + effect.width * 0.68, effect.y + effect.height * 0.56],
        [effect.x + effect.width * 0.46, effect.y + effect.height * 0.78],
      ],
    ];

    arcSets.forEach((points, arcIndex) => {
      graphics.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        const wobble = Math.sin((pulse * 24) + (index + arcIndex) * 1.6) * effect.width * 0.03;
        graphics.lineTo(points[index][0] + wobble, points[index][1]);
      }
      graphics.stroke({
        width: Math.max(2, effect.width * 0.03),
        color: arcIndex === 0 ? 0xc9ff79 : 0xefffbc,
        alpha: 0.76 * (1 - pulse * 0.35),
      });
    });
  });

  return <pixiGraphics ref={graphicsRef} />;
}

function GraviVortexEffect({ effect, turbo }) {
  const graphicsRef = useRef(null);
  const progressRef = useRef(0);
  const isHeavy = effect.type === "gravi-heavy";
  // Тяжёлый и лёгкий гравитационные эффекты строятся на одной идее, но отличаются плотностью и временем.
  const duration = turbo ? (isHeavy ? 320 : 220) : isHeavy ? 860 : 480;

  useTick((ticker) => {
    /*
     * Здесь рисуется не "взрыв", а именно втягивание:
     * - центральное тёмное ядро,
     * - внешнее кольцо,
     * - частицы, вращающиеся по спирали,
     * - streak-линии, которые усиливают ощущение центростремительного движения.
     *
     * Heavy-вариант дольше держит напряжение и больше подходит для мощных символов.
     */
    const graphics = graphicsRef.current;
    if (!graphics) return;

    progressRef.current = Math.min(1, progressRef.current + ticker.deltaMS / duration);
    const progress = progressRef.current;
    const centerX = effect.x + effect.width * (isHeavy ? 0.52 : 0.56);
    const centerY = effect.y + effect.height * (isHeavy ? 0.54 : 0.5);
    const baseRadius = effect.width * (isHeavy ? 0.24 : 0.18);
    const pullProgress = progress < 0.72 ? progress / 0.72 : 1;
    const residueProgress = progress > 0.64 ? (progress - 0.64) / 0.36 : 0;

    graphics.clear();

    graphics.circle(centerX, centerY, baseRadius * (0.48 + pullProgress * 0.26));
    graphics.fill({
      color: 0x0f1110,
      alpha: isHeavy ? 0.22 + pullProgress * 0.28 : 0.16 + pullProgress * 0.2,
    });

    graphics.circle(centerX, centerY, baseRadius * (0.86 + pullProgress * 0.4));
    graphics.stroke({
      width: Math.max(2, effect.width * 0.026),
      color: 0x9ca59b,
      alpha: (1 - progress) * (isHeavy ? 0.22 : 0.18),
    });

    graphics.circle(centerX, centerY, baseRadius * (1.08 + residueProgress * 0.7));
    graphics.stroke({
      width: Math.max(1.5, effect.width * 0.018),
      color: 0xc8ccc7,
      alpha: residueProgress > 0 ? (1 - residueProgress) * 0.18 : 0,
    });

    const particleCount = isHeavy ? 10 : 7;
    for (let index = 0; index < particleCount; index += 1) {
      const angle = progress * (isHeavy ? 6.2 : 7.8) + index * ((Math.PI * 2) / particleCount);
      const radius = baseRadius * (1.05 - pullProgress * 0.82) * (1 + (index % 3) * 0.08);
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius * 0.76;
      const size = effect.width * (isHeavy ? 0.03 : 0.022) * (1 - progress * 0.5);

      graphics.circle(x, y, Math.max(1.2, size));
      graphics.fill({
        color: index % 2 === 0 ? 0x6f6c64 : 0xaba69a,
        alpha: (1 - progress) * (isHeavy ? 0.34 : 0.26),
      });
    }

    const streakCount = isHeavy ? 3 : 2;
    for (let index = 0; index < streakCount; index += 1) {
      const streakAngle = progress * (isHeavy ? 5.6 : 7.1) + index * 2.18;
      const outerRadius = baseRadius * (1.12 - pullProgress * 0.58);
      const innerRadius = outerRadius * 0.32;
      const outerX = centerX + Math.cos(streakAngle) * outerRadius;
      const outerY = centerY + Math.sin(streakAngle) * outerRadius * 0.76;
      const innerX = centerX + Math.cos(streakAngle + 0.42) * innerRadius;
      const innerY = centerY + Math.sin(streakAngle + 0.42) * innerRadius * 0.76;

      graphics.moveTo(outerX, outerY);
      graphics.lineTo(innerX, innerY);
      graphics.stroke({
        width: Math.max(1.5, effect.width * (isHeavy ? 0.022 : 0.016)),
        color: 0xd4d8d3,
        alpha: (1 - progress) * 0.18,
      });
    }
  });

  return <pixiGraphics ref={graphicsRef} />;
}

function RemovalEffectsCanvas({ effects, width, height, turbo }) {
  if (!effects.length || !width || !height) return null;

  return (
    <div className="pixi-effects-layer" aria-hidden="true">
      <Application width={Math.ceil(width)} height={Math.ceil(height)} antialias backgroundAlpha={0}>
        <pixiContainer x={0} y={0}>
          {effects.map((effect) =>
            effect.type === "vodka-spill" ? (
              <VodkaSpillEffect key={effect.id} effect={effect} turbo={turbo} />
            ) : effect.type === "energy-shock" ? (
              <EnergyShockEffect key={effect.id} effect={effect} turbo={turbo} />
            ) : (
              <GraviVortexEffect key={effect.id} effect={effect} turbo={turbo} />
            ),
          )}
        </pixiContainer>
      </Application>
    </div>
  );
}

const SymbolCell = memo(function SymbolCell({
  cellKey,
  type,
  isWinning,
  isRemoving,
  isCollecting,
  isBonusTrigger,
  isFalling,
  fallDistance,
  winOrder,
  isStickyScatter,
  stickyScatterLifetime = null,
  onCellRef,
}) {
  const isEmpty = !type;
  const isFireRemoval = type === "Artefact" && isRemoving;
  const isArmorRemoval = type === "Plate" && isRemoving;
  const isVodkaRemoval = type === "Vodka" && isRemoving;
  const isEnergyRemoval = type === "Energy" && isRemoving;
  const isSpinShrinkRemoval = (type === "Stalker" || type === "Bandit") && isRemoving;
  const isGraviHeavyRemoval = type === "Flash" && isRemoving;
  const isGraviLightRemoval = type === "Tushkan" && isRemoving;

  return (
    <div
      ref={(node) => onCellRef(cellKey, node)}
      className={[
        "symbol-cell",
        type ? `symbol-${type}` : "symbol-empty",
        isWinning ? "winning-cell" : "",
        isRemoving ? "removing-cell" : "",
        isCollecting ? "collecting-cell" : "",
        isFireRemoval ? "fire-removing-cell" : "",
        isArmorRemoval ? "armor-removing-cell" : "",
        isVodkaRemoval ? "vodka-removing-cell" : "",
        isEnergyRemoval ? "energy-removing-cell" : "",
        isSpinShrinkRemoval ? "spin-shrink-removing-cell" : "",
        isGraviHeavyRemoval ? "gravi-heavy-removing-cell" : "",
        isGraviLightRemoval ? "gravi-light-removing-cell" : "",
        isStickyScatter ? "sticky-scatter-cell" : "",
        isFalling ? "falling-cell" : "",
        isBonusTrigger ? "bonus-trigger-cell" : "",
        isEmpty ? "empty-cell" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        ...(isWinning ? { "--win-order": winOrder } : {}),
        ...(isFalling ? { "--fall-distance": fallDistance } : {}),
      }}
    >
      {!isEmpty ? (
        <>
          {isFireRemoval ? <div className="symbol-vfx-layer fire-vfx-layer" aria-hidden="true" /> : null}
          {isArmorRemoval ? <div className="symbol-vfx-layer armor-vfx-layer" aria-hidden="true" /> : null}
          {isStickyScatter ? <div className="sticky-scatter-aura" aria-hidden="true" /> : null}
          <div className="symbol-art" data-symbol={type}>
            <img
              src={getSymbolImage(type)}
              alt={getSymbolLabel(type)}
              loading="eager"
              decoding="async"
            />
          </div>
          {isStickyScatter ? (
            <div className="sticky-scatter-life" aria-hidden="true">
              {stickyScatterLifetime}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
});

// Панели и оверлеи разнесены по отдельным компонентам, чтобы основной App не разрастался ещё сильнее.
function LeftPanel({
  balance,
  betPerLine,
  totalBet,
  lastWin,
  anteBetCost,
  anteBetEnabled,
  onToggleAnteBet,
  onBuyFreeSpins,
  buyFreeSpinsCost,
  canBuyFreeSpins,
  isSpinning,
  onDecreaseBet,
  onIncreaseBet,
  onOpenPaytable,
}) {
  return (
    <aside className="left-panel">
      <div className="panel-card player-card">
        <div className="player-meta">
          <div className="avatar-badge">P</div>
          <div>
            <div className="player-title">{UI_TEXT.player}</div>
            <div className="player-name">{UI_TEXT.playerName}</div>
          </div>
        </div>

        <div className="player-balance">
          <div className="panel-label">{UI_TEXT.balance}</div>
          <div className="panel-value panel-value-accent">{formatCurrency(balance)}</div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-label">{UI_TEXT.betPerLine}</div>
        <div className="bet-row">
          <button className="mini-btn" type="button" onClick={onDecreaseBet}>
            -
          </button>
          <div className="bet-box">{formatCurrency(betPerLine)}</div>
          <button className="mini-btn" type="button" onClick={onIncreaseBet}>
            +
          </button>
        </div>
      </div>

      <PanelStat label={UI_TEXT.totalBet} value={formatCurrency(totalBet)} accent />
      <PanelStat label={UI_TEXT.lastWin} value={formatCurrency(lastWin)} accent />

      <button
        className={`wide-btn ${!canBuyFreeSpins || isSpinning ? "wide-btn-disabled" : ""}`}
        type="button"
        onClick={onBuyFreeSpins}
        disabled={isSpinning || !canBuyFreeSpins}
      >
        {`${UI_TEXT.buyFreeSpins} ${formatCurrency(buyFreeSpinsCost)}`}
      </button>

      <div className="turbo-box ante-bet-box">
        <div className="ante-bet-copy">
          <span>{`${UI_TEXT.anteBetTitle} ${formatCurrency(anteBetCost)}`}</span>
          <strong>{UI_TEXT.anteBetDescription}</strong>
        </div>
        <button
          className={`toggle ${anteBetEnabled ? "toggle-on" : ""}`}
          type="button"
          onClick={onToggleAnteBet}
          aria-label={UI_TEXT.anteBetDescription}
          disabled={isSpinning}
        >
          <span className="toggle-knob" />
        </button>
      </div>

      <button className="wide-btn" type="button" onClick={onOpenPaytable}>
        {UI_TEXT.paytable}
      </button>
    </aside>
  );
}

function TopControls({
  soundOn,
  onToggleSound,
  isFullscreen,
  onToggleFullscreen,
  onToggleMenu,
}) {
  return (
    <div className="top-controls">
      <button className="icon-btn" type="button" onClick={onToggleSound} title="Музыка">
        {soundOn ? "\uD83D\uDD0A" : "\uD83D\uDD07"}
      </button>
      <button
        className="icon-btn"
        type="button"
        onClick={onToggleFullscreen}
        title="Полный экран"
      >
        {isFullscreen ? "\u2B0C" : "\u26F6"}
      </button>
      <button className="icon-btn" type="button" onClick={onToggleMenu} title="Настройки">
        {"\u2630"}
      </button>
    </div>
  );
}

function TopControlsHover({
  soundOn,
  onToggleSound,
  musicVolume,
  onChangeMusicVolume,
  isFullscreen,
  onToggleFullscreen,
  onToggleMenu,
}) {
  return (
    <div className="top-controls">
      <div className="top-control-group">
        <button className="icon-btn" type="button" onClick={onToggleSound} title="Музыка">
          {soundOn ? "\uD83D\uDD0A" : "\uD83D\uDD07"}
        </button>
        <div className="hover-volume-panel">
          <span className="hover-volume-label">{UI_TEXT.musicVolume}</span>
          <input
            className="hover-volume-slider"
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round(musicVolume * 100)}
            onChange={(event) => onChangeMusicVolume(Number(event.target.value) / 100)}
          />
        </div>
      </div>
      <button className="icon-btn" type="button" onClick={onToggleFullscreen} title="Полный экран">
        {isFullscreen ? "\u2B0C" : "\u26F6"}
      </button>
      <button className="icon-btn" type="button" onClick={onToggleMenu} title="Настройки">
        {"\u2630"}
      </button>
    </div>
  );
}

function RightPanel({
  turbo,
  onToggleTurbo,
  onSpin,
  onAutoSpin,
  isSpinning,
  autoSpinLeft,
  isFreeSpins,
  freeSpinsLeft,
}) {
  return (
    <aside className="right-panel">
      <div className="action-stack">
        {isFreeSpins ? (
          <div className="turbo-box free-spins-box">
            <span>{UI_TEXT.freeSpinsLabel}</span>
            <strong>{freeSpinsLeft}</strong>
          </div>
        ) : null}

        <div className="turbo-box">
          <span>{UI_TEXT.turbo}</span>
          <button
            className={`toggle ${turbo ? "toggle-on" : ""}`}
            type="button"
            onClick={onToggleTurbo}
            aria-label="Turbo mode"
          >
            <span className="toggle-knob" />
          </button>
        </div>

        <button
          className={`spin-button ${isSpinning ? "spin-button-disabled" : ""}`}
          type="button"
          onClick={onSpin}
          disabled={isSpinning}
        >
          <span className="spin-inner">{isSpinning ? "..." : "⟳"}</span>
        </button>

        <button className="auto-btn" type="button" onClick={onAutoSpin} disabled={isSpinning}>
          {autoSpinLeft > 0 ? `${UI_TEXT.autoplay} ${autoSpinLeft}` : UI_TEXT.autoplay}
        </button>
      </div>
    </aside>
  );
}

function SlotGrid({
  grid,
  winningCells,
  removingCells,
  collectingCells,
  bonusTriggerCells,
  fallingCells,
  activeRemovalEffects,
  bonusCollection,
  stickyScatters,
  columnMotion,
  turbo,
  statusText,
}) {
  /*
   * SlotGrid — это визуальный мост между логическими ключами клеток и реальными координатами на экране.
   *
   * Компонент измеряет DOM-геометрию каждой клетки, чтобы точно совместить с ней:
   * - Pixi-эффекты удаления,
   * - полёты Conserva к sticky-scatter,
   * - всплывающий текст награды над целями бонусной коллекции.
   */
  /*
   * Ключевая идея компонента:
   * игровая логика знает только координаты вида `column-row`, а эффекты должны знать пиксели.
   * Поэтому SlotGrid постоянно выступает адаптером между "логикой слота" и "сценой на экране".
   */
  const frameRef = useRef(null);
  const cellRefs = useRef(new Map());
  const [measuredEffects, setMeasuredEffects] = useState([]);
  const [measuredBonusCollection, setMeasuredBonusCollection] = useState(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const stickyScatterLifetimeByKey = useMemo(
    () => new Map(stickyScatters.map((sticky) => [sticky.key, sticky.lifetime])),
    [stickyScatters],
  );

  const registerCellRef = useCallback((key, node) => {
    if (node) {
      cellRefs.current.set(key, node);
    } else {
      cellRefs.current.delete(key);
    }
  }, []);

  useLayoutEffect(() => {
    const frameNode = frameRef.current;
    if (!frameNode) return undefined;

    const updateMeasurements = () => {
      const frameRect = frameNode.getBoundingClientRect();
      const nextEffects = activeRemovalEffects
        .map((effect) => {
          const cellNode = cellRefs.current.get(effect.key);
          if (!cellNode) return null;

          const cellRect = cellNode.getBoundingClientRect();
          return {
            ...effect,
            x: cellRect.left - frameRect.left,
            y: cellRect.top - frameRect.top,
            width: cellRect.width,
            height: cellRect.height,
          };
        })
        .filter(Boolean);

      setMeasuredEffects(nextEffects);
      setFrameSize({
        width: frameNode.clientWidth,
        height: frameNode.clientHeight,
      });

      if (bonusCollection?.targetKeys?.length) {
        const targets = bonusCollection.targetKeys
          .map((key) => {
            const targetNode = cellRefs.current.get(key);
            if (!targetNode) return null;

            const targetRect = targetNode.getBoundingClientRect();
            return {
              key,
              x: targetRect.left - frameRect.left,
              y: targetRect.top - frameRect.top,
              width: targetRect.width,
              height: targetRect.height,
            };
          })
          .filter(Boolean);

        if (!targets.length) {
          setMeasuredBonusCollection(null);
          return;
        }

        const sources = bonusCollection.sourceKeys
          .map((key) => {
            const sourceNode = cellRefs.current.get(key);
            if (!sourceNode) return null;

            const sourceRect = sourceNode.getBoundingClientRect();
            return {
              key,
              x: sourceRect.left - frameRect.left,
              y: sourceRect.top - frameRect.top,
              width: sourceRect.width,
              height: sourceRect.height,
            };
          })
          .filter(Boolean);

        setMeasuredBonusCollection({
          ...bonusCollection,
          targets,
          sources,
        });
      } else {
        setMeasuredBonusCollection(null);
      }
    };

    updateMeasurements();

    const resizeObserver = new ResizeObserver(updateMeasurements);
    resizeObserver.observe(frameNode);
    window.addEventListener("resize", updateMeasurements);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateMeasurements);
    };
  }, [activeRemovalEffects, bonusCollection, grid]);

  return (
    <section className={`slot-screen ${turbo ? "slot-screen-turbo" : ""}`}>
      <header className="slot-header">
        <div className="brand-lockup">
          <div className="brand-title">Д.Д.Д. Казино</div>
          <div className="brand-subtitle">Лучшие слоты в Зоне!</div>
          <div className="brand-mode">{UI_TEXT.mode}</div>
        </div>
      </header>

      <div className="slot-banner">{UI_TEXT.banner}</div>

      <div className="slot-grid-shell">
        <div className="slot-grid-frame" ref={frameRef}>
          <RemovalEffectsCanvas
            effects={measuredEffects}
            width={frameSize.width}
            height={frameSize.height}
            turbo={turbo}
          />
          {measuredBonusCollection?.sources?.length ? (
            <div className="bonus-collection-layer" aria-hidden="true">
              {measuredBonusCollection.sources.map((source, index) => (
                measuredBonusCollection.targets.map((target, targetIndex) => (
                  <div
                    key={`${source.key}-${target.key}`}
                    className="bonus-collection-item"
                    style={{
                      left: source.x,
                      top: source.y,
                      width: source.width,
                      height: source.height,
                      "--collect-dx": `${target.x - source.x}px`,
                      "--collect-dy": `${target.y - source.y}px`,
                      "--collect-delay": `${(index + targetIndex) * (turbo ? 36 : 72)}ms`,
                    }}
                  >
                    <img src={getSymbolImage("Conserva")} alt="" />
                  </div>
                ))
              ))}

              {measuredBonusCollection.targets.map((target) => (
                <div
                  key={`impact-${target.key}`}
                  className="bonus-collection-impact"
                  style={{
                    left: target.x,
                    top: target.y,
                    width: target.width,
                    height: target.height,
                  }}
                />
              ))}

              <div
                className="bonus-collection-reward"
                style={{
                  left:
                    measuredBonusCollection.targets.reduce(
                      (sum, target) => sum + target.x + target.width * 0.5,
                      0,
                    ) / measuredBonusCollection.targets.length,
                  top:
                    measuredBonusCollection.targets.reduce((sum, target) => sum + target.y, 0) /
                      measuredBonusCollection.targets.length -
                    8,
                }}
              >
                {`+${formatCurrency(measuredBonusCollection.reward)}`}
              </div>
            </div>
          ) : null}
          <div className="slot-grid">
            {grid.map((column, columnIndex) => (
              <div
                key={`column-${columnIndex}`}
                className={[
                  "slot-column",
                  columnMotion === "spinning" ? "slot-column-spinning" : "",
                  columnMotion === "settling" ? "slot-column-settling" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  "--column-index": columnIndex,
                  "--column-stop-delay": `${columnIndex * (turbo ? 8 : 16)}ms`,
                }}
              >
                {column.map((cell, rowIndex) => {
                  const key = `${columnIndex}-${rowIndex}`;
                  const stickyScatterLifetime = stickyScatterLifetimeByKey.get(key) ?? null;

                  return (
                    <SymbolCell
                      key={key}
                      cellKey={key}
                      type={cell}
                      isWinning={winningCells.has(key)}
                      isRemoving={removingCells.has(key)}
                      isCollecting={collectingCells.has(key)}
                      isFalling={Boolean(fallingCells[key])}
                      fallDistance={fallingCells[key] || 0}
                      isBonusTrigger={bonusTriggerCells.has(key)}
                      isStickyScatter={stickyScatterLifetime !== null}
                      stickyScatterLifetime={stickyScatterLifetime}
                      winOrder={columnIndex * 5 + rowIndex}
                      onCellRef={registerCellRef}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="status-bar">{statusText}</div>
    </section>
  );
}

function PaytableModal({ open, onClose, betPerLine }) {
  if (!open) return null;

  const regularSymbols = PAYTABLE_SYMBOL_ORDER.map((symbol) => [symbol, PAYOUTS[symbol]]).filter(
    ([, values]) => Boolean(values),
  );
  const scatterEntry = Object.entries(PAYOUTS).find(([symbol]) => symbol === "scatter");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title-row">
          <h2>{UI_TEXT.paytable}</h2>
          <button className="modal-close-btn" type="button" onClick={onClose}>
            {"\u2715"}
          </button>
        </div>

        <div className="paytable-grid">
          {regularSymbols.map(([symbol, values]) => (
            <div key={symbol} className="paytable-item">
              <div className={`paytable-symbol symbol-${symbol}`}>
                <img src={getSymbolImage(symbol)} alt={getSymbolLabel(symbol)} loading="lazy" />
              </div>
              <div className="paytable-text">
                <div>6-7 - {formatCurrency(scalePayout(values[6], betPerLine))}</div>
                <div>8-9 - {formatCurrency(scalePayout(values[8], betPerLine))}</div>
                <div>10-25 - {formatCurrency(scalePayout(values[10], betPerLine))}</div>
              </div>
            </div>
          ))}
        </div>

        {scatterEntry ? (
          <div className="paytable-special">
            <div className="paytable-special-card">
              <div className="paytable-special-copy">
                <div className="paytable-special-kicker">Особый символ</div>
                <div className="paytable-special-title">Скаттер</div>
                <div className="paytable-special-text">
                  <div>3 - {formatCurrency(scalePayout(SCATTER_PAYOUTS[3], betPerLine))}</div>
                  <div>4 - {formatCurrency(scalePayout(SCATTER_PAYOUTS[4], betPerLine))}</div>
                  <div>5 - {formatCurrency(scalePayout(SCATTER_PAYOUTS[5], betPerLine))}</div>
                </div>
              </div>

              <div className={`paytable-symbol paytable-symbol-hero symbol-${scatterEntry[0]}`}>
                <img
                  src={getSymbolImage(scatterEntry[0])}
                  alt={getSymbolLabel(scatterEntry[0])}
                  loading="lazy"
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MenuModal({ open, onClose, onReset }) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-small" onClick={(event) => event.stopPropagation()}>
        <div className="modal-title-row">
          <h2>{UI_TEXT.menu}</h2>
          <button className="modal-close-btn" type="button" onClick={onClose}>
            {"\u2715"}
          </button>
        </div>

        <div className="menu-actions">
          <button className="wide-btn" type="button" onClick={onReset}>
            {UI_TEXT.resetSession}
          </button>
          <button className="wide-btn" type="button" onClick={onClose}>
            {UI_TEXT.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function BonusModal({ data, onClose }) {
  if (!data) return null;

  const value = data.type === "intro" ? String(data.freeSpins) : formatCurrency(data.totalWin);

  const copy = data.type === "intro" ? UI_TEXT.bonusIntroText : UI_TEXT.bonusSummaryText;
  const footer = data.type === "intro" ? UI_TEXT.bonusIntroFooter : UI_TEXT.bonusSummaryFooter;

  return (
    <div className="bonus-backdrop" onClick={onClose}>
      <div className="bonus-modal" onClick={(event) => event.stopPropagation()}>
        <div className="bonus-modal-frame">
          <div className="bonus-modal-title">{UI_TEXT.bonusTitle}</div>
          <div className="bonus-modal-copy">{copy}</div>
          <div className="bonus-modal-value">{value}</div>
          <div className="bonus-modal-footer">{footer}</div>
          <button className="bonus-modal-continue" type="button" onClick={onClose}>
            {UI_TEXT.bonusContinue}
          </button>
        </div>
      </div>
    </div>
  );
}

// Главный компонент приложения: хранит состояние игры, спин-цикл, аудио, модалки и бонусные ветки.
export default function App() {
  /*
   * Модель состояния:
   * - экономика: баланс, ставка, последний выигрыш, накопленная статистика RTP за сессию
   * - режимы: turbo, free spins, ante bet, autospin, fullscreen, звук
   * - состояние поля: сетка, карта падения, sticky-scatter, наборы highlight/removal/collect
   * - оверлеи: модалки, сцена сбора бонуса, описания Pixi-эффектов
   *
   * Безопасность асинхронных веток:
   * spinCycleRef работает как маркер актуального цикла. Каждый новый спин или reset
   * увеличивает его, и все старые awaited-ветки обязаны завершаться раньше, если цикл уже сменился.
   */
  const preloadedSymbolImagesRef = useRef([]);
  const [grid, setGrid] = useState(() => generateGrid());
  const [viewportScale, setViewportScale] = useState(1);
  const [balance, setBalance] = useState(INITIAL_BALANCE);
  const [betIndex, setBetIndex] = useState(1);
  const [lastWin, setLastWin] = useState(0);
  const [statusText, setStatusText] = useState(UI_TEXT.ready);
  const [turbo, setTurbo] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.28);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [columnMotion, setColumnMotion] = useState("idle");
  const [winningCells, setWinningCells] = useState(new Set());
  const [removingCells, setRemovingCells] = useState(new Set());
  const [collectingCells, setCollectingCells] = useState(new Set());
  const [bonusTriggerCells, setBonusTriggerCells] = useState(new Set());
  const [fallingCells, setFallingCells] = useState({});
  const [activeRemovalEffects, setActiveRemovalEffects] = useState([]);
  const [bonusCollection, setBonusCollection] = useState(null);
  const [paytableOpen, setPaytableOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoSpinLeft, setAutoSpinLeft] = useState(0);
  const [isFreeSpins, setIsFreeSpins] = useState(false);
  const [freeSpinsLeft, setFreeSpinsLeft] = useState(0);
  const [freeSpinsTotalWin, setFreeSpinsTotalWin] = useState(0);
  const [stickyScatters, setStickyScatters] = useState([]);
  const [anteBetEnabled, setAnteBetEnabled] = useState(false);
  const [bonusModal, setBonusModal] = useState(null);
  const [pendingFreeSpinsStart, setPendingFreeSpinsStart] = useState(0);
  const [pendingFreeSpinsMeta, setPendingFreeSpinsMeta] = useState(null);

  const audioRef = useRef(null);
  const scatterQuoteAudioRef = useRef(null);
  const autoSpinRef = useRef(null);
  const timersRef = useRef(new Set());
  const spinCycleRef = useRef(0);
  const sessionStatsRef = useRef({ totalWagered: 0, totalPaid: 0 });
  const freeSpinsSessionRef = useRef(null);
  const betPerLine = BET_VALUES[betIndex];
  const anteBetCost = Math.round(betPerLine * ANTE_BET_MULTIPLIER);
  const totalBet = anteBetEnabled ? anteBetCost : betPerLine;
  const buyFreeSpinsCost = totalBet * BUY_FREE_SPINS_MULTIPLIER;

  function syncAudioPlayback(shouldEnable) {
    if (!audioRef.current) return;

    audioRef.current.muted = !shouldEnable;
    audioRef.current.volume = musicVolume;

    if (shouldEnable) {
      audioRef.current.play().catch(() => {});
    }
  }

  function tryStartAudio() {
    if (!audioRef.current || !soundOn) return;

    audioRef.current.volume = musicVolume;
    audioRef.current.play().catch(() => {
      // Браузер всё ещё может блокировать автозапуск со звуком до первого действия пользователя.
    });
  }

  function handleToggleSound() {
    if (!audioRef.current) {
      setSoundOn((previous) => !previous);
      return;
    }

    // Если в интерфейсе звук уже включён, но автозапуск был заблокирован, первый клик должен запустить музыку.
    if (soundOn && audioRef.current.paused) {
      syncAudioPlayback(true);
      return;
    }

    setSoundOn((previous) => !previous);
  }

  function wait(ms) {
    // Каждый таймер регистрируется, чтобы reset или unmount могли безопасно оборвать весь сценарий спина.
    return new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        timersRef.current.delete(timeoutId);
        resolve();
      }, ms);

      timersRef.current.add(timeoutId);
    });
  }

  function clearAllTimers() {
    // Не даём старым асинхронным веткам менять состояние после reset или прерванного спина.
    timersRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    timersRef.current.clear();
  }

  function stopScatterQuote() {
    if (!scatterQuoteAudioRef.current) return;

    scatterQuoteAudioRef.current.pause();
    scatterQuoteAudioRef.current.currentTime = 0;
    scatterQuoteAudioRef.current = null;
  }

  async function playQuoteFromSources(sources) {
    stopScatterQuote();

    const source = Array.isArray(sources)
      ? sources[Math.floor(Math.random() * sources.length)]
      : sources;
    const quoteAudio = new Audio(source);
    scatterQuoteAudioRef.current = quoteAudio;
    quoteAudio.preload = "auto";
    quoteAudio.volume = musicVolume;
    quoteAudio.muted = !soundOn;

    await new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        quoteAudio.removeEventListener("ended", handleEnded);
        quoteAudio.removeEventListener("error", handleEnded);
        quoteAudio.removeEventListener("abort", handleEnded);
      };

      const handleEnded = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (scatterQuoteAudioRef.current === quoteAudio) {
          scatterQuoteAudioRef.current = null;
        }
        resolve();
      };

      quoteAudio.addEventListener("ended", handleEnded, { once: true });
      quoteAudio.addEventListener("error", handleEnded, { once: true });
      quoteAudio.addEventListener("abort", handleEnded, { once: true });

      quoteAudio.play().catch(handleEnded);
    });
  }

  async function playScatterQuote() {
    await playQuoteFromSources(SCATTER_QUOTES);
  }

  async function playFreeSpinsOutcomeQuote(totalWin) {
    const session = freeSpinsSessionRef.current;
    if (!session) return;

    const shouldLose =
      session.source === "bought"
        ? totalWin < session.buyCost
        : totalWin < 10000;

    if (shouldLose) {
      await playQuoteFromSources(SCATTER_LOSE_QUOTE);
      return;
    }

    await playQuoteFromSources(SCATTER_WIN_QUOTES);
  }

  function getWinStatusText(amount) {
    return `Выигрыш: ${formatCurrency(amount)}`;
  }

  function resetSession() {
    clearAllTimers();
    stopScatterQuote();
    spinCycleRef.current += 1;

    setGrid(generateGrid());
    setBalance(INITIAL_BALANCE);
    setLastWin(0);
    setStatusText(UI_TEXT.sessionReset);
    setWinningCells(new Set());
    setRemovingCells(new Set());
    setCollectingCells(new Set());
    setBonusTriggerCells(new Set());
    setFallingCells({});
    setActiveRemovalEffects([]);
    setBonusCollection(null);
    setAutoSpinLeft(0);
    setIsFreeSpins(false);
    setFreeSpinsLeft(0);
    setFreeSpinsTotalWin(0);
    setStickyScatters([]);
    setAnteBetEnabled(false);
    setBonusModal(null);
    setPendingFreeSpinsStart(0);
    setPendingFreeSpinsMeta(null);
    setIsSpinning(false);
    setColumnMotion("idle");
    setMenuOpen(false);
    sessionStatsRef.current = { totalWagered: 0, totalPaid: 0 };
    freeSpinsSessionRef.current = null;
  }

  function decreaseBet() {
    setBetIndex((previous) => Math.max(0, previous - 1));
  }

  function increaseBet() {
    setBetIndex((previous) => Math.min(BET_VALUES.length - 1, previous + 1));
  }

  function prepareFreeSpinGrid(nextGrid, activeStickyScatters = []) {
    return normalizeFreeSpinScatterGrid(nextGrid, activeStickyScatters);
  }

  function getConservaKeys(nextGrid) {
    return new Set(findSymbolPositions(nextGrid, "Conserva").map((position) => position.key));
  }

  function launchFreeSpins(count, message, meta = null) {
    // Входим в устойчивый режим бонуски только после подтверждающей стартовой модалки.
    setIsFreeSpins(true);
    setFreeSpinsLeft(count);
    setFreeSpinsTotalWin(0);
    setStickyScatters([]);
    setBonusCollection(null);
    setCollectingCells(new Set());
    setAutoSpinLeft(0);
    setIsSpinning(false);
    setColumnMotion("idle");
    setStatusText(message);
    freeSpinsSessionRef.current = meta;
  }

  function queueFreeSpinsStart(count, meta = null) {
    // Старт бонуса специально завязан на модалку, чтобы у триггера была отдельная драматическая пауза.
    setPendingFreeSpinsStart(count);
    setPendingFreeSpinsMeta(meta);
    setBonusModal({
      type: "intro",
      freeSpins: count,
    });
  }

  function handleBonusModalClose() {
    if (!bonusModal) return;

    const modalType = bonusModal.type;
    setBonusModal(null);

    if (modalType === "intro" && pendingFreeSpinsStart > 0) {
      const count = pendingFreeSpinsStart;
      const meta = pendingFreeSpinsMeta;
      setPendingFreeSpinsStart(0);
      setPendingFreeSpinsMeta(null);
      launchFreeSpins(count, `${UI_TEXT.freeSpinsStarted}: ${count}`, meta);
    }
  }

  function buyFreeSpins() {
    if (isSpinning || isFreeSpins) return;

    if (balance < buyFreeSpinsCost) {
      setStatusText(UI_TEXT.insufficient);
      return;
    }

    setBalance((previous) => previous - buyFreeSpinsCost);
    setAutoSpinLeft(0);
    sessionStatsRef.current = {
      ...sessionStatsRef.current,
      totalWagered: sessionStatsRef.current.totalWagered + buyFreeSpinsCost,
    };
    runSpin({
      boughtBonus: true,
      skipBalanceDeduction: true,
    });
  }

  async function runSpin(options = {}) {
    /*
     * Главный сценарий игры.
     *
     * Фаза A: подготовка
     * - проверка баланса и режима,
     * - очистка прошлых подсветок и оверлеев,
     * - перевод интерфейса в состояние вращения,
     * - списание ставки, если это обычный платный спин.
     *
     * Фаза B: раскрытие поля
     * - выдерживается пауза под CSS-анимацию "вращения барабана",
     * - генерируется поле,
     * - поле показывается и проходит короткую фазу "приземления".
     *
     * Фаза C: цикл расчёта
     * - в free spins sticky-scatter сначала могут собрать Conserva,
     * - затем проверяются обычные выигрыши и scatter-триггеры,
     * - выигрыш удерживается на экране,
     * - символы удаляются,
     * - поле падает и дозаполняется,
     * - цикл повторяется, пока остаются новые выигрыши.
     *
     * Фаза D: завершение
     * - начисляется итоговая выплата,
     * - обновляются счётчики free spins и времена жизни sticky-scatter,
     * - при необходимости показываются intro/summary модалки бонуса,
     * - управление возвращается в idle или в следующую итерацию autospin.
     *
     * Контракт по таймингам:
     * `wait(...)` здесь не случайны — они синхронизированы с длительностями из `main.css`.
     * Если менять время хотя бы на одной стороне, визуальная сцена начнёт расслаиваться.
     */
    if (isSpinning) return;

    const boughtBonus = options.boughtBonus === true;
    const skipBalanceDeduction = options.skipBalanceDeduction === true;
    const spinUsesFreeSpins = isFreeSpins && freeSpinsLeft > 0;
    const spinUsesAnteBet = !spinUsesFreeSpins && anteBetEnabled;
    const remainingFreeSpinsAfterStart = spinUsesFreeSpins ? Math.max(0, freeSpinsLeft - 1) : 0;

    if (!spinUsesFreeSpins && !skipBalanceDeduction && balance < totalBet) {
      setStatusText(UI_TEXT.insufficient);
      return;
    }

    const cycleId = spinCycleRef.current + 1;
    spinCycleRef.current = cycleId;
    setIsSpinning(true);
    setColumnMotion("spinning");
    setWinningCells(new Set());
    setRemovingCells(new Set());
    setCollectingCells(new Set());
    setBonusTriggerCells(new Set());
    setFallingCells({});
    setActiveRemovalEffects([]);
    setBonusCollection(null);
    setLastWin(0);
    setStatusText(
      spinUsesFreeSpins
        ? `${UI_TEXT.freeSpinSpinning} ${freeSpinsLeft}`
        : boughtBonus
          ? UI_TEXT.boughtBonusSpinning
        : turbo
          ? UI_TEXT.turboSpinning
          : UI_TEXT.spinning,
    );

    if (spinUsesFreeSpins) {
      setFreeSpinsLeft(remainingFreeSpinsAfterStart);
    } else if (!skipBalanceDeduction) {
      setBalance((previous) => previous - totalBet);
      sessionStatsRef.current = {
        ...sessionStatsRef.current,
        totalWagered: sessionStatsRef.current.totalWagered + totalBet,
      };
    }

    await wait(turbo ? 420 : 980);
    if (spinCycleRef.current !== cycleId) return;

    let currentGrid = boughtBonus
      ? generateBoughtBonusGrid()
      : generateApprovedGrid(betPerLine, sessionStatsRef.current, spinUsesFreeSpins, spinUsesAnteBet);
    let activeStickyScatters = spinUsesFreeSpins ? stickyScatters.map((sticky) => ({ ...sticky })) : [];
    let stickyAppearedThisSpin = false;
    let didCollectConservaThisSpin = false;
    let cascadeIndex = 0;
    let totalSequenceWin = 0;
    const maxSequenceWin = betPerLine * MAX_WIN_MULTIPLIER;
    let highestScatterCount = 0;

    if (spinUsesFreeSpins) {
      const preparedFreeSpin = prepareFreeSpinGrid(currentGrid, activeStickyScatters);
      currentGrid = preparedFreeSpin.grid;
      activeStickyScatters = preparedFreeSpin.stickyScatters;
      stickyAppearedThisSpin = preparedFreeSpin.appearedThisSpin;
      setStickyScatters(activeStickyScatters);
    }

    setGrid(currentGrid);
    setColumnMotion("settling");
    // Небольшая пауза после показа поля, чтобы оно "село" после вращения, а не появилось резко.
    await wait(turbo ? 280 : 420);
    if (spinCycleRef.current !== cycleId) return;

    while (true) {
      // Специальный бонусный предварительный проход: sticky-scatter собирают Conserva до расчёта обычных выигрышей.
      if (spinUsesFreeSpins) {
        const preparedFreeSpin = prepareFreeSpinGrid(currentGrid, activeStickyScatters);
        currentGrid = preparedFreeSpin.grid;
        activeStickyScatters = preparedFreeSpin.stickyScatters;
        stickyAppearedThisSpin = stickyAppearedThisSpin || preparedFreeSpin.appearedThisSpin;
        setStickyScatters(activeStickyScatters);
        setGrid(currentGrid);
      }

      if (
        spinUsesFreeSpins &&
        activeStickyScatters.length > 0 &&
        cascadeIndex < BONUS_INTERNAL_CASCADE_LIMIT
      ) {
        const conservaKeys = getConservaKeys(currentGrid);
        const collectingStickyScatters = activeStickyScatters;

        if (conservaKeys.size > 0 && collectingStickyScatters.length > 0) {
          if (stickyAppearedThisSpin) {
            setStatusText("РЎРёРґРѕСЂРѕРІРёС‡Рё Рё РєРѕРЅСЃРµСЂРІС‹ РЅР° РїРѕР»Рµ...");
            await wait(turbo ? 320 : 700);
            if (spinCycleRef.current !== cycleId) return;

            stickyAppearedThisSpin = false;
            activeStickyScatters = activeStickyScatters.map((sticky) => ({
              ...sticky,
              justAppeared: false,
            }));
            setStickyScatters(activeStickyScatters);
          }

          const reward =
            scalePayout(CONSERVA_COLLECTION_BASE_REWARD, betPerLine) *
            conservaKeys.size *
            collectingStickyScatters.length;

          didCollectConservaThisSpin = true;
          totalSequenceWin = Math.min(maxSequenceWin, totalSequenceWin + reward);
          setLastWin(totalSequenceWin);
          setCollectingCells(conservaKeys);
          setBonusTriggerCells(new Set(collectingStickyScatters.map((sticky) => sticky.key)));
          setBonusCollection({
            targetKeys: collectingStickyScatters.map((sticky) => sticky.key),
            sourceKeys: [...conservaKeys],
            reward,
          });
          setStatusText(
            getWinStatusText(
              spinUsesFreeSpins ? freeSpinsTotalWin + totalSequenceWin : totalSequenceWin,
            ),
          );
          // Самая длинная пауза в скрипте: полёт символов, пульс цели и всплывающий текст награды.
          await wait(turbo ? 900 : 1600);
          if (spinCycleRef.current !== cycleId) return;

          setBonusCollection(null);
          setCollectingCells(new Set());
          setBonusTriggerCells(new Set());

          const clearedGrid = clearCellsByKeySet(currentGrid, conservaKeys, activeStickyScatters);
          setGrid(clearedGrid);

          await wait(turbo ? 120 : 180);
          if (spinCycleRef.current !== cycleId) return;

          cascadeIndex += 1;
          currentGrid = generateResolvedCollapseGrid(
            clearedGrid,
            betPerLine,
            cascadeIndex,
            true,
            spinUsesAnteBet,
            activeStickyScatters,
          );
          setFallingCells(getCollapseFallMap(clearedGrid, currentGrid, activeStickyScatters));
          setGrid(currentGrid);
          setColumnMotion("settling");
          activeStickyScatters = activeStickyScatters.map((sticky) =>
            collectingStickyScatters.some((collector) => collector.key === sticky.key)
              ? {
                  ...sticky,
                  lifetime: SIDOROVICH_LIFETIME,
                  justAppeared: false,
                }
              : sticky,
          );
          setStickyScatters(activeStickyScatters);

          await wait(turbo ? 260 : 420);
          if (spinCycleRef.current !== cycleId) return;

          setFallingCells({});
          continue;
        }
      }

      const { totalWin, matched, scatterCount } = evaluateGridWin(currentGrid, betPerLine, {
        ignoreScatterPayouts: spinUsesFreeSpins,
      });
      const scatterFeatureTrigger = !spinUsesFreeSpins && scatterCount >= 3 && scatterCount <= 5;
      const awardedFreeSpins = getFreeSpinsAward(scatterCount);
      highestScatterCount = Math.max(highestScatterCount, scatterCount);

      if (scatterFeatureTrigger) {
        // Триггер scatter прерывает обычный каскадный цикл и переводит игру в бонусную ветку.
        totalSequenceWin = Math.min(maxSequenceWin, totalSequenceWin + totalWin);
        setWinningCells(matched);
        setRemovingCells(new Set());
        setBonusTriggerCells(matched);
        setLastWin(totalSequenceWin);
        setStatusText(
          spinUsesFreeSpins
            ? `+${FREE_SPINS_RETRIGGER} FS`
            : boughtBonus
              ? `${UI_TEXT.freeSpinsBought}: ${awardedFreeSpins}`
              : `${UI_TEXT.freeSpinsStarted}: ${awardedFreeSpins}`,
        );

        if (!spinUsesFreeSpins) {
          await playScatterQuote();
          if (spinCycleRef.current !== cycleId) return;
          // Натуральный триггер scatter получает дополнительную паузу, чтобы ощущаться крупным событием.
          await wait(1500);
        } else {
          await wait(turbo ? 1400 : 2200);
        }
        if (spinCycleRef.current !== cycleId) return;

        setWinningCells(new Set());
        setBonusTriggerCells(new Set());
        setIsSpinning(false);
        setColumnMotion("idle");
        if (totalSequenceWin > 0) {
          setBalance((previous) => previous + totalSequenceWin);
          sessionStatsRef.current = {
            ...sessionStatsRef.current,
            totalPaid: sessionStatsRef.current.totalPaid + totalSequenceWin,
          };
          if (spinUsesFreeSpins) {
            setFreeSpinsTotalWin((previous) => previous + totalSequenceWin);
          }
        }

        if (spinUsesFreeSpins) {
          const updatedFreeSpinsLeft = remainingFreeSpinsAfterStart + FREE_SPINS_RETRIGGER;
          const totalBonusWin = freeSpinsTotalWin + totalSequenceWin;

          setFreeSpinsLeft(updatedFreeSpinsLeft);
          setStatusText(getWinStatusText(totalBonusWin));
        } else {
          queueFreeSpinsStart(awardedFreeSpins, {
            source: boughtBonus ? "bought" : "natural",
            buyCost: boughtBonus ? buyFreeSpinsCost : 0,
          });
          setStatusText(
            boughtBonus
              ? `${UI_TEXT.freeSpinsBought}: ${awardedFreeSpins}`
              : `${UI_TEXT.freeSpinsStarted}: ${awardedFreeSpins}`,
          );
        }
        return;
      }

      if (!matched.size || totalWin <= 0) {
        // Финальное состояние поля: новых обычных выигрышей нет, можно корректно завершать цикл.
        setWinningCells(new Set());
        setRemovingCells(new Set());
        setCollectingCells(new Set());
        setBonusTriggerCells(new Set());
        setFallingCells({});
        setActiveRemovalEffects([]);
        setBonusCollection(null);
        setLastWin(totalSequenceWin);
        if (totalSequenceWin > 0) {
          setBalance((previous) => previous + totalSequenceWin);
          sessionStatsRef.current = {
            ...sessionStatsRef.current,
            totalPaid: sessionStatsRef.current.totalPaid + totalSequenceWin,
          };
          if (spinUsesFreeSpins) {
            setFreeSpinsTotalWin((previous) => previous + totalSequenceWin);
          }
        }

        if (spinUsesFreeSpins) {
          let nextStickyScatters = activeStickyScatters.map((sticky) => ({ ...sticky }));
          let nextGrid = currentGrid;
          const totalBonusWin = freeSpinsTotalWin + totalSequenceWin;
          const updatedFreeSpinsLeft = remainingFreeSpinsAfterStart;

          if (nextStickyScatters.length > 0) {
            if (didCollectConservaThisSpin) {
              nextStickyScatters = nextStickyScatters.map((sticky) => ({
                ...sticky,
                lifetime: SIDOROVICH_LIFETIME,
                justAppeared: false,
              }));
            } else {
              nextStickyScatters = nextStickyScatters.map((sticky) => ({
                ...sticky,
                lifetime: sticky.lifetime - 1,
                justAppeared: false,
              }));
            }

            const expiredStickyScatters = nextStickyScatters.filter((sticky) => sticky.lifetime <= 0);
            if (expiredStickyScatters.length > 0) {
              const expiredStickyKeys = new Set(expiredStickyScatters.map((sticky) => sticky.key));

              setRemovingCells(expiredStickyKeys);
              await wait(turbo ? 220 : 420);
              if (spinCycleRef.current !== cycleId) return;

              nextStickyScatters = nextStickyScatters.filter((sticky) => sticky.lifetime > 0);
              const clearedExpiredStickyGrid = removeStickyScattersFromGrid(nextGrid, expiredStickyScatters);
              nextGrid = collapseGrid(
                clearedExpiredStickyGrid,
                true,
                spinUsesAnteBet,
                nextStickyScatters,
              );
              setRemovingCells(new Set());
              setGrid(nextGrid);
            }
          }

          setStickyScatters(nextStickyScatters);
          setIsSpinning(false);
          setColumnMotion("idle");

          if (updatedFreeSpinsLeft <= 0) {
            setIsFreeSpins(false);
            setStickyScatters([]);
            void playFreeSpinsOutcomeQuote(totalBonusWin);
            setBonusModal({
              type: "summary",
              totalWin: totalBonusWin,
            });
            setStatusText(getWinStatusText(totalBonusWin));
          } else {
            setStatusText(getWinStatusText(totalBonusWin));
          }
        } else if (highestScatterCount >= 3 && highestScatterCount <= 5) {
          setIsSpinning(false);
          setColumnMotion("idle");
          const triggeredFreeSpins = getFreeSpinsAward(highestScatterCount);
          queueFreeSpinsStart(triggeredFreeSpins, {
            source: boughtBonus ? "bought" : "natural",
            buyCost: boughtBonus ? buyFreeSpinsCost : 0,
          });
          setStatusText(
            boughtBonus
              ? `${UI_TEXT.freeSpinsBought}: ${triggeredFreeSpins}`
              : `${UI_TEXT.freeSpinsStarted}: ${triggeredFreeSpins}`,
          );
        } else if (totalSequenceWin > 0) {
          setIsSpinning(false);
          setColumnMotion("idle");
          setStatusText(`\u0412\u044b\u0438\u0433\u0440\u044b\u0448: ${formatCurrency(totalSequenceWin)}`);
        } else {
          setIsSpinning(false);
          setColumnMotion("idle");
          setStatusText(UI_TEXT.noWin);
        }
        return;
      }

      cascadeIndex += 1;
      totalSequenceWin = Math.min(maxSequenceWin, totalSequenceWin + totalWin);
      setWinningCells(matched);
      setRemovingCells(new Set());
      setLastWin(totalSequenceWin);
      setStatusText(
        getWinStatusText(spinUsesFreeSpins ? freeSpinsTotalWin + totalSequenceWin : totalSequenceWin),
      );

      // Удерживаем подсвеченный выигрыш достаточно долго, чтобы игрок успел его визуально считать.
      await wait(turbo ? 900 : 1600);
      if (spinCycleRef.current !== cycleId) return;

      const removalEffects = buildRemovalEffects(currentGrid, matched);
      const removalQuoteSources =
        cascadeIndex === 1 && Math.random() < SYMBOL_REMOVAL_QUOTE_CHANCE
          ? getSingleRemovalQuoteSources(currentGrid, matched)
          : null;
      setRemovingCells(new Set(matched));
      setActiveRemovalEffects(removalEffects);
      if (removalQuoteSources) {
        void playQuoteFromSources(removalQuoteSources);
      }
      await wait(
        turbo
          ? removalEffects.some((effect) => effect.type === "gravi-heavy")
            ? 320
            : removalEffects.some((effect) => effect.type === "gravi-light")
              ? 220
              : removalEffects.length
                ? 260
                : 180
          : removalEffects.some((effect) => effect.type === "vodka-spill")
            ? 820
            : removalEffects.some((effect) => effect.type === "gravi-heavy")
              ? 860
              : removalEffects.some((effect) => effect.type === "gravi-light")
                ? 480
            : removalEffects.some((effect) => effect.type === "energy-shock")
              ? 680
              : 320,
      );
      if (spinCycleRef.current !== cycleId) return;

      const clearedGrid = clearMatchedCells(currentGrid, matched);
      setGrid(clearedGrid);
      setWinningCells(new Set());
      setBonusTriggerCells(new Set());
      setActiveRemovalEffects([]);

      await wait(turbo ? 120 : 180);
      if (spinCycleRef.current !== cycleId) return;

      currentGrid = generateResolvedCollapseGrid(
        clearedGrid,
        betPerLine,
        cascadeIndex,
        spinUsesFreeSpins,
        spinUsesAnteBet,
        activeStickyScatters,
      );
      setFallingCells(getCollapseFallMap(clearedGrid, currentGrid, activeStickyScatters));
      setGrid(currentGrid);
      setRemovingCells(new Set());
      setColumnMotion("settling");

      // Окно падения каскада: синхронизировано с CSS-анимациями falling-cell и фазой посадки.
      await wait(turbo ? 260 : 420);
      if (spinCycleRef.current !== cycleId) return;

      setFallingCells({});
    }
  }

  function startAutoSpin() {
    if (isSpinning) return;

    if (autoSpinLeft > 0) {
      setAutoSpinLeft(0);
      setStatusText(UI_TEXT.autospinStopped);
      return;
    }

    setAutoSpinLeft(AUTOSPIN_COUNT);
    setStatusText(UI_TEXT.autospinStarted);
  }

  const runSpinEffect = useEffectEvent(() => {
    runSpin();
  });

  const tryStartAudioEffect = useEffectEvent(() => {
    tryStartAudio();
  });

  const syncAudioPlaybackEffect = useEffectEvent((shouldEnable) => {
    syncAudioPlayback(shouldEnable);
  });

  useEffect(() => {
    preloadedSymbolImagesRef.current = Object.values(SYMBOL_IMAGE_MAP).map((source) => {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
      return image;
    });

    return () => {
      preloadedSymbolImagesRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (autoSpinLeft <= 0 || isSpinning) return undefined;

    autoSpinRef.current = window.setTimeout(() => {
      runSpinEffect();
      setAutoSpinLeft((previous) => previous - 1);
    }, turbo ? 650 : 1700);

    return () => {
      if (autoSpinRef.current) {
        window.clearTimeout(autoSpinRef.current);
      }
    };
  }, [autoSpinLeft, isSpinning, turbo]);

  useEffect(() => {
    if (!isFreeSpins || freeSpinsLeft <= 0 || isSpinning || bonusModal) return undefined;

    const timeoutId = window.setTimeout(() => {
      runSpinEffect();
    }, turbo ? 700 : 1300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isFreeSpins, freeSpinsLeft, isSpinning, turbo, bonusModal]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const kickAudio = () => {
      tryStartAudioEffect();
    };

    const timeoutId = window.setTimeout(kickAudio, 0);
    window.addEventListener("load", kickAudio);
    document.addEventListener("visibilitychange", kickAudio);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("load", kickAudio);
      document.removeEventListener("visibilitychange", kickAudio);
    };
  }, [soundOn]);

  useEffect(() => {
    syncAudioPlaybackEffect(soundOn);
  }, [soundOn, musicVolume]);

  useEffect(() => {
    const updateViewportScale = () => {
      const gutter = document.fullscreenElement ? 56 : 28;
      const nextScale = Math.min(
        (window.innerWidth - gutter) / BASE_VIEWPORT_WIDTH,
        (window.innerHeight - gutter) / BASE_VIEWPORT_HEIGHT,
      );

      setViewportScale(Math.min(1, Math.max(nextScale, 0.45)));
    };

    updateViewportScale();
    window.addEventListener("resize", updateViewportScale);
    document.addEventListener("fullscreenchange", updateViewportScale);

    return () => {
      window.removeEventListener("resize", updateViewportScale);
      document.removeEventListener("fullscreenchange", updateViewportScale);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autoSpinRef.current) {
        window.clearTimeout(autoSpinRef.current);
      }
      clearAllTimers();
      spinCycleRef.current += 1;
    };
  }, []);

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      setStatusText(UI_TEXT.fullscreenError);
    }
  }

  return (
    <div className="app-shell">
      <div className="app-stage" style={{ "--viewport-scale": viewportScale }}>
        <audio
          ref={audioRef}
          src="/Music.mp3"
          autoPlay
          loop
          preload="auto"
          playsInline
          muted={!soundOn}
          onCanPlay={tryStartAudio}
          onLoadedData={tryStartAudio}
          style={{ display: "none" }}
        />
        <div className="device-frame">
          <div className="device-screen">
            <TopControlsHover
              soundOn={soundOn}
              onToggleSound={handleToggleSound}
              musicVolume={musicVolume}
              onChangeMusicVolume={setMusicVolume}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              onToggleMenu={() => setMenuOpen(true)}
            />

            <LeftPanel
              balance={balance}
              betPerLine={betPerLine}
              totalBet={totalBet}
              lastWin={lastWin}
              anteBetCost={anteBetCost}
              anteBetEnabled={anteBetEnabled}
              onToggleAnteBet={() => setAnteBetEnabled((previous) => !previous)}
              onBuyFreeSpins={buyFreeSpins}
              buyFreeSpinsCost={buyFreeSpinsCost}
              canBuyFreeSpins={!isFreeSpins && !anteBetEnabled && balance >= buyFreeSpinsCost}
              isSpinning={isSpinning}
              onDecreaseBet={decreaseBet}
              onIncreaseBet={increaseBet}
              onOpenPaytable={() => setPaytableOpen(true)}
            />

            <SlotGrid
              grid={grid}
              winningCells={winningCells}
              removingCells={removingCells}
              collectingCells={collectingCells}
              bonusTriggerCells={bonusTriggerCells}
              fallingCells={fallingCells}
              activeRemovalEffects={activeRemovalEffects}
              bonusCollection={bonusCollection}
              stickyScatters={stickyScatters}
              columnMotion={columnMotion}
              turbo={turbo}
              statusText={statusText}
            />

            <RightPanel
              turbo={turbo}
              onToggleTurbo={() => setTurbo((previous) => !previous)}
              onSpin={runSpin}
              onAutoSpin={startAutoSpin}
              isSpinning={isSpinning}
              autoSpinLeft={autoSpinLeft}
              isFreeSpins={isFreeSpins}
              freeSpinsLeft={freeSpinsLeft}
            />

            <BonusModal data={bonusModal} onClose={handleBonusModalClose} />
          </div>
        </div>
      </div>

      <PaytableModal
        open={paytableOpen}
        onClose={() => setPaytableOpen(false)}
        betPerLine={betPerLine}
      />
      <MenuModal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onReset={resetSession}
      />
    </div>
  );
}

