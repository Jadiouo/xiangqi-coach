import "./main.css";
import { boardCells, legalDestinations } from "./board-model";
import { GameWorkerClient, LatestGameState, LiveEvaluationGate } from "./game-client";
import { browserStorage, loadDifficulty, saveDifficulty } from "./difficulty-preference";
import { boardPlacement, isFlipped, loadUserSide, resultForUser, saveUserSide, type UserSide } from "./my-side";
import type { GameCommand, GameSnapshot, LiveEvaluationEvent, WorkerErrorCode } from "./game-client";
import { deleteSavedGame, importSavedGamesAtomically, listSavedGames, reviewFieldsForSave, savedGameUserSide, STANDARD_START_FEN, storeSavedGame, updateSavedGame } from "./game-library";
import type { SavedGame, SavedGameOutcome, SavedReviewSnapshot, SavedReviewNote } from "./game-library";
import { clearGameInProgress, loadGameInProgress, saveGameInProgress } from "./game-in-progress";
import { libraryRowParts } from "./library-row";
import { undoDisabledReason } from "./undo-reason";
import { estimateReviewSeconds, longReviewWarning, remainingSeconds, secondsPerPlyOverride } from "./review-estimate";
import { GameLibrarySession } from "./game-library-session";
import { ReviewWorkerPool } from "./review-pool";
import { autoReviewEnabled, backgroundWorkerCount, reviewWorkerCount } from "./review-workers";
import { createBackgroundReview } from "./background-review";
import { countedGames, createPlayedGames, PLAYED_GAMES_STORAGE_KEY, playedCounts } from "./played-games";
import { backgroundReviewAllowed } from "./background-allowed";
import { playedCountText } from "./played-count-text";
import { createAppReviewCache, deepNodeLimit } from "./review-cache";
import { createReviewComparisonElement } from "./review-comparison";
import { createReviewReasonElement } from "./review-reason";
import { createUserLevel, recordReviewedGame, reviewedGameKey, SKILL_LEVELS, type LevelWasm, type SkillLevelName } from "./user-level";
import type { ReviewJobState, ReviewWorkerPoint } from "./review-client";
import { createReviewVariationTree, parseReviewVariationTree, snapshotForMainline, variationTreeMatchesMainline } from "./review-variation-tree";
import type { ReviewVariationTree } from "./review-variation-tree";
import {
  buildArrowPlan,
  focusNav,
  focusPoints,
  liveWinProbabilityForUser,
  plySides,
  winProbabilityForUser,
} from "./review-presentation";
import type { ReviewSide } from "./review-presentation";
import { liveMeterDisplay, undoPlan } from "./review-live";
import type { Side } from "./review-live";
import type { UndoPlan } from "./review-live";
import { zhTW } from "./locale/zh-TW";
import { REVIEW_BUDGETS, createSettingsStore } from "./settings-store";
import { sideChangeAction } from "./side-change";
import { bindShell, buildHash, parseRoute } from "./ui/tabs";
import { drawReviewOverlay, renderReviewFocus, type FocusModel } from "./ui/review-focus";
import { applyDevMode, loadDevMode, saveDevMode } from "./ui/dev-mode";
import { shellHeaderHtml } from "./ui/template";
import { registerServiceWorker } from "./pwa/register";
import { showUpdateBanner, showUpdatedNotice } from "./pwa/update-banner";
import { RecordImportClient, type RecordImportResult } from "./record-import";
import { createReviewNoteInput, generateReviewNote } from "./review-note";
import { buildReviewPrintHtml } from "./review-print";
import { printHtmlDocument } from "./print-frame";
import { buildArchive, mergeArchiveGames, parseArchive } from "./game-archive";
import { createReviewRunContext, isCurrentReviewRun, type ReviewRunContext } from "./review-run-context";

async function startApplication(): Promise<void> {
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing application root");

function requiredElement<T extends Element>(element: T | null): T {
  if (!element) throw new Error("Missing interface element");
  return element;
}

app.textContent = zhTW.appTitle;
let worker: Worker | null = null;
let gameClient: GameWorkerClient | null = null;
let gameState = new LatestGameState();
let requestGeneration = 0;
let pending = false;
let searching = false;
let workerFailed = false;
let selectedSquare: string | null = null;
let gameError = "";
let reviewClient: ReviewWorkerPool | null = null;
let reviewMode = false;
let reviewState: ReviewJobState | null = null;
let reviewArtifact: SavedReviewSnapshot | null = null;
let reviewNote: SavedReviewNote | null = null;
let reviewNoteStatus = "";
let reviewNoteBusy = false;
let reviewNoteGeneration = 0;
let nextReviewRunId = 1;
let activeReviewRun: ReviewRunContext | null = null;
let reviewPly: number | null = null;
let selectedVariation: string[] = [];
let variationTree: ReviewVariationTree | null = null;
let branchNodeId = "main-0";
let branchState: GameSnapshot | null = null;
let branchWorker: Worker | null = null;
let branchClient: GameWorkerClient | null = null;
let branchGeneration = 0;
let branchPending = false;
let branchSearching = false;
let branchError = "";
let branchNoteDraft: { nodeId: string; text: string } | null = null;
let branchNoteFocused = false;
let branchProbability: { fen: string; value: number; redValue: number; side: "red" | "black" } | null = null;
const gameLibrarySession = new GameLibrarySession();
let libraryReady = false;
let savingGame = false;
let libraryStatus = "";
let pendingDeleteId: string | null = null;
let gameDifficulty: number | null = null;
let persistedGameKey = "";
let reviewStartedAt = 0;
let reviewRunIsWholeGame = false;
let reviewWarningBudget: number | null = null;
let reviewWarningSeconds = 0;
let reviewStartCheck = 0;
/** The saved game a refresh found named in the stored game; tied to the board only once the library is read and the game matches it exactly. */
let pendingBindingId: string | null = null;
const reviewResultCache = createAppReviewCache(location.search);
const liveEvaluationGate = new LiveEvaluationGate();
let liveEvaluationEnabled = false;
let liveProbability: number | null = null;
let liveEvaluationSide: Side = "red";
let liveEvaluationFen = "";
let liveEvaluationEvents: Array<{ side: "red" | "black"; fen: string }> = [];
let moveListFollowedKey = "";
let lastLiveInfo: { nodes: number; score: number; depth: number; elapsedMs: number } | null = null;
const settingsStore = createSettingsStore(browserStorage());
let selectedBudget = settingsStore.get().reviewBudget;
let pendingCommandType: GameCommand["type"] | null = null;
// the side the user chose in settings (applies to the next new game) and the side of the game on the board
let userSideSetting: UserSide = loadUserSide(browserStorage());
let gameSide: UserSide = userSideSetting;
let reviewUserSide: ReviewSide = gameSide;
let savedGames: SavedGame[] = [];
let pendingImport: RecordImportResult | null = null;
let importStatus = "";
let applyingImport = false;
let importIntentGeneration = 0;
let importPositionVersion = 0;
let currentSource: "played" | "imported" = "played";
// True once the live win probability was switched on during this game (SPEC 8.5: assisted games
// do not move the level estimate). Saved games do not record it, so a reloaded game counts as unassisted.
let gameAssisted = false;
let userLevel: ReturnType<typeof createUserLevel> | null = null;
// P6 segment 5: games the user finished, reviewed one at a time in the background while nothing else needs the machine.
const playedGames = createPlayedGames(browserStorage());
const autoReviewOn = autoReviewEnabled(location.search);
/** The last position seen with the game still going: a finished game is entered only if it grew out of one. */
let ongoingSeen: { startFen: string; moves: string[] } | null = null;
const backgroundReview = createBackgroundReview({
  ledger: playedGames,
  createPool: (onUpdate) => new ReviewWorkerPool(
    createReviewWorker, backgroundWorkerCount(navigator.hardwareConcurrency, location.search), onUpdate, reviewResultCache,
  ),
  record: (game, points) => {
    recordReviewedGame(userLevel, { startFen: game.startFen, moves: game.moves, userSide: game.userSide, provenance: "own" }, points);
    updateUserLevelControls();
  },
  // one tab at a time: the others wait (a browser without locks just runs)
  tryLock: () => navigator.locks
    ? new Promise<(() => void) | null>((resolve, reject) => {
      navigator.locks.request("xq-background-review", { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(null); return undefined; }
        return new Promise<void>((release) => resolve(() => release()));
      }).catch(reject);
    })
    : Promise.resolve(() => {}),
  onChange: () => queueMicrotask(render),
});
// another tab added or counted a game: take its version before this tab writes its own
window.addEventListener("storage", (event) => {
  if (event.key !== PLAYED_GAMES_STORAGE_KEY) return;
  playedGames.refresh();
  render();
});
void loadUserLevel();
let currentImportFormat: string | null = null;
let currentImportMetadata: Record<string, string> = {};
let currentImportWarnings: string[] = [];

const initialDifficulty = loadDifficulty(browserStorage());
const initialDevMode = loadDevMode(browserStorage());

app.innerHTML = `
  <div class="app-shell" data-route="play" data-dev="${initialDevMode ? "on" : "off"}">
    ${shellHeaderHtml()}
    <div class="page-intro" data-pages="settings">
      <div>
        <p class="eyebrow">${zhTW.previewLabel}</p>
        <p class="subtitle">${zhTW.appSubtitle}</p>
      </div>
      <p class="engine-notice">${zhTW.engineNotice}</p>
    </div>
    <main class="game-layout">
      <section class="board-panel" data-pages="play review" aria-label="${zhTW.boardLabel}">
        <p id="board-caption" class="board-caption">${zhTW.boardCaption}</p>
        <div class="board-frame"><svg id="board" viewBox="0 0 480 540" role="grid" aria-label="${zhTW.boardLabel}"></svg></div>
        <div id="branch-banner" class="branch-banner" data-pages="review" role="status" hidden>
          <p>${zhTW.review.trialBanner}</p>
          <button id="branch-back" type="button" class="secondary">${zhTW.review.trialBack}</button>
        </div>
        <ul id="review-legend" class="review-legend" data-pages="review" hidden>
          <li><span class="legend-swatch legend-played" aria-hidden="true"></span>${zhTW.review.focus.legend.played}</li>
          <li><span class="legend-swatch legend-best" aria-hidden="true"></span>${zhTW.review.focus.legend.best}</li>
          <li id="review-legend-danger"><span class="legend-swatch legend-danger" aria-hidden="true"></span>${zhTW.review.focus.legend.danger}</li>
        </ul>
      </section>
      <aside class="side-panel">
        <section id="review-focus" class="record-card review-focus" data-pages="review" aria-label="${zhTW.review.focus.region}"></section>
        <section class="turn-card" data-pages="play" aria-live="polite">
          <span class="turn-dot" aria-hidden="true"></span>
          <h2 id="turn-status"></h2>
          <p id="selection-status"></p>
        </section>
        <section id="game-over-card" class="record-card game-over-card" data-pages="play" aria-label="${zhTW.gameOver.title}" hidden>
          <h2>${zhTW.gameOver.title}</h2>
          <p id="game-over-result" class="game-over-result"></p>
          <p>${zhTW.gameOver.body}</p>
          <div class="actions">
            <button id="game-over-review" type="button">${zhTW.gameOver.review}</button>
            <button id="game-over-again" type="button" class="secondary">${zhTW.gameOver.again}</button>
          </div>
          <p id="game-over-bg-review" class="settings-note" role="status" hidden>${zhTW.review.backgroundReviewing}</p>
        </section>
        <div class="actions" data-pages="play review">
          <button id="undo" type="button">${zhTW.buttons.undo}</button>
          <button id="restart" type="button" class="secondary" data-pages="play">${zhTW.buttons.restart}</button>
        </div>
        <p id="undo-reason" class="undo-reason" data-pages="play review" hidden></p>
        <section class="record-card opponent-card" data-pages="play" aria-label="${zhTW.opponent.title}">
          <h2 id="opponent-title"></h2>
          <p id="opponent-hint">${zhTW.opponent.hint}</p>
          <p id="side-next-note" aria-live="polite" hidden></p>
          <p id="difficulty-status" aria-live="polite"></p>
        </section>
        <p id="game-message" class="game-message" data-pages="play review" role="status"></p>
        <section class="record-card" data-pages="play review">
          <div class="section-heading"><h2>${zhTW.historyTitle}</h2><span id="move-count"></span></div>
          <ol id="move-list" class="move-list"></ol>
        </section>
        <section class="record-card dev-info-card" data-pages="play review" data-dev-info aria-label="${zhTW.dev.title}">
          <h2>${zhTW.dev.title}</h2>
          <dl id="dev-info-lines" class="dev-info-lines"></dl>
          <div id="live-win-probability" role="meter" aria-label="${zhTW.live.label}" aria-valuemin="0" aria-valuemax="100" hidden>
            <span class="live-probability-fill"></span>
            <span class="live-probability-label">${zhTW.live.notAvailable}</span>
          </div>
        </section>
        <section class="review-launch" data-pages="review">
          <button id="start-review" type="button">${zhTW.review.start}</button>
        </section>
        <section id="review-warning" class="record-card review-warning" data-pages="review" role="alert" hidden>
          <p id="review-warning-text"></p>
          <div class="actions">
            <button id="review-warning-go" type="button">${zhTW.review.warnGo}</button>
            <button id="review-warning-faster" type="button" class="secondary">${zhTW.review.warnFaster}</button>
          </div>
        </section>
        <section id="review-panel" class="review-panel" data-pages="review" aria-label="${zhTW.review.title}" hidden></section>
        <section class="record-card library-card" data-pages="library" aria-label="${zhTW.library.title}">
          <div class="section-heading"><h2 id="library-title" tabindex="-1">${zhTW.library.title}</h2><button id="save-game" type="button">${zhTW.library.save}</button></div>
          <p id="game-library-status" role="status" aria-label="${zhTW.library.status}"></p>
          <ol id="game-library-list" class="move-list"></ol>
        </section>
        <div class="settings-page" data-pages="settings" data-category="play">
          <nav class="settings-nav" aria-label="${zhTW.settings.navLabel}">
            ${(Object.keys(zhTW.settings.categories) as Array<keyof typeof zhTW.settings.categories>).map((id) => `<button type="button" class="settings-category" data-settings-category="${id}" aria-pressed="${id === "play"}">${zhTW.settings.categories[id]}</button>`).join("")}
          </nav>
          <div id="settings-body" class="settings-body">
            <div data-settings-panel="play">
              <h2>${zhTW.settings.categories.play}</h2>
              <p class="settings-note">${zhTW.settings.playNote}</p>
        <section class="difficulty-card">
          <label for="difficulty-level">${zhTW.difficultyLabel}</label>
          <select id="difficulty-level" aria-describedby="difficulty-note">
            ${Array.from({ length: 10 }, (_, index) => {
              const value = index + 1;
              const selected = value === initialDifficulty ? " selected" : "";
              return `<option value="${value}"${selected}>${value}</option>`;
            }).join("")}
          </select>
          <p id="difficulty-note">${zhTW.difficultyNote}</p>
        </section>
        <section class="difficulty-card">
          <label for="user-side">${zhTW.userSide.label}</label>
          <select id="user-side" aria-describedby="user-side-note">
            <option value="red"${userSideSetting === "red" ? " selected" : ""}>${zhTW.userSide.red}</option>
            <option value="black"${userSideSetting === "black" ? " selected" : ""}>${zhTW.userSide.black}</option>
          </select>
          <p id="user-side-note">${zhTW.userSide.note}</p>
        </section>
            </div>
            <div data-settings-panel="review">
              <h2>${zhTW.settings.categories.review}</h2>
              <p class="settings-note">${zhTW.settings.reviewNote}</p>
              <section class="review-launch">
                <label for="review-budget">${zhTW.review.budget}</label>
                <select id="review-budget">
                  <option value="100000"${selectedBudget === 100_000 ? " selected" : ""}>${zhTW.review.budgetShort}</option>
                  <option value="1000000"${selectedBudget === 1_000_000 ? " selected" : ""}>${zhTW.review.budgetNormal}</option>
                  <option value="5000000"${selectedBudget === 5_000_000 ? " selected" : ""}>${zhTW.review.budgetHigh}</option>
                </select>
                <label for="review-perspective">${zhTW.review.perspective}</label>
                <select id="review-perspective">
                  <option value="red"${gameSide === "red" ? " selected" : ""}>${zhTW.review.perspectiveRed}</option>
                  <option value="black"${gameSide === "black" ? " selected" : ""}>${zhTW.review.perspectiveBlack}</option>
                </select>
              </section>
            </div>
            <div data-settings-panel="level">
              <h2>${zhTW.settings.categories.level}</h2>
        <section class="review-launch user-level">
          <label for="user-level">${zhTW.review.userLevel}</label>
          <select id="user-level">
            ${(["entry", "beginner", "intermediate", "proficient", "expert"] as const).map((name) => `<option value="${name}">${zhTW.review.levelNames[name]}</option>`).join("")}
          </select>
          <button id="user-level-reestimate" type="button" class="secondary">${zhTW.review.reestimate}</button>
          <p id="user-level-status" role="status"></p>
          <p id="played-count" class="settings-note" aria-live="off"></p>
        </section>
            </div>
            <div data-settings-panel="data">
              <h2>${zhTW.settings.categories.data}</h2>
              <p class="settings-note">${zhTW.settings.dataNote}</p>
        <section class="record-card import-card" aria-label="${zhTW.recordImport.title}">
          <label for="record-import-text">${zhTW.recordImport.paste}</label>
          <textarea id="record-import-text" rows="6" spellcheck="false"></textarea>
          <div class="actions"><button id="record-import-submit" type="button">${zhTW.recordImport.submit}</button>
            <button id="record-import-prefix" type="button" hidden>${zhTW.recordImport.adoptPrefix}</button></div>
          <p id="record-import-status" role="status" aria-label="${zhTW.recordImport.status}"></p>
        </section>
        <section class="record-card" aria-label="${zhTW.library.archiveTitle}">
          <div class="section-heading"><h2>${zhTW.library.archiveTitle}</h2></div>
          <p id="archive-status" role="status" aria-label="${zhTW.library.status}"></p>
          <div class="actions"><button id="archive-export" type="button">${zhTW.library.exportAll}</button>
            <label class="button secondary" for="archive-file">${zhTW.library.importAll}</label>
            <input id="archive-file" type="file" accept="application/json,.json" hidden></div>
        </section>
            </div>
            <div data-settings-panel="advanced">
              <h2>${zhTW.settings.categories.advanced}</h2>
              <p class="settings-note">${zhTW.settings.advancedNote}</p>
        <section class="live-evaluation-card">
          <label><input id="dev-mode-toggle" type="checkbox"${initialDevMode ? " checked" : ""}>${zhTW.dev.toggle}</label>
          <p class="dev-mode-note">${zhTW.dev.toggleNote}</p>
        </section>
        <section class="live-evaluation-card" data-dev-only>
          <label><input id="live-evaluation-toggle" type="checkbox">${zhTW.live.toggle}</label>
          <p id="live-assisted-status" hidden>${zhTW.live.assisted}</p>
        </section>
              <p id="review-engine-notice" class="review-engine-notice">${zhTW.review.externalEngineNotice}</p>
            </div>
          </div>
        </div>
      </aside>
    </main>
  </div>
`;

const svg = requiredElement(app.querySelector<SVGSVGElement>("#board"));
const turnStatus = requiredElement(app.querySelector<HTMLHeadingElement>("#turn-status"));
const turnDot = requiredElement(app.querySelector<HTMLSpanElement>(".turn-dot"));
const selectionStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#selection-status"));
const gameMessage = requiredElement(app.querySelector<HTMLParagraphElement>("#game-message"));
const moveList = requiredElement(app.querySelector<HTMLOListElement>("#move-list"));
const moveCount = requiredElement(app.querySelector<HTMLSpanElement>("#move-count"));
const gameLibraryList = requiredElement(app.querySelector<HTMLOListElement>("#game-library-list"));
const saveGameButton = requiredElement(app.querySelector<HTMLButtonElement>("#save-game"));
const gameLibraryStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#game-library-status"));
const archiveExportButton = requiredElement(app.querySelector<HTMLButtonElement>("#archive-export"));
const archiveFileInput = requiredElement(app.querySelector<HTMLInputElement>("#archive-file"));
const undoButton = requiredElement(app.querySelector<HTMLButtonElement>("#undo"));
const undoReasonElement = requiredElement(app.querySelector<HTMLParagraphElement>("#undo-reason"));
const reviewWarning = requiredElement(app.querySelector<HTMLElement>("#review-warning"));
const reviewWarningText = requiredElement(app.querySelector<HTMLParagraphElement>("#review-warning-text"));
const reviewWarningGo = requiredElement(app.querySelector<HTMLButtonElement>("#review-warning-go"));
const reviewWarningFaster = requiredElement(app.querySelector<HTMLButtonElement>("#review-warning-faster"));
const restartButton = requiredElement(app.querySelector<HTMLButtonElement>("#restart"));
const userSideSelect = requiredElement(app.querySelector<HTMLSelectElement>("#user-side"));
const boardCaption = requiredElement(app.querySelector<HTMLParagraphElement>("#board-caption"));
const sideNextNote = requiredElement(app.querySelector<HTMLParagraphElement>("#side-next-note"));
const archiveStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#archive-status"));
const settingsPage = requiredElement(app.querySelector<HTMLElement>(".settings-page"));
const opponentHint = requiredElement(app.querySelector<HTMLParagraphElement>("#opponent-hint"));
const gameOverResult = requiredElement(app.querySelector<HTMLParagraphElement>("#game-over-result"));
const difficultySelect = requiredElement(app.querySelector<HTMLSelectElement>("#difficulty-level"));
const opponentTitle = requiredElement(app.querySelector<HTMLHeadingElement>("#opponent-title"));
const gameOverCard = requiredElement(app.querySelector<HTMLElement>("#game-over-card"));
const gameOverReview = requiredElement(app.querySelector<HTMLButtonElement>("#game-over-review"));
const gameOverAgain = requiredElement(app.querySelector<HTMLButtonElement>("#game-over-again"));
const devModeToggle = requiredElement(app.querySelector<HTMLInputElement>("#dev-mode-toggle"));
const devInfoLines = requiredElement(app.querySelector<HTMLElement>("#dev-info-lines"));
const difficultyStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#difficulty-status"));
const liveEvaluationToggle = requiredElement(app.querySelector<HTMLInputElement>("#live-evaluation-toggle"));
const liveAssistedStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#live-assisted-status"));
const liveWinProbability = requiredElement(app.querySelector<HTMLDivElement>("#live-win-probability"));
const liveProbabilityFill = requiredElement(app.querySelector<HTMLSpanElement>(".live-probability-fill"));
const liveProbabilityLabel = requiredElement(app.querySelector<HTMLSpanElement>(".live-probability-label"));
const reviewPanel = requiredElement(app.querySelector<HTMLElement>("#review-panel"));
const reviewBudget = requiredElement(app.querySelector<HTMLSelectElement>("#review-budget"));
const reviewPerspective = requiredElement(app.querySelector<HTMLSelectElement>("#review-perspective"));
const userLevelSelect = requiredElement(app.querySelector<HTMLSelectElement>("#user-level"));
const userLevelReestimate = requiredElement(app.querySelector<HTMLButtonElement>("#user-level-reestimate"));
const userLevelStatus = requiredElement(app.querySelector<HTMLParagraphElement>("#user-level-status"));
const playedCountLine = requiredElement(app.querySelector<HTMLParagraphElement>("#played-count"));
const gameOverBgReview = requiredElement(app.querySelector<HTMLParagraphElement>("#game-over-bg-review"));
const reviewFocus = requiredElement(app.querySelector<HTMLElement>("#review-focus"));
const branchBanner = requiredElement(app.querySelector<HTMLElement>("#branch-banner"));
const branchBack = requiredElement(app.querySelector<HTMLButtonElement>("#branch-back"));
const reviewLegend = requiredElement(app.querySelector<HTMLElement>("#review-legend"));
const reviewLegendDanger = requiredElement(app.querySelector<HTMLElement>("#review-legend-danger"));
const startReviewButton = requiredElement(app.querySelector<HTMLButtonElement>("#start-review"));
const importText = requiredElement(app.querySelector<HTMLTextAreaElement>("#record-import-text"));
const importSubmitButton = requiredElement(app.querySelector<HTMLButtonElement>("#record-import-submit"));
const importPrefixButton = requiredElement(app.querySelector<HTMLButtonElement>("#record-import-prefix"));
const importStatusElement = requiredElement(app.querySelector<HTMLParagraphElement>("#record-import-status"));
const importClient = new RecordImportClient(new Worker(new URL("./record-import.worker.ts", import.meta.url), { type: "module" }));

const svgNamespace = "http://www.w3.org/2000/svg";
const boardLeft = 30;
const boardTop = 30;
const fileStep = 52.5;
const rankStep = 53.333333;
function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(svgNamespace, name);
}

function point(file: number, displayRow: number): [number, number] {
  return [boardLeft + file * fileStep, boardTop + displayRow * rankStep];
}

/** The side the board on screen belongs to: the saved game being looked at, or the game being played. */
function boardFlipped(): boolean {
  return isFlipped(gameSide);
}

/** Makes `side` the side of the game on the board; the review's win-rate view follows it until the user changes it. */
function setGameSide(side: UserSide): void {
  gameSide = side;
  reviewUserSide = side;
  reviewPerspective.value = side;
}

function persistVariationTree(): void {
  const moves = gameState.current?.history.map((record) => record.iccs) ?? [];
  const startFen = gameState.current?.startFen ?? STANDARD_START_FEN;
  const activeSavedGameId = gameLibrarySession.recordForMainline(moves, startFen);
  if (!variationTree || !activeSavedGameId) return;
  const saved = savedGames.find((game) => game.id === activeSavedGameId);
  if (!saved) return;
  const updated: SavedGame = { ...saved, variationTree: variationTree.toJSON() };
  void updateSavedGame(activeSavedGameId, (game) => ({ ...game, variationTree: updated.variationTree })).then((persisted) => {
    if (!persisted) return;
    savedGames = sortedGames(savedGames.map((game) => game.id === persisted.id ? persisted : game));
    libraryStatus = "";
    render();
  }).catch(() => {
    libraryStatus = zhTW.library.saveError;
    render();
  });
}

async function loadUserLevel(): Promise<void> {
  try {
    // BASE_URL keeps this working under the production sub-path (the preview E2E caught a 404 here).
    const wasmUrl = new URL(`${import.meta.env.BASE_URL}wasm/xq_wasm.js`, location.origin).href;
    const module = await import(/* @vite-ignore */ wasmUrl) as { default: () => Promise<unknown> } & LevelWasm;
    await module.default();
    let storage: Storage | null = null;
    try { storage = window.localStorage; } catch { storage = null; }
    userLevel = createUserLevel(module, storage);
    updateUserLevelControls();
    render();
  } catch {
    // Without the level module the page keeps the specified default (Beginner wording).
  }
}

function updateUserLevelControls(): void {
  userLevelSelect.disabled = userLevelReestimate.disabled = userLevel === null;
  if (!userLevel) {
    userLevelStatus.textContent = "";
    return;
  }
  const view = userLevel.view();
  userLevelSelect.value = view.level;
  userLevelStatus.textContent = zhTW.review.levelStatus(zhTW.review.levelNames[view.level] ?? view.level, view);
  userLevelStatus.dataset.level = view.level;
  userLevelStatus.dataset.displayed = String(view.displayed);
  userLevelStatus.dataset.manual = String(view.manual);
  userLevelStatus.dataset.gameCount = String(view.gameCount);
}

/** A game that just ended (the position before it was still going) goes into the ledger of played games. */
function trackFinishedGame(): void {
  const state = gameState.current;
  if (!state) return;
  const moves = state.history.map((record) => record.iccs);
  if (state.outcome === "ongoing") {
    ongoingSeen = currentSource === "played" && !reviewMode ? { startFen: state.startFen, moves } : null;
    return;
  }
  const before = ongoingSeen;
  ongoingSeen = null;
  if (!before || currentSource !== "played" || reviewMode || before.startFen !== state.startFen
    || moves.length <= before.moves.length || !before.moves.every((move, index) => moves[index] === move)) return;
  playedGames.add({
    key: reviewedGameKey({ startFen: state.startFen, moves, userSide: gameSide }),
    startFen: state.startFen, moves, userSide: gameSide, assisted: gameAssisted,
    budget: selectedBudget, finishedAt: Date.now(),
  });
}

/** Nothing else needs the machine: no game on the board that is still going, no review of the user's own running. */
function backgroundAllowedNow(): boolean {
  const state = gameState.current;
  return backgroundReviewAllowed({
    autoReviewOn, levelReady: userLevel !== null, levelManual: userLevel?.view().manual ?? false,
    hasState: state !== null, applyingImport, workerFailed,
    manualReviewRunning: reviewState?.status === "running",
    outcome: state?.outcome ?? "ongoing", historyLength: state?.history.length ?? 0, source: currentSource, reviewMode,
    computerPending: pending, computerSearching: searching, branchPending, branchSearching,
    liveEvaluationOn: liveEvaluationEnabled,
  });
}

function updatePlayedCount(): void {
  const games = playedGames.all();
  const counts = playedCounts(games);
  playedCountLine.textContent = userLevel ? playedCountText({
    played: counts.played, counted: countedGames(games), assisted: counts.assisted,
    manual: userLevel.view().manual, reviewing: backgroundReview.activeKey() !== null,
  }) : "";
  playedCountLine.dataset.bgState = backgroundReview.state();
  const key = gameState.current && gameState.current.outcome !== "ongoing"
    ? reviewedGameKey({ startFen: gameState.current.startFen, moves: gameState.current.history.map((record) => record.iccs), userSide: gameSide })
    : null;
  gameOverBgReview.hidden = key === null || backgroundReview.activeKey() !== key;
}

/** The foreground review finished: hand the level module this game's own data (never read later from the board). */
function observeForegroundReview(context: { startFen: string; moves: readonly string[] }, points: ReviewJobState["points"]): void {
  if (!userLevel) return;
  recordReviewedGame(userLevel, {
    startFen: context.startFen,
    moves: context.moves,
    userSide: gameSide,
    provenance: currentSource === "imported" ? "imported" : gameAssisted ? "assisted" : "own",
  }, points);
  // a review by hand counts the game too (the estimate takes each game once): the ledger need not run it again
  playedGames.markCounted(reviewedGameKey({ startFen: context.startFen, moves: context.moves, userSide: gameSide }));
  updateUserLevelControls();
}

async function replayBoards(startFen: string, moves: string[]): Promise<string[]> {
  const wasmUrl = new URL(`${import.meta.env.BASE_URL}wasm/xq_wasm.js`, location.origin).href;
  const module = await import(/* @vite-ignore */ wasmUrl) as {
    default: () => Promise<unknown>;
    WebGame: { from_fen(fen: string): { board(): string; play(move: string): boolean } };
  };
  await module.default();
  const game = module.WebGame.from_fen(startFen);
  const boards = [game.board()];
  for (const move of moves) {
    if (!game.play(move)) throw new Error("棋譜無法合法重播");
    boards.push(game.board());
  }
  return boards;
}

function noteInput(artifact: SavedReviewSnapshot) {
  const activeSavedGameId = gameLibrarySession.recordForMainline(artifact.moves, artifact.startFen);
  return createReviewNoteInput(artifact, {
    savedGames,
    activeSavedGameId,
    currentMetadata: currentImportMetadata,
    history: gameState.current?.history ?? [],
    currentTree: variationTree?.toJSON() ?? null,
  });
}

async function persistReviewArtifact(artifact: SavedReviewSnapshot, note: SavedReviewNote | null): Promise<void> {
  const id = gameLibrarySession.recordForMainline(artifact.moves, artifact.startFen);
  if (!id) return;
  const updated = await updateSavedGame(id, (game) => game.startFen === artifact.startFen
    && game.moves.join(" ") === artifact.moves.join(" ") ? { ...game, reviewSnapshot: artifact, reviewNote: note } : game);
  if (updated) savedGames = sortedGames(savedGames.map((game) => game.id === id ? updated : game));
}

async function createReviewNote(): Promise<void> {
  if (!reviewArtifact || reviewState?.status !== "complete" || reviewNoteBusy) return;
  const generation = ++reviewNoteGeneration;
  reviewNoteBusy = true;
  reviewNoteStatus = "";
  render();
  try {
    const input = noteInput(reviewArtifact);
    const document = generateReviewNote(input);
    if (generation !== reviewNoteGeneration || gameState.current?.startFen !== reviewArtifact.startFen
      || gameState.current.history.map((record) => record.iccs).join(" ") !== reviewArtifact.moves.join(" ")) return;
    reviewNote = { reportDate: reviewArtifact.reportDate, ...document };
    await persistReviewArtifact(reviewArtifact, reviewNote);
    reviewNoteStatus = zhTW.reviewNote.ready;
  } catch {
    reviewNoteStatus = zhTW.reviewNote.generateError;
  } finally {
    if (generation === reviewNoteGeneration) { reviewNoteBusy = false; render(); }
  }
}

function ensureVariationTree(moves: string[]): void {
  const startFen = gameState.current?.startFen ?? STANDARD_START_FEN;
  if (!variationTree || !variationTreeMatchesMainline(variationTree, moves, startFen)) {
    variationTree = createReviewVariationTree(moves, startFen);
  }
  branchNodeId = variationTree.selectedNodeId;
}

async function replayIsLegal(startFen: string, moves: string[]): Promise<boolean> {
  try { await replayBoards(startFen, moves); return true; } catch { return false; }
}

async function importArchiveFile(file: File): Promise<void> {
  try {
    const archive = await parseArchive(await file.text(), replayIsLegal);
    const summary = await importSavedGamesAtomically(archive.games, mergeArchiveGames);
    savedGames = sortedGames(await listSavedGames());
    libraryStatus = zhTW.library.archiveImported(summary.added, summary.skipped);
  } catch (error) {
    libraryStatus = zhTW.library.archiveError(error instanceof TypeError ? error.message : "棋局庫無法寫入。");
  }
  render();
}

function sortedGames(games: SavedGame[]): SavedGame[] {
  return [...games].sort((left, right) => right.savedAt - left.savedAt);
}

function reportDateInLocalTimezone(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function importSummary(result: RecordImportResult, adoptedPrefix = false): string {
  const parts: string[] = [];
  if (result.format) parts.push(zhTW.recordImport.summary(
    zhTW.recordImport.format(result.format),
    result.moves.length,
    result.isStandardStart,
  ));
  for (const warning of result.warnings) {
    if (warning === "variations_not_imported") parts.push(zhTW.recordImport.warningVariations);
  }
  if (result.errors.length) {
    const error = result.errors[0]!;
    parts.push(zhTW.recordImport.error(error.step, error.token, error.messageZh));
    if (result.moves.length && result.startFen) {
      parts.push(adoptedPrefix
        ? zhTW.recordImport.prefixLoaded(result.moves.length)
        : zhTW.recordImport.prefixOffer(result.moves.length));
    }
  } else if (!result.moves.length) {
    parts.push(zhTW.recordImport.noMoves);
  }
  return parts.join("；");
}

function applyImportedRecord(result: RecordImportResult, adoptedPrefix = false): void {
  if (applyingImport) return;
  if (!result.startFen || !result.moves.length) {
    importStatus = result.startFen ? zhTW.recordImport.noMoves : zhTW.recordImport.invalidRoot;
    render();
    return;
  }
  applyingImport = true;
  importStatus = zhTW.recordImport.loading;
  pendingImport = null;
  render();
  const started = sendCommand({ type: "load-review", startFen: result.startFen, moves: result.moves }, () => {
    resetReviewWorkspace();
    setGameSide("red");
    gameLibrarySession.reset();
    gameDifficulty = null;
    currentSource = "imported";
    currentImportFormat = result.format;
    currentImportMetadata = result.metadata;
    currentImportWarnings = result.warnings;
    variationTree = createReviewVariationTree(result.moves, result.startFen!);
    importStatus = importSummary(result, adoptedPrefix);
    pendingImport = null;
    applyingImport = false;
    requestLiveEvaluation();
    // a record pasted in settings is for looking at: take the player to the review page
    if (parseRoute(window.location.hash) === "settings") window.location.hash = buildHash("review");
  }, (error) => {
    if (!applyingImport) return;
    applyingImport = false;
    pendingImport = null;
    importStatus = zhTW.errors[error];
  }, true);
  if (!started) {
    applyingImport = false;
    importStatus = zhTW.recordImport.loadError;
    render();
  }
}

function invalidateImportIntent(positionChanged = false): void {
  if (applyingImport) return;
  importIntentGeneration += 1;
  if (positionChanged) importPositionVersion += 1;
  pendingImport = null;
  importStatus = "";
  importStatusElement.textContent = "";
  importPrefixButton.hidden = true;
}

async function loadGameLibrary(): Promise<void> {
  try {
    savedGames = await listSavedGames();
    libraryStatus = "";
  } catch {
    libraryStatus = zhTW.library.loadError;
  } finally {
    libraryReady = true;
    render();
  }
}

/**
 * After a refresh the stored game names the library entry it was saved as. Trust that only once the library is read
 * and the entry holds exactly the moves on the board; anything else means the board has moved on (or the entry is gone).
 */
function tryRestoreBinding(): void {
  const state = gameState.current;
  if (pendingBindingId === null || !libraryReady || !state || pending || applyingImport) return;
  const saved = savedGames.find((game) => game.id === pendingBindingId);
  const moves = state.history.map((entry) => entry.iccs);
  if (saved && saved.startFen === state.startFen && saved.moves.length === moves.length && saved.moves.every((move, index) => move === moves[index])) {
    gameLibrarySession.restore(saved.id, moves, state.startFen);
  }
  pendingBindingId = null;
}

/** Keeps the game on the board in localStorage, so a refresh brings back the same game (and the computer's move if it was thinking). */
function persistGameInProgress(): void {
  const state = gameState.current;
  if (!state || workerFailed || applyingImport) return;
  const record = {
    startFen: state.startFen,
    moves: state.history.map((entry) => entry.iccs),
    userSide: gameSide,
    difficulty: Number(difficultySelect.value),
    source: currentSource,
    importFormat: currentImportFormat,
    importMetadata: currentImportMetadata,
    importWarnings: currentImportWarnings,
    assisted: gameAssisted,
    libraryRecordId: gameLibrarySession.recordForMainline(state.history.map((entry) => entry.iccs), state.startFen) ?? pendingBindingId,
  };
  const key = JSON.stringify(record);
  if (key === persistedGameKey) return;
  persistedGameKey = key;
  saveGameInProgress(browserStorage(), record);
}

async function saveCurrentGame(): Promise<void> {
  const moves = gameState.current?.history.map((record) => record.iccs);
  if (applyingImport || !libraryReady || !moves?.length || pending || savingGame) return;
  const savedAt = Math.max(Date.now(), (savedGames[0]?.savedAt ?? 0) + 1);
  const { droppedNote, ...reviewFields } = reviewFieldsForSave(reviewArtifact, reviewNote, gameState.current?.startFen ?? STANDARD_START_FEN, moves);
  // saving the same game again updates its entry (and keeps review data this screen does not hold) instead of adding a copy
  const boundId = gameLibrarySession.recordForMainline(moves, gameState.current?.startFen ?? STANDARD_START_FEN);
  const sameGame = boundId ? savedGames.find((saved) => saved.id === boundId) ?? null : null;
  const difficulty = currentSource === "played" ? gameDifficulty ?? sameGame?.difficulty ?? null : null;
  const game: SavedGame = {
    id: sameGame?.id ?? crypto.randomUUID(),
    savedAt,
    moves,
    startFen: gameState.current?.startFen ?? STANDARD_START_FEN,
    source: currentSource,
    userSide: gameSide,
    ...(difficulty !== null ? { difficulty } : {}),
    outcome: (gameState.current?.outcome ?? "ongoing") satisfies SavedGameOutcome,
    importFormat: currentImportFormat,
    importMetadata: currentImportMetadata,
    importWarnings: currentImportWarnings,
    variationTree: variationTree
      ? snapshotForMainline(variationTree, moves, gameState.current?.startFen ?? STANDARD_START_FEN)
      : null,
    ...reviewFields,
  };
  if (sameGame) {
    game.reviewSnapshot ??= sameGame.reviewSnapshot;
    const sameReview = sameGame.reviewSnapshot !== null && sameGame.reviewSnapshot !== undefined
      && game.reviewSnapshot?.startFen === sameGame.reviewSnapshot.startFen
      && game.reviewSnapshot.moves.join(" ") === sameGame.reviewSnapshot.moves.join(" ");
    game.reviewNote ??= sameReview ? sameGame.reviewNote : null;
    game.variationTree ??= sameGame.variationTree;
  }
  savingGame = true;
  libraryStatus = "";
  render();
  try {
    await gameLibrarySession.saveAndBind(game, () => storeSavedGame(game));
    savedGames = sortedGames([game, ...savedGames.filter((saved) => saved.id !== game.id)]);
    libraryStatus = droppedNote ? zhTW.library.savedWithoutNote : zhTW.library.saved;
  } catch {
    libraryStatus = zhTW.library.saveError;
  } finally {
    savingGame = false;
    render();
  }
}

async function deleteLibraryGame(id: string, ordinal: number): Promise<void> {
  if (applyingImport || savingGame) return;
  pendingDeleteId = null;
  const at = savedGames.findIndex((saved) => saved.id === id);
  const neighbour = savedGames[at + 1] ?? savedGames[at - 1] ?? null;
  let deleted = false;
  try {
    await deleteSavedGame(id);
    savedGames = savedGames.filter((saved) => saved.id !== id);
    libraryStatus = zhTW.library.deleted(ordinal);
    deleted = true;
    // the deleted entry must not stay tied to the board (nor in the stored game kept for a refresh)
    if (gameLibrarySession.boundRecordId() === id) gameLibrarySession.reset();
    if (pendingBindingId === id) pendingBindingId = null;
  } catch {
    libraryStatus = zhTW.library.deleteError;
  }
  render();
  // the list was rebuilt: focus goes to the next game, else the previous one, else the heading
  const target = deleted
    ? (neighbour ? document.querySelector<HTMLElement>(`[data-library-id="${neighbour.id}"] .library-row`) : document.querySelector<HTMLElement>("#library-title"))
    : document.querySelector<HTMLElement>(`[data-library-id="${id}"] .library-delete`);
  target?.focus();
}

function restoreSavedGame(game: SavedGame): void {
  if (applyingImport) return;
  sendCommand({ type: "load-review", startFen: game.startFen, moves: game.moves }, () => {
    resetReviewWorkspace();
    setGameSide(savedGameUserSide(game));
    requestLiveEvaluation();
    gameLibrarySession.open(game);
    gameDifficulty = game.difficulty ?? null;
    currentSource = game.source;
    gameAssisted = false;
    currentImportFormat = game.importFormat;
    currentImportMetadata = game.importMetadata;
    currentImportWarnings = game.importWarnings;
    variationTree = null;
    if (game.variationTree) {
      try {
        const restored = parseReviewVariationTree(JSON.stringify(game.variationTree));
        if (variationTreeMatchesMainline(restored, game.moves, game.startFen)) variationTree = restored;
      } catch {
        variationTree = null;
      }
    }
    if (variationTree) branchNodeId = variationTree.selectedNodeId;
    if (game.reviewSnapshot && game.reviewSnapshot.startFen === game.startFen
      && game.reviewSnapshot.moves.join(" ") === game.moves.join(" ")
      && game.reviewSnapshot.points.length === game.moves.length
      && game.reviewSnapshot.boards.length === game.moves.length + 1) {
      reviewArtifact = game.reviewSnapshot;
      reviewNote = game.reviewNote ?? null;
      reviewMode = true;
      reviewPly = game.moves.length - 1;
      reviewState = { id: 0, status: "complete", points: game.reviewSnapshot.points };
    }
  });
}

function resetReviewWorkspace(): void {
  ongoingSeen = null;
  reviewWarningBudget = null;
  reviewClient?.dispose();
  reviewClient = null;
  branchClient?.dispose();
  branchClient = null;
  branchWorker = null;
  branchState = null;
  branchNoteDraft = null;
  branchProbability = null;
  branchGeneration += 1;
  branchPending = false;
  branchSearching = false;
  branchError = "";
  reviewMode = false;
  reviewState = null;
  activeReviewRun = null;
  reviewArtifact = null;
  reviewNote = null;
  reviewNoteStatus = "";
  reviewNoteBusy = false;
  reviewNoteGeneration += 1;
  reviewPly = null;
  selectedVariation = [];
  variationTree = null;
}

function createBranchClient(): void {
  if (branchClient) return;
  branchWorker = new Worker(new URL("./game.worker.ts", import.meta.url), { type: "module" });
  branchClient = new GameWorkerClient(branchWorker, () => {
    branchPending = false;
    branchSearching = false;
    branchError = zhTW.review.branchError;
    render();
  }, () => {
    branchSearching = true;
    render();
  }, (_requestId, result: LiveEvaluationEvent) => {
    branchProbability = {
      fen: result.fen,
      value: liveWinProbabilityForUser(result.scoreCentipawns, result.sideToMove, reviewUserSide),
      redValue: liveWinProbabilityForUser(result.scoreCentipawns, result.sideToMove, "red"),
      side: result.sideToMove,
    };
    render();
  });
}

function requestBranchEvaluation(): void {
  void branchClient?.request({ type: "evaluate" }).promise.catch(() => {});
}

function branchAnchorNode(nodeId: string): string {
  if (!variationTree) return "main-0";
  let node = variationTree.node(nodeId);
  // step cap: never loop forever on damaged parents (parse already refuses them)
  for (let steps = 0; node && !/^main-\d+$/.test(node.id) && steps < 100000; steps++) {
    node = node.parentId ? variationTree.node(node.parentId) : null;
  }
  return node?.id ?? "main-0";
}

async function loadBranchNode(nodeId: string): Promise<void> {
  if (applyingImport || !variationTree) return;
  const tree = variationTree;
  const path = tree.pathTo(nodeId);
  tree.select(nodeId);
  branchNodeId = nodeId;
  reviewPly = Number(branchAnchorNode(nodeId).slice("main-".length));
  persistVariationTree();
  createBranchClient();
  if (!branchClient) return;
  const generation = ++branchGeneration;
  branchPending = true;
  branchSearching = false;
  branchError = "";
  // a throwing render must not leave branchPending stuck: the load request is sent regardless
  try { render(); } catch (error) { console.error("render failed while loading a branch node", error); }
  const startFen = gameState.current?.startFen ?? STANDARD_START_FEN;
  const request = branchClient.request({ type: "load-review", startFen, moves: path });
  try {
    const response = await request.promise;
    if (generation !== branchGeneration) return;
    if (!response.ok) {
      branchError = zhTW.review.branchError;
      branchPending = false;
      render();
      return;
    }
    branchState = response.state;
    branchPending = false;
    branchSearching = false;
    render();
    requestBranchEvaluation();
  } catch {
    if (generation !== branchGeneration) return;
    branchError = zhTW.review.branchError;
    branchPending = false;
    branchSearching = false;
    render();
  }
}

function applyBranchMove(move: string): Promise<void> {
  return runBranchCommand({ type: "branch-move", move });
}

async function runBranchCommand(command: Extract<GameCommand, { type: "branch-move" | "branch-engine" }>): Promise<void> {
  if (applyingImport || !variationTree || !branchClient || !branchState || branchPending || branchSearching) return;
  const parentId = branchNodeId;
  const priorPath = variationTree.pathTo(parentId);
  const generation = ++branchGeneration;
  branchPending = true;
  branchSearching = false;
  branchError = "";
  render();
  const request = branchClient.request(command);
  try {
    const response = await request.promise;
    if (generation !== branchGeneration) return;
    if (!response.ok) {
      branchError = zhTW.review.branchError;
      branchPending = false;
      branchSearching = false;
      render();
      return;
    }
    let nextId = parentId;
    for (const record of response.state.history.slice(priorPath.length)) nextId = variationTree.append(nextId, record.iccs);
    if (command.type === "branch-move" && nextId !== parentId) {
      variationTree.markTurnStart(nextId, parentId);
    }
    variationTree.select(nextId);
    branchNodeId = nextId;
    reviewPly = Number(branchAnchorNode(nextId).slice("main-".length));
    branchState = response.state;
    branchPending = false;
    branchSearching = false;
    persistVariationTree();
    render();
    requestBranchEvaluation();
  } catch {
    if (generation !== branchGeneration) return;
    branchError = zhTW.review.branchError;
    branchPending = false;
    branchSearching = false;
    render();
  }
}

function clickBranchSquare(square: string, pieceSide: string | null): void {
  if (applyingImport || !branchState || branchPending || branchSearching || branchState.outcome !== "ongoing") return;
  const legalMoves = branchState.legalMoves.join(",");
  const destinations = selectedSquare ? legalDestinations(legalMoves, selectedSquare) : [];
  if (selectedSquare && destinations.includes(square)) {
    const move = `${selectedSquare}${square}`;
    invalidateImportIntent(true);
    selectedSquare = null;
    void applyBranchMove(move);
    return;
  }
  if (pieceSide === branchState.side && legalDestinations(legalMoves, square).length > 0) selectedSquare = square;
  else selectedSquare = null;
  render();
}

function renderVariationTree(): void {
  if (!variationTree) return;
  const section = document.createElement("section");
  section.id = "variation-tree";
  section.dataset.devOnly = "";
  section.setAttribute("aria-label", zhTW.review.variationTree);
  const title = document.createElement("h3");
  title.textContent = zhTW.review.variationTree;
  section.append(title);
  const tree = variationTree.toJSON();
  const list = document.createElement("ol");
  for (const node of tree.nodes) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.variationNode = node.id;
    button.disabled = applyingImport;
    const ply = node.id.startsWith("main-") ? Number(node.id.slice("main-".length)) : null;
    button.textContent = ply === 0
      ? zhTW.review.mainlineNode(0, "")
      : ply !== null
        ? zhTW.review.mainlineNode(ply, node.move ?? "")
        : zhTW.review.branchNode(node.move ?? "");
    button.setAttribute("aria-pressed", String(node.id === tree.selectedNodeId));
    button.addEventListener("click", () => {
      if (applyingImport) return;
      invalidateImportIntent(true);
      void loadBranchNode(node.id);
    });
    item.append(button);
    if (node.annotation) {
      const note = document.createElement("p");
      note.textContent = node.annotation;
      item.append(note);
    }
    list.append(item);
  }
  section.append(list);
  const noteInput = document.createElement("textarea");
  noteInput.setAttribute("aria-label", zhTW.review.branchNote);
  noteInput.disabled = applyingImport;
  noteInput.value = branchNoteDraft?.nodeId === tree.selectedNodeId
    ? branchNoteDraft.text
    : variationTree.node(tree.selectedNodeId)?.annotation ?? "";
  noteInput.addEventListener("input", () => {
    branchNoteDraft = { nodeId: tree.selectedNodeId, text: noteInput.value };
  });
  if (branchNoteFocused) queueMicrotask(() => noteInput.focus());
  const saveNote = document.createElement("button");
  saveNote.type = "button";
  saveNote.textContent = zhTW.review.saveNote;
  saveNote.disabled = applyingImport;
  saveNote.addEventListener("click", () => {
    if (applyingImport) return;
    variationTree?.annotate(tree.selectedNodeId, noteInput.value);
    branchNoteDraft = null;
    persistVariationTree();
    render();
  });
  section.append(noteInput, saveNote);
  const engineButton = document.createElement("button");
  engineButton.type = "button";
  engineButton.id = "branch-engine-play";
  engineButton.textContent = zhTW.review.branchEngineAuto;
  engineButton.disabled = applyingImport || branchPending || branchSearching || !branchState || branchState.outcome !== "ongoing";
  engineButton.addEventListener("click", () => {
    if (!applyingImport) void runBranchCommand({ type: "branch-engine", plies: 4 });
  });
  section.append(engineButton);
  if (branchProbability && branchState && branchProbability.fen === branchState.fen) {
    const meter = document.createElement("p");
    meter.id = "branch-win-probability";
    meter.dataset.fen = branchProbability.fen;
    meter.textContent = `${zhTW.review.branchWinProbability}・${(branchProbability.value * 100).toFixed(1)}%`;
    section.append(meter);
  }
  if (branchPending) {
    const progress = document.createElement("p");
    progress.textContent = zhTW.review.branchLoading;
    section.append(progress);
  } else if (branchSearching) {
    const progress = document.createElement("p");
    progress.textContent = zhTW.review.branchEngineThinking;
    section.append(progress);
  }
  if (branchError) {
    const error = document.createElement("p");
    error.setAttribute("role", "status");
    error.textContent = branchError;
    section.append(error);
  }
  reviewPanel.append(section);
}

function levelShows(classification: string): boolean {
  return userLevel?.shows(classification) ?? (classification === "mistake" || classification === "blunder" || classification === "missed_mate");
}

/** Plies (0-based) of the player's side that the key-move list shows for a finished or running review. */
function keyMoveList(points: ReviewWorkerPoint[], startFen: string, side: ReviewSide = reviewUserSide): number[] {
  return focusPoints(points.map((point) => point.final), plySides(startFen, points.length), side, levelShows);
}

function selectReviewPly(index: number): void {
  if (applyingImport) return;
  reviewPly = index;
  selectedVariation = [];
  const history = gameState.current?.history ?? [];
  if (!variationTree && history.length) ensureVariationTree(history.map((record) => record.iccs));
  if (variationTree) void loadBranchNode(variationTree.mainlineNodeId(index));
  render();
}

function librarySubtitle(game: SavedGame): string {
  const facts = libraryRowParts(game);
  const parts = [zhTW.library.date(game.savedAt), facts.result];
  if (facts.side) parts.push(facts.side);
  if (facts.difficulty) parts.push(facts.difficulty);
  const snapshot = game.reviewSnapshot;
  if (!snapshot || snapshot.points.length !== game.moves.length) {
    parts.push(zhTW.library.notReviewed);
  } else {
    const side = savedGameUserSide(game);
    parts.push(zhTW.library.reviewed);
    parts.push(zhTW.library.attention(side, keyMoveList(snapshot.points, game.startFen, side).length));
  }
  return parts.join("・");
}

function buildFocusModel(): FocusModel {
  const history = gameState.current?.history ?? [];
  const points = reviewState?.points ?? [];
  const startFen = gameState.current?.startFen ?? STANDARD_START_FEN;
  const list = keyMoveList(points, startFen);
  const focus = zhTW.review.focus;
  const nav = focusNav(list, reviewPly);
  const selected = reviewPly !== null && list.includes(reviewPly) ? reviewPly : null;
  const chips = list.map((index) => {
    const classification = points[index]!.final.classification;
    return {
      index,
      label: focus.chip(index + 1),
      ariaLabel: focus.chipLabel(index + 1, zhTW.review.classification(classification)),
      selected: index === selected,
      severity: classification === "blunder" || classification === "missed_mate" ? "high" : classification === "mistake" ? "mid" : "low",
    };
  });

  let card: FocusModel["card"] = null;
  if (selected !== null) {
    const final = points[selected]!.final;
    const record = history[selected];
    if (record) {
      const sideStep = history.slice(0, selected + 1).filter((entry) => entry.side === record.side).length;
      const follow = final.comparison ? focus.followUps(final.comparison) : null;
      card = {
        position: focus.position(selected + 1, record.side, sideStep, list.indexOf(selected) + 1, list.length),
        classification: zhTW.review.classification(final.classification),
        playedMove: record.notation,
        bestMove: follow?.bestMove ?? null,
        reason: final.reason ? zhTW.review.reason(final.reason, userLevel?.voice() ?? "beginner") : null,
        playedFollow: follow?.played ?? null,
        bestFollow: follow?.best ?? null,
      };
    }
  }

  const kinds = new Map<string, number>();
  for (const index of list) {
    const kind = points[index]!.final.reason?.kind;
    if (kind) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  let topKind: string | null = null;
  for (const [kind, count] of kinds) if (topKind === null || count > (kinds.get(topKind) ?? 0)) topKind = kind;

  const running = reviewState?.status === "running";
  return {
    summary: points.length === 0 ? focus.empty : focus.summary(reviewUserSide, list.length),
    note: points.length === 0 ? focus.waiting : running ? focus.running : null,
    chips,
    hint: list.length > 0 && selected === null ? focus.pick : null,
    card,
    nav,
    nextTime: !running && topKind ? focus.advice[topKind] ?? null : null,
  };
}

function renderFocus(): void {
  renderReviewFocus(reviewFocus, buildFocusModel(), { select: selectReviewPly }, applyingImport);
}

/** Arrows for the key move on screen, only while the board shows the position right before that move. */
function drawFocusOverlay(): void {
  reviewLegend.hidden = true;
  const points = reviewState?.points ?? [];
  const history = gameState.current?.history ?? [];
  if (!reviewMode || reviewPly === null || !branchState || branchPending || branchNodeId !== `main-${reviewPly}`) return;
  // the board must already be the position before that move (the branch worker answers a moment after the node is chosen)
  if (branchState.history.length !== reviewPly) return;
  const point = points[reviewPly]?.final;
  const record = history[reviewPly];
  if (!point || !record || !keyMoveList(points, gameState.current?.startFen ?? STANDARD_START_FEN).includes(reviewPly)) return;
  const plan = buildArrowPlan({
    playedMove: record.iccs,
    bestMove: point.bestMove,
    reason: point.reason,
    mover: branchState.side,
    board: branchState.board,
  });
  drawReviewOverlay(svg, plan, squareCentre);
  reviewLegend.hidden = !(plan.played || plan.best);
  reviewLegendDanger.hidden = plan.danger.length === 0;
}

function squareCentre(square: string): [number, number] {
  const placement = boardPlacement(square, boardFlipped());
  return point(placement.file, placement.row);
}

function renderReviewPanel(): void {
  const history = gameState.current?.history ?? [];
  const job = reviewState;
  reviewPanel.hidden = !reviewMode;
  document.querySelector<HTMLElement>(".app-shell")!.dataset.reviewing = String(reviewMode);
  startReviewButton.disabled = applyingImport || history.length === 0 || pending || workerFailed;
  reviewBudget.disabled = applyingImport || job?.status === "running";
  if (!reviewMode) return;
  reviewPanel.dataset.lastStepDurationMs = String(job?.lastStepDurationMs ?? "");
  reviewPanel.dataset.cancelLatencyMs = String(job?.cancelLatencyMs ?? "");
  reviewPanel.dataset.reviewWorkers = String(job?.workerCount ?? "");
  reviewPanel.dataset.reviewActiveWorkers = String(job?.activeWorkers ?? "");
  reviewPanel.dataset.reviewCachedPlies = String(job?.cachedPlies ?? 0);
  reviewPanel.dataset.userSide = reviewUserSide;
  branchNoteFocused = document.activeElement instanceof HTMLTextAreaElement
    && reviewPanel.contains(document.activeElement)
    && document.activeElement.getAttribute("aria-label") === zhTW.review.branchNote;
  reviewPanel.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "section-heading";
  const title = document.createElement("h2");
  title.textContent = zhTW.review.title;
  const engine = document.createElement("span");
  engine.textContent = zhTW.review.engine;
  engine.dataset.devOnly = "";
  heading.append(title, engine);
  reviewPanel.append(heading);

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = job?.status === "running"
    ? zhTW.review.progress(job.points.length, history.length)
    : job?.status === "complete" ? zhTW.review.complete
      : job?.status === "cancelled" ? zhTW.review.cancelled
        : job?.status === "failed" ? zhTW.review.failed : zhTW.review.noPoints;
  reviewPanel.append(status);
  if (job?.status === "running" && reviewRunIsWholeGame) {
    const left = remainingSeconds({
      done: job.points.length, cached: job.cachedPlies ?? 0, total: history.length, elapsedMs: performance.now() - reviewStartedAt,
    });
    const eta = document.createElement("p");
    eta.id = "review-eta";
    eta.setAttribute("role", "status");
    eta.textContent = zhTW.review.eta(left === null ? zhTW.review.etaPending : zhTW.review.duration(left));
    reviewPanel.append(eta);
  }
  if (job?.cachedPlies) {
    const cacheNote = document.createElement("p");
    cacheNote.className = "review-cache-note";
    cacheNote.dataset.devOnly = "";
    cacheNote.textContent = zhTW.review.fromCache(job.cachedPlies);
    reviewPanel.append(cacheNote);
  }

  const points = job?.points ?? [];
  const chart = document.createElementNS(svgNamespace, "svg");
  chart.setAttribute("viewBox", `0 0 ${Math.max(320, points.length * 42)} 104`);
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", zhTW.review.curve);
  chart.classList.add("review-chart");
  if (points.length) {
    const coords = points.map((entry, index) => {
      const moverSide = history[index]?.side ?? "red";
      const probability = winProbabilityForUser(entry.final.playedWinProbability, moverSide, reviewUserSide);
      return `${24 + index * 42},${88 - probability * 72}`;
    }).join(" ");
    const line = svgElement("polyline");
    line.setAttribute("points", coords);
    line.setAttribute("class", "review-curve");
    chart.append(line);
    points.forEach((entry, index) => {
      const circle = svgElement("circle");
      circle.setAttribute("cx", String(24 + index * 42));
      const moverSide = history[index]?.side ?? "red";
      const userProbability = winProbabilityForUser(entry.final.playedWinProbability, moverSide, reviewUserSide);
      circle.setAttribute("cy", String(88 - userProbability * 72));
      circle.setAttribute("r", "8");
      circle.setAttribute("tabindex", "0");
      circle.setAttribute("role", "button");
      circle.setAttribute("aria-disabled", String(applyingImport));
      const classification = entry.final.classification;
      const classificationMarked = classification !== "good" && classification !== "unclassified"
        && (userLevel?.shows(classification) ?? (classification === "mistake" || classification === "blunder" || classification === "missed_mate"));
      const classificationLabel = zhTW.review.classification(classification);
      circle.setAttribute("aria-label", classificationMarked
        ? `${zhTW.review.ply(index + 1)}・${classificationLabel}`
        : zhTW.review.ply(index + 1));
      circle.setAttribute("data-review-point", String(index));
      circle.setAttribute("data-review-user-win-probability", String(userProbability));
      circle.setAttribute("data-review-classification", classification);
      circle.classList.add("review-point");
      if (classificationMarked) circle.classList.add("review-point-marked");
      if ((reviewPly ?? points.length - 1) === index) circle.classList.add("review-point-selected");
      circle.addEventListener("click", () => selectReviewPly(index));
      chart.append(circle);
    });
  }
  reviewPanel.append(chart);

  const result = reviewPly === null ? points.at(-1) : points[reviewPly];
  reviewPanel.dataset.continuationComplete = String(result?.continuationComplete ?? false);
  if (result) {
    const pointLabel = document.createElement("p");
    const selectedIndex = reviewPly ?? points.length - 1;
    const moverSide = history[selectedIndex]?.side ?? "red";
    const userProbability = winProbabilityForUser(result.final.playedWinProbability, moverSide, reviewUserSide);
    const classification = result.final.classification;
    const classificationText = classification === "good" || classification === "unclassified"
      ? ""
      : `・${zhTW.review.classification(classification)}`;
    pointLabel.textContent = `${zhTW.review.ply(selectedIndex + 1)}・${(userProbability * 100).toFixed(1)}%・${result.final.lossPercent.toFixed(1)}%${classificationText}`;
    pointLabel.dataset.devOnly = "";
    reviewPanel.append(pointLabel);
    if (result.final.reason) {
      const reasonElement = createReviewReasonElement(result.final.reason, userLevel?.voice() ?? "beginner");
      reasonElement.dataset.devOnly = ""; // the key-move card says it once for everyone
      reviewPanel.append(reasonElement);
    }
    const comparisonElement = createReviewComparisonElement(result.final.comparison);
    if (comparisonElement) {
      comparisonElement.dataset.devOnly = "";
      reviewPanel.append(comparisonElement);
    }
    const candidates = document.createElement("ol");
    candidates.className = "candidate-lines";
    candidates.dataset.devOnly = "";
    for (const candidate of result.final.candidates.slice(0, 3)) {
      const item = document.createElement("li");
      const summary = document.createElement("p");
      summary.textContent = zhTW.review.pv(candidate.move, candidate.score.centipawns, candidate.depth, candidate.pv.length, candidate.pvEnd);
      item.append(summary);
      const pv = document.createElement("div");
      pv.dataset.pvLine = "";
      pv.dataset.pvLength = String(candidate.pv.length);
      pv.dataset.pvEnd = candidate.pvEnd;
      pv.dataset.pvDepth = String(candidate.depth);
      pv.dataset.pvNodes = String(candidate.nodes);
      pv.dataset.pvReplayAudit = JSON.stringify(candidate.replayAudit);
      pv.textContent = candidate.pv.join(" ") || zhTW.review.terminal;
      item.append(pv);
      const continuation = document.createElement("div");
      continuation.dataset.pvContinuation = "";
      continuation.dataset.pvContinuationLength = String(candidate.continuation.length);
      continuation.dataset.pvContinuationNodeLimit = String(candidate.continuationNodeLimit);
      continuation.dataset.pvContinuationTerminal = String(candidate.continuationTerminal);
      continuation.dataset.pvContinuationStatus = candidate.continuationStatus;
      continuation.dataset.pvContinuationDepths = candidate.continuation.map((segment) => segment.depth).join(",");
      continuation.dataset.pvContinuationMoves = JSON.stringify(candidate.continuation.map((segment) => segment.move));
      continuation.textContent = zhTW.review.continuation(candidate.continuation.length, candidate.continuationNodeLimit)
        + `（${zhTW.review.continuationStatus(candidate.continuationStatus)}）`
        + (candidate.continuation.length
          ? `：${candidate.continuation.map((segment) => segment.move).join(" ")}`
          : `：${candidate.continuationTerminal ? zhTW.review.continuationTerminal : zhTW.review.noContinuation}`);
      item.append(continuation);
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = zhTW.review.selectLine;
      select.setAttribute("aria-label", `${zhTW.review.selectLine} ${candidate.move}`);
      const replayable = candidate.replayAudit.failedIndex === null
        && !["invalid_pv", "invalid_continuation", "no_result", "cancelled"].includes(candidate.continuationStatus);
      const enoughPlies = candidate.pv.length + candidate.continuation.length >= 6 || candidate.continuationTerminal;
      select.disabled = !(replayable && enoughPlies && result?.continuationComplete);
      select.disabled ||= applyingImport;
      select.addEventListener("click", () => {
        if (applyingImport) return;
        selectedVariation = [...candidate.pv, ...candidate.continuation.map((segment) => segment.move)];
        if (variationTree) {
          let nodeId = variationTree.mainlineNodeId(reviewPly ?? 0);
          for (const move of selectedVariation) nodeId = variationTree.append(nodeId, move);
          void loadBranchNode(nodeId);
        }
        render();
      });
      item.append(select);
      candidates.append(item);
    }
    reviewPanel.append(candidates);
  }

  const actions = document.createElement("div");
  actions.className = "review-actions";
  const addAction = (label: string, action: () => void, disabled = false, allowDuringImport = false, devOnly = false): void => {
    const button = document.createElement("button");
    if (devOnly) button.dataset.devOnly = "";
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled || (applyingImport && !allowDuringImport);
    button.addEventListener("click", () => {
      if (applyingImport && !allowDuringImport) return;
      action();
    });
    actions.append(button);
  };
  if (job?.status === "running") addAction(zhTW.review.cancel, () => reviewClient?.cancel(), false, true);
  else if (history.length) {
    addAction(job?.status ? zhTW.review.restart : zhTW.review.start, requestReviewStart);
    if (result) {
      const selectedIndex = reviewPly ?? points.length - 1;
      addAction(zhTW.review.deepen, () => startReview(deepNodeLimit(selectedBudget), selectedIndex), false, false, true);
    }
  }
  if (selectedVariation.length) {
    const chosen = document.createElement("p");
    chosen.textContent = `${zhTW.review.selectedLine}：${selectedVariation.join(" ")}`;
    chosen.dataset.devOnly = "";
    reviewPanel.append(chosen);
  }
  if (job?.status === "running") {
    const noteStatus = document.createElement("p");
    noteStatus.setAttribute("role", "status");
    noteStatus.textContent = zhTW.reviewNote.incomplete;
    actions.append(noteStatus);
  } else if (job?.status === "complete" && reviewArtifact) {
    addAction(reviewNoteBusy ? zhTW.reviewNote.generating : zhTW.reviewNote.generate, () => { void createReviewNote(); }, reviewNoteBusy, false);
    addAction(zhTW.reviewNote.savePdf, saveReviewPdf, false, false);
    if (reviewNote) {
      const preview = document.createElement("pre");
      preview.id = "review-note-preview";
      preview.textContent = reviewNote.markdown;
      reviewPanel.append(preview);
      addAction(zhTW.reviewNote.copy, () => {
        void navigator.clipboard.writeText(reviewNote!.plainText).then(() => { reviewNoteStatus = zhTW.reviewNote.copied; render(); })
          .catch(() => { reviewNoteStatus = zhTW.reviewNote.copyError; render(); });
      }, false, false);
      addAction(zhTW.reviewNote.downloadMarkdown, () => downloadReviewFile(reviewNote!.markdown, "覆盤筆記.md", "text/markdown;charset=utf-8"), false, false);
    }
  }
  if (reviewNoteStatus) {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = reviewNoteStatus;
    actions.append(status);
  }
  renderVariationTree();
  reviewPanel.append(actions);
}

/** 存成 PDF: the browser's own print dialog, fed the player-facing report (choose "Save as PDF" there). */
function saveReviewPdf(): void {
  if (!reviewArtifact) return;
  try {
    // The report is about the side the game was played from (gameSide), whatever the perspective menu shows;
    // its key moves are the page's own list (same level filter).
    printHtmlDocument(buildReviewPrintHtml(noteInput(reviewArtifact), { userSide: gameSide, shows: levelShows }), {
      onFallback: () => { reviewNoteStatus = zhTW.reviewNote.pdfFallback; render(); },
      onFailure: () => { reviewNoteStatus = zhTW.reviewNote.pdfError; render(); },
    });
  } catch {
    reviewNoteStatus = zhTW.reviewNote.pdfError;
    render();
  }
}

function downloadReviewFile(contents: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function drawGrid(): void {
  svg.replaceChildren();
  const paper = svgElement("rect");
  paper.setAttribute("class", "board-paper");
  paper.setAttribute("x", "4");
  paper.setAttribute("y", "4");
  paper.setAttribute("width", "472");
  paper.setAttribute("height", "532");
  paper.setAttribute("rx", "12");
  svg.append(paper);

  for (let row = 0; row < 10; row += 1) {
    const [x1, y] = point(0, row);
    const [x2] = point(8, row);
    const line = svgElement("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "board-line");
    svg.append(line);
  }

  for (let file = 0; file < 9; file += 1) {
    const [x] = point(file, 0);
    const [, riverTop] = point(0, 4);
    const [, riverBottom] = point(0, 5);
    const segments: Array<[number, number]> =
      file === 0 || file === 8
        ? [[boardTop, point(0, 9)[1]]]
        : [[boardTop, riverTop], [riverBottom, point(0, 9)[1]]];
    for (const [y1, y2] of segments) {
      const line = svgElement("line");
      line.setAttribute("x1", String(x));
      line.setAttribute("x2", String(x));
      line.setAttribute("y1", String(y1));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "board-line");
      svg.append(line);
    }
  }

  for (const [topRow, bottomRow] of [[0, 2], [7, 9]]) {
    for (const [[fromFile, fromRow], [toFile, toRow]] of [
      [[3, topRow], [5, bottomRow]],
      [[5, topRow], [3, bottomRow]],
    ] as const) {
      const [x1, y1] = point(fromFile, fromRow);
      const [x2, y2] = point(toFile, toRow);
      const line = svgElement("line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y1", String(y1));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "board-line");
      svg.append(line);
    }
  }

  const redBank = svgElement("text");
  redBank.setAttribute("x", boardFlipped() ? "320" : "160");
  redBank.setAttribute("y", "278");
  redBank.setAttribute("class", "river-label red-river");
  redBank.textContent = zhTW.river.redBank;
  svg.append(redBank);
  const blackBank = svgElement("text");
  blackBank.setAttribute("x", boardFlipped() ? "160" : "320");
  blackBank.setAttribute("y", "278");
  blackBank.setAttribute("class", "river-label black-river");
  blackBank.textContent = zhTW.river.blackBank;
  svg.append(blackBank);
}

function render(): void {
  const state = gameState.current;
  const boardState = reviewMode && branchState ? branchState : state;
  const cells = boardState ? boardCells(boardState.board) : [];
  const side = boardState?.side;
  const outcome = boardState?.outcome;
  const lastMove = reviewMode ? branchState?.lastMove ?? "" : state?.lastMove ?? "";
  const destinations = selectedSquare && boardState
    ? legalDestinations(boardState.legalMoves.join(","), selectedSquare)
    : [];

  tryRestoreBinding();
  persistGameInProgress();
  saveGameButton.disabled = applyingImport || pending || savingGame || !libraryReady || !state?.history.length;
  gameLibraryStatus.textContent = libraryStatus;
  archiveStatus.textContent = libraryStatus;
  importStatusElement.textContent = importStatus;
  importText.disabled = applyingImport;
  importSubmitButton.disabled = applyingImport;
  importPrefixButton.hidden = !(pendingImport?.errors.length && pendingImport.moves.length && pendingImport.startFen);
  importPrefixButton.disabled = applyingImport;
  gameLibraryList.replaceChildren();
  if (!savedGames.length) {
    const empty = document.createElement("li");
    empty.className = "empty-record";
    empty.textContent = zhTW.library.empty;
    gameLibraryList.append(empty);
  } else {
    savedGames.forEach((savedGame, index) => {
      const row = document.createElement("li");
      row.className = "library-item";
      row.dataset.libraryId = savedGame.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "library-row";
      open.disabled = applyingImport;
      const title = document.createElement("span");
      title.className = "library-title";
      title.textContent = zhTW.library.open(index + 1, savedGame.moves.length, savedGame.source);
      const subtitle = document.createElement("span");
      subtitle.className = "library-sub";
      subtitle.textContent = librarySubtitle(savedGame);
      const go = document.createElement("span");
      go.className = "library-go";
      go.textContent = zhTW.library.viewReview;
      open.append(title, subtitle, go);
      open.addEventListener("click", () => {
        if (applyingImport) return;
        invalidateImportIntent(true);
        restoreSavedGame(savedGame);
        // from the library page "看覆盤" goes straight to the review page; elsewhere the list only loads the game
        if (parseRoute(window.location.hash) === "library") window.location.hash = buildHash("review");
      });
      row.append(open);
      // a role="button" element, not a <button>: the list's buttons are the games themselves
      const remove = document.createElement("span");
      remove.className = "library-delete";
      remove.setAttribute("role", "button");
      remove.setAttribute("tabindex", "0");
      remove.setAttribute("aria-label", zhTW.library.deleteLabel(index + 1));
      remove.setAttribute("aria-disabled", String(applyingImport || savingGame));
      remove.textContent = zhTW.library.delete;
      const askDelete = (): void => {
        if (applyingImport || savingGame) return;
        pendingDeleteId = savedGame.id;
        render();
        document.querySelector<HTMLElement>("#library-delete-confirm .library-delete-no")?.focus(); // the safe choice
      };
      const cancelDelete = (): void => {
        pendingDeleteId = null;
        render();
        document.querySelector<HTMLElement>(`[data-library-id="${savedGame.id}"] .library-delete`)?.focus();
      };
      remove.addEventListener("click", askDelete);
      // Enter acts on keydown, like a button. Space acts on keyup, and only if its keydown was on this control:
      // asking moves focus to 先不要, so a keydown trigger would let the same key's keyup land there
      let spaceDownHere = false;
      remove.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); askDelete(); }
        else if (event.key === " ") { event.preventDefault(); spaceDownHere = true; }
      });
      remove.addEventListener("keyup", (event) => {
        if (event.key !== " " || !spaceDownHere) return;
        spaceDownHere = false;
        event.preventDefault();
        askDelete();
      });
      remove.addEventListener("blur", () => { spaceDownHere = false; });
      row.append(remove);
      if (pendingDeleteId === savedGame.id) {
        const confirmBar = document.createElement("div");
        confirmBar.id = "library-delete-confirm";
        confirmBar.className = "library-delete-confirm";
        confirmBar.setAttribute("role", "alertdialog");
        confirmBar.setAttribute("aria-labelledby", "library-delete-question");
        confirmBar.addEventListener("keydown", (event) => { if (event.key === "Escape") cancelDelete(); });
        const question = document.createElement("p");
        question.id = "library-delete-question";
        question.textContent = zhTW.library.deleteConfirm(index + 1);
        const yes = document.createElement("button");
        yes.type = "button";
        yes.textContent = zhTW.library.deleteYes;
        yes.disabled = applyingImport || savingGame;
        yes.addEventListener("click", () => { void deleteLibraryGame(savedGame.id, index + 1); });
        const no = document.createElement("button");
        no.type = "button";
        no.className = "secondary library-delete-no";
        no.textContent = zhTW.library.deleteNo;
        no.addEventListener("click", cancelDelete);
        confirmBar.append(question, yes, no);
        row.append(confirmBar);
      }
      gameLibraryList.append(row);
    });
  }

  svg.setAttribute("data-user-side", gameSide);
  svg.setAttribute("data-flipped", String(boardFlipped()));
  svg.setAttribute("aria-label", boardFlipped() ? zhTW.boardLabelBlack : zhTW.boardLabel);
  boardCaption.textContent = boardFlipped() ? zhTW.boardCaptionBlack : zhTW.boardCaption;
  sideNextNote.hidden = userSideSetting === gameSide;
  sideNextNote.textContent = userSideSetting === gameSide ? "" : zhTW.opponent.nextSide[userSideSetting];
  opponentHint.textContent = gameSide === "black" ? zhTW.opponent.hintBlack : zhTW.opponent.hint;
  userSideSelect.value = userSideSetting;
  if (boardState) svg.setAttribute("data-fen", boardState.fen);
  else svg.removeAttribute("data-fen");
  const boardDisabled = applyingImport || workerFailed
    || (reviewMode ? !branchState || branchPending || branchSearching : parseRoute(window.location.hash) === "review");
  svg.setAttribute("aria-disabled", String(boardDisabled));
  svg.classList.toggle("board-disabled", boardDisabled);
  turnStatus.textContent = !boardState
    ? (workerFailed ? zhTW.workerStateUnknown : gameError ? zhTW.errors.initializationFailed : zhTW.loading)
    : workerFailed
      ? zhTW.workerStateUnknown
    : outcome === "ongoing"
    ? zhTW.turn[side === "black" ? "black" : "red"]
    : zhTW.outcome[outcome as keyof typeof zhTW.outcome];
  turnDot.className = `turn-dot turn-dot-${workerFailed ? "neutral" : side ?? "neutral"}`;
  selectionStatus.textContent = workerFailed
    ? zhTW.workerInterrupted
    : boardState && outcome !== "ongoing"
    ? zhTW.gameEndedHint
    : selectedSquare
    ? zhTW.destinationHint.replace("{square}", selectedSquare)
    : boardState ? zhTW.selectionHint : zhTW.loading;
  gameMessage.textContent = workerFailed ? zhTW.errors.workerFailed : searching ? zhTW.searching : gameError;
  renderLiveProbability();
  difficultySelect.disabled = applyingImport || workerFailed || pending;
  liveEvaluationToggle.disabled = applyingImport || workerFailed || pending;
  reviewPerspective.disabled = applyingImport;
  opponentTitle.textContent = zhTW.opponent.title(Number(difficultySelect.value));
  // a move tried on the reviewed board lives in the variation tree: say so, and offer the way back to the game
  branchBanner.hidden = !(reviewMode && branchState && !/^main-\d+$/.test(branchNodeId));
  branchBack.disabled = applyingImport || branchPending || branchSearching;
  gameOverCard.hidden = !state || state.outcome === "ongoing" || reviewMode || workerFailed;
  trackFinishedGame();
  backgroundReview.sync(backgroundAllowedNow());
  updatePlayedCount();
  const myResult = state ? resultForUser(state.outcome, gameSide) : null;
  gameOverResult.textContent = myResult ? zhTW.gameOver.result[myResult] : "";
  gameOverCard.dataset.result = myResult ?? "";
  renderDevInfo(state);
  difficultyStatus.textContent = state?.lastAiLevel
    ? zhTW.engineDifficultyStatus(state.lastAiLevel)
    : "";
  // on the review page, before a review starts, undo would take the reviewed game apart: keep it off
  const undoWouldEditReviewedGame = !reviewMode && parseRoute(window.location.hash) === "review";
  const undoReason = undoDisabledReason({
    applyingImport, workerFailed, hasState: state !== null, pending, searching,
    reviewPageLocked: undoWouldEditReviewedGame, planKind: currentUndoPlan().kind, reviewMode,
    branchBusy: branchPending || branchSearching || branchState === null,
  });
  undoButton.disabled = undoReason !== null;
  undoReasonElement.hidden = undoReason === null;
  undoReasonElement.textContent = undoReason ? zhTW.undoReason[undoReason] : "";
  if (undoReason) {
    undoButton.setAttribute("title", zhTW.undoReason[undoReason]);
    undoButton.setAttribute("aria-describedby", "undo-reason");
  } else {
    undoButton.removeAttribute("title");
    undoButton.removeAttribute("aria-describedby");
  }
  reviewWarning.hidden = reviewWarningBudget === null;
  if (reviewWarningBudget !== null) {
    reviewWarningText.textContent = zhTW.review.longWarning(
      state?.history.length ?? 0,
      reviewBudgetLabel(reviewWarningBudget),
      zhTW.review.duration(reviewWarningSeconds),
    );
    reviewWarningFaster.hidden = reviewWarningBudget <= REVIEW_BUDGETS[0];
    reviewWarningGo.disabled = reviewWarningFaster.disabled = applyingImport;
  }
  restartButton.textContent = workerFailed ? zhTW.buttons.reloadNewGame : zhTW.buttons.restart;
  restartButton.disabled = applyingImport;

  // The board, the review panel and the key-move card are only drawn while one of the two pages that show
  // them is open; coming back to the page runs render() again (hashchange).
  const route = parseRoute(window.location.hash);
  if (route !== "play" && route !== "review") {
    // Controls that live on the settings page must not go stale while that page is the one open.
    reviewBudget.disabled = applyingImport || reviewState?.status === "running";
    renderMoveList(state);
    return;
  }
  drawGrid();
  if (!state) {
    moveCount.textContent = `0 ${zhTW.moveCountSuffix}`;
    const loading = document.createElement("li");
    loading.className = "empty-record";
    loading.textContent = gameError || zhTW.loading;
    moveList.replaceChildren(loading);
    return;
  }

  for (const cell of cells) {
    const placement = boardPlacement(cell.square, boardFlipped());
    const [x, y] = point(placement.file, placement.row);
    const group = svgElement("g");
    group.setAttribute("class", "board-cell");
    group.setAttribute("role", "button");
    group.setAttribute("tabindex", "0");
    group.setAttribute("data-square", cell.square);
    group.setAttribute("aria-label", zhTW.aria.square(cell.square, cell.label));
    group.setAttribute("aria-selected", String(selectedSquare === cell.square));
    group.addEventListener("click", () => clickSquare(cell.square, cell.side));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        clickSquare(cell.square, cell.side);
      }
    });

    if (lastMove && (cell.square === lastMove.slice(0, 2) || cell.square === lastMove.slice(2))) {
      const mark = svgElement("circle");
      mark.setAttribute("cx", String(x));
      mark.setAttribute("cy", String(y));
      mark.setAttribute("r", "23");
      mark.setAttribute("class", "last-move-mark");
      group.append(mark);
    }
    if (selectedSquare === cell.square) {
      const mark = svgElement("circle");
      mark.setAttribute("cx", String(x));
      mark.setAttribute("cy", String(y));
      mark.setAttribute("r", "23");
      mark.setAttribute("class", "selected-mark");
      group.append(mark);
    }
    if (destinations.includes(cell.square)) {
      const marker = svgElement("circle");
      marker.setAttribute("cx", String(x));
      marker.setAttribute("cy", String(y));
      marker.setAttribute("r", cell.piece === "." ? "8" : "24");
      marker.setAttribute("class", cell.piece === "." ? "legal-dot" : "legal-capture");
      group.append(marker);
    }
    if (cell.piece !== ".") {
      const piece = svgElement("circle");
      piece.setAttribute("cx", String(x));
      piece.setAttribute("cy", String(y));
      piece.setAttribute("r", "20");
      piece.setAttribute("class", `piece-disc ${cell.side === "red" ? "piece-red" : "piece-black"}`);
      group.append(piece);
      const label = svgElement("text");
      label.setAttribute("x", String(x));
      label.setAttribute("y", String(y + 1));
      label.setAttribute("class", `piece-label ${cell.side === "red" ? "piece-label-red" : "piece-label-black"}`);
      label.textContent = cell.label;
      group.append(label);
    } else {
      const hitTarget = svgElement("circle");
      hitTarget.setAttribute("cx", String(x));
      hitTarget.setAttribute("cy", String(y));
      hitTarget.setAttribute("r", "21");
      hitTarget.setAttribute("class", "empty-hit-target");
      group.append(hitTarget);
    }
    svg.append(group);
  }

  renderMoveList(state);
  renderReviewPanel();
  if (route === "review") {
    renderFocus();
    drawFocusOverlay();
  } else {
    reviewLegend.hidden = true;
  }
}

function renderMoveList(state: GameSnapshot | null): void {
  if (!state) return;
  const records = state.history;
  moveCount.textContent = `${records.length} ${zhTW.moveCountSuffix}`;
  const readingAt = moveList.scrollTop;
  moveList.replaceChildren();
  if (records.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-record";
    empty.textContent = zhTW.noMoves;
    moveList.append(empty);
  } else {
    for (const record of records) {
      const row = document.createElement("li");
      row.className = `move-row ${record.side === "red" ? "move-row-red" : "move-row-black"}`;
      const moveNumber = document.createElement("span");
      moveNumber.className = "move-number";
      moveNumber.textContent = `${record.ply}.`;
      const sideLabel = document.createElement("span");
      sideLabel.className = "move-side";
      sideLabel.textContent = zhTW.playerLabels[record.side];
      const moveText = document.createElement("strong");
      moveText.textContent = record.notation;
      const coordinate = document.createElement("code");
      coordinate.dataset.devOnly = ""; // coordinates are for developer mode; the notation is for everyone
      coordinate.textContent = record.iccs;
      row.append(moveNumber, sideLabel, moveText, coordinate);
      moveList.append(row);
    }
  }
  followNewestMove(records.length, readingAt);
}

/**
 * Keeps the newest move in view. A new move, another game or coming back to the page always scrolls to the bottom;
 * only a redraw that changes nothing keeps the position the user scrolled to.
 */
function followNewestMove(count: number, readingAt: number): void {
  if (moveList.clientHeight === 0) {
    moveListFollowedKey = ""; // hidden page: the next time it shows, it starts at the newest move again
    return;
  }
  const key = `${parseRoute(window.location.hash)}|${gameState.current?.startFen ?? ""}|${count}|${gameState.current?.history.at(-1)?.iccs ?? ""}`;
  if (key === moveListFollowedKey) {
    moveList.scrollTop = readingAt; // rebuilding the rows reset the scroll position
    return;
  }
  moveListFollowedKey = key;
  moveList.scrollTop = moveList.scrollHeight;
}

function clickSquare(square: string, pieceSide: string | null): void {
  if (applyingImport) return;
  if (reviewMode) {
    clickBranchSquare(square, pieceSide);
    return;
  }
  // the review page shows the game as it was played: until a review starts, its board takes no moves
  if (parseRoute(window.location.hash) === "review") return;
  const state = gameState.current;
  if (workerFailed || !state || pending || state.outcome !== "ongoing") return;
  const legalMoves = state.legalMoves.join(",");
  const destinations = selectedSquare ? legalDestinations(legalMoves, selectedSquare) : [];
  if (selectedSquare && destinations.includes(square)) {
    const move = `${selectedSquare}${square}`;
    invalidateImportIntent(true);
    selectedSquare = null;
    gameDifficulty = Number(difficultySelect.value);
    sendCommand({ type: "move", move, difficultyLevel: gameDifficulty, userSide: gameSide });
    return;
  }
  if (pieceSide === state.side && legalDestinations(legalMoves, square).length > 0) {
    selectedSquare = square;
  } else {
    selectedSquare = null;
  }
  gameError = "";
  render();
}

function createGameWorker(): void {
  requestGeneration += 1;
  const generation = requestGeneration;
  worker = new Worker(new URL("./game.worker.ts", import.meta.url), { type: "module" });
  gameClient = new GameWorkerClient(worker, () => {
    if (generation !== requestGeneration) return;
    workerFailed = true;
    pending = false;
    searching = false;
    selectedSquare = null;
    gameError = zhTW.errors.workerFailed;
    if (applyingImport) {
      applyingImport = false;
      pendingImport = null;
      importStatus = zhTW.errors.workerFailed;
    }
    render();
  }, (requestId) => {
    if (generation !== requestGeneration || !gameState.isCurrent(requestId)) return;
    searching = true;
    render();
  }, (requestId, result: LiveEvaluationEvent) => {
    if (generation !== requestGeneration || !liveEvaluationEnabled
      || !liveEvaluationGate.accepts(requestId, result.fen, gameState.current?.fen)) return;
    liveProbability = liveWinProbabilityForUser(result.scoreCentipawns, result.sideToMove, "red");
    liveEvaluationSide = result.sideToMove;
    liveEvaluationFen = result.fen;
    liveEvaluationEvents.push({ side: result.sideToMove, fen: result.fen });
    lastLiveInfo = { nodes: result.nodes, score: result.scoreCentipawns, depth: result.depth, elapsedMs: result.elapsedMs };
    render();
  }, (requestId, state) => {
    if (generation !== requestGeneration || !gameState.showEarly(requestId, state)) return;
    selectedSquare = null;
    render();
  });
}

/** Ask for one evaluation of the position on the board, without blocking moves or touching `pending`. */
function requestLiveEvaluation(): void {
  if (!liveEvaluationEnabled || workerFailed || !gameClient) return;
  const request = gameClient.request({ type: "evaluate" });
  liveEvaluationGate.begin(request.id);
  request.promise.catch(() => { /* a failed evaluation only leaves the old figure in place */ });
}

function renderDevInfo(state: GameSnapshot | null): void {
  const none = zhTW.dev.none;
  // these four numbers come only from the live evaluation: without it there is nothing to show, and the card says so
  const live = (value: (info: NonNullable<typeof lastLiveInfo>) => number): string =>
    !liveEvaluationEnabled ? zhTW.dev.needLive : lastLiveInfo ? String(value(lastLiveInfo)) : none;
  const rows: Array<[string, string]> = [
    [zhTW.dev.aiLevel, state?.lastAiLevel ? String(state.lastAiLevel) : none],
    [zhTW.dev.nodes, live((info) => info.nodes)],
    [zhTW.dev.depth, live((info) => info.depth)],
    [zhTW.dev.score, live((info) => info.score)],
    [zhTW.dev.ms, live((info) => info.elapsedMs)],
  ];
  devInfoLines.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    return [term, detail];
  }));
}

function renderLiveProbability(): void {
  liveEvaluationToggle.checked = liveEvaluationEnabled;
  liveAssistedStatus.hidden = !liveEvaluationEnabled;
  // a figure for a position that is no longer on the board is not shown
  const { visible, figure } = liveMeterDisplay({
    enabled: liveEvaluationEnabled,
    reviewMode,
    main: liveProbability === null ? null : { fen: liveEvaluationFen, value: liveProbability, side: liveEvaluationSide },
    mainBoardFen: gameState.current?.fen,
    branch: branchProbability,
    branchBoardFen: branchState?.fen,
  });
  liveWinProbability.hidden = !visible;
  liveWinProbability.dataset.assisted = String(liveEvaluationEnabled);
  liveWinProbability.dataset.evaluationCount = String(liveEvaluationEvents.length);
  liveWinProbability.dataset.evaluationHistory = JSON.stringify(liveEvaluationEvents);
  if (figure === null) return;
  const percentage = figure.value * 100;
  liveWinProbability.dataset.evaluationSide = figure.side;
  liveWinProbability.dataset.evaluationFen = figure.fen;
  liveWinProbability.setAttribute("aria-valuenow", percentage.toFixed(1));
  liveProbabilityFill.style.width = `${percentage}%`;
  liveProbabilityLabel.textContent = `${zhTW.live.label}・${percentage.toFixed(1)}%`;
}

function sendCommand(
  command: GameCommand,
  onSuccess?: (state: GameSnapshot) => void,
  onFailure?: (error: WorkerErrorCode) => void,
  allowDuringImport = false,
): boolean {
  if (workerFailed || !gameClient || (applyingImport && !allowDuringImport)) return false;
  const generation = requestGeneration;
  const request = gameClient.request(command);
  gameState.track(request.id);
  pending = true;
  pendingCommandType = command.type;
  searching = false;
  gameError = "";
  render();
  void request.promise.then((response) => {
    const previousStartFen = gameState.current?.startFen;
    if (generation !== requestGeneration || !gameState.accept(response)) return;
    if (response.state && response.ok) {
      if (command.type !== "load-review") {
        gameLibrarySession.mainlineChanged(
          response.state.history.map((record) => record.iccs),
          response.state.startFen,
        );
      }
      onSuccess?.(response.state);
    } else if (response.state && response.state.startFen === previousStartFen) {
      gameLibrarySession.mainlineChanged(
        response.state.history.map((record) => record.iccs),
        response.state.startFen,
      );
    }
    if (!response.ok) onFailure?.(response.error);
    pending = false;
    searching = false;
    selectedSquare = null;
    gameError = response.ok ? "" : zhTW.errors[response.error];
    render();
    if (command.type === "move" && response.ok) requestLiveEvaluation();
  }).catch((error: unknown) => {
    if (generation !== requestGeneration || !gameState.isCurrent(request.id)) return;
    pending = false;
    searching = false;
    selectedSquare = null;
    const code = error instanceof Error ? error.message : "workerFailed";
    onFailure?.(code in zhTW.errors ? code as WorkerErrorCode : "workerFailed");
    gameError = code in zhTW.errors
      ? zhTW.errors[code as keyof typeof zhTW.errors]
      : zhTW.errors.workerFailed;
    render();
  });
  return true;
}

function restartGame(): void {
  if (applyingImport) return;
  invalidateImportIntent(true);
  reviewClient?.dispose();
  reviewClient = null;
  branchClient?.dispose();
  branchClient = null;
  branchWorker = null;
  branchState = null;
  variationTree = null;
  gameLibrarySession.reset();
  gameDifficulty = Number(difficultySelect.value);
  clearGameInProgress(browserStorage());
  persistedGameKey = "";
  reviewWarningBudget = null;
  currentSource = "played";
  gameAssisted = false;
  currentImportFormat = null;
  currentImportMetadata = {};
  currentImportWarnings = [];
  branchPending = false;
  branchSearching = false;
  branchError = "";
  reviewMode = false;
  reviewState = null;
  activeReviewRun = null;
  reviewPly = null;
  selectedVariation = [];
  gameClient?.dispose();
  gameClient = null;
  worker = null;
  gameState = new LatestGameState();
  liveEvaluationEnabled = false;
  liveEvaluationGate.clear();
  liveProbability = null;
  liveEvaluationEvents = [];
  lastLiveInfo = null;
  pending = false;
  searching = false;
  workerFailed = false;
  selectedSquare = null;
  gameError = "";
  setGameSide(userSideSetting);
  createGameWorker();
  render();
  sendCommand({ type: "init", userSide: gameSide, difficultyLevel: Number(difficultySelect.value) });
}

function createReviewWorker(): Worker {
  return new Worker(new URL("./review.worker.ts", import.meta.url), { type: "module" });
}

function reviewBudgetLabel(nodeLimit: number): string {
  if (nodeLimit === 100_000) return zhTW.review.budgetShort;
  if (nodeLimit === 1_000_000) return zhTW.review.budgetNormal;
  if (nodeLimit === 5_000_000) return zhTW.review.budgetHigh;
  return zhTW.review.nodeBudget(nodeLimit);
}

/** The buttons that begin a whole-game review: a review expected to take long is announced first. */
function requestReviewStart(): void {
  if (applyingImport) return;
  const state = gameState.current;
  const plies = state?.history.length ?? 0;
  if (!state || !plies) return;
  const check = ++reviewStartCheck;
  const budget = selectedBudget;
  const moves = state.history.map((record) => record.iccs);
  // plies the cache already holds cost nothing, so they are left out of the estimate
  const cached = reviewResultCache
    ? reviewResultCache.lookup(state.startFen, moves, budget).then((hits) => hits.size, () => 0)
    : Promise.resolve(0);
  void cached.then((cachedPlies) => {
    if (check !== reviewStartCheck || applyingImport || selectedBudget !== budget || gameState.current?.history.length !== plies) return;
    const seconds = estimateReviewSeconds({
      plies, cachedPlies, nodeLimit: budget, workers: reviewWorkerCount(navigator.hardwareConcurrency, location.search),
      secondsPerPlyAt100k: secondsPerPlyOverride(location.search),
    });
    if (longReviewWarning(seconds)) {
      reviewWarningBudget = budget;
      reviewWarningSeconds = seconds;
      render();
      return;
    }
    startReview(budget);
  });
}

function startReview(nodeLimit = selectedBudget, focusIndex?: number): void {
  if (applyingImport) return;
  const history = gameState.current?.history ?? [];
  if (!history.length) return;
  reviewWarningBudget = null;
  if (focusIndex === undefined) { reviewStartedAt = performance.now(); reviewRunIsWholeGame = true; } else reviewRunIsWholeGame = false;
  ensureVariationTree(history.map((record) => record.iccs));
  reviewArtifact = null;
  reviewNote = null;
  reviewNoteStatus = "";
  reviewNoteGeneration += 1;
  const runStartFen = gameState.current?.startFen ?? STANDARD_START_FEN;
  const runMoves = history.map((record) => record.iccs);
  activeReviewRun = createReviewRunContext(nextReviewRunId++, runStartFen, runMoves, nodeLimit);
  reviewMode = true;
  selectedVariation = [];
  if (focusIndex === undefined) {
    reviewPly = null;
    reviewState = null;
    selectedBudget = nodeLimit;
  } else {
    reviewPly = focusIndex;
  }
  if (!reviewClient) {
    reviewClient = new ReviewWorkerPool(createReviewWorker, reviewWorkerCount(navigator.hardwareConcurrency, location.search), (job) => {
      const context = activeReviewRun;
      if (!context || !isCurrentReviewRun(
        context,
        activeReviewRun,
        gameState.current?.startFen ?? STANDARD_START_FEN,
        gameState.current?.history.map((record) => record.iccs) ?? [],
      )) return;
      reviewState = job;
      if (job.status === "complete" && job.points.length === context.moves.length) {
        observeForegroundReview(context, job.points);
        void (async () => {
          try {
            const boards = await replayBoards(context.startFen, [...context.moves]);
            if (!isCurrentReviewRun(
              context,
              activeReviewRun,
              gameState.current?.startFen ?? STANDARD_START_FEN,
              gameState.current?.history.map((record) => record.iccs) ?? [],
            )) return;
            const currentGame = gameState.current;
            if (!currentGame) return;
            const outcome = currentGame.outcome;
            const artifact: SavedReviewSnapshot = {
              startFen: context.startFen, moves: [...context.moves], points: job.points, boards,
              analyzer: { name: "內建引擎", quickNodeLimit: context.quickNodeLimit, deepNodeLimit: deepNodeLimit(context.quickNodeLimit), config: context.config },
              result: outcome === "red_win" || outcome === "black_win" || outcome === "draw" ? outcome : "unknown",
              reportDate: reportDateInLocalTimezone(),
            };
            reviewArtifact = artifact;
            await persistReviewArtifact(artifact, null);
            render();
          } catch {
            reviewNoteStatus = zhTW.reviewNote.snapshotError;
            render();
          }
        })();
      }
      if (job.points.length && reviewPly === null) {
        reviewPly = job.points.length - 1;
        if (variationTree) void loadBranchNode(variationTree.mainlineNodeId(reviewPly));
      }
      render();
    }, reviewResultCache);
  }
  reviewClient.start(
    runMoves,
    nodeLimit,
    runStartFen,
    focusIndex,
  );
  if (reviewClient.state) {
    reviewState = reviewClient.state;
    if (reviewState.points.length && reviewPly === null) reviewPly = reviewState.points.length - 1;
  }
  render();
}

devModeToggle.addEventListener("change", () => {
  saveDevMode(browserStorage(), devModeToggle.checked);
  applyDevMode(requiredElement(document.querySelector<HTMLElement>(".app-shell")), devModeToggle.checked);
  // the live win rate is only visible in developer mode, so leaving it also switches it off
  // (set directly: the toggle's change handler returns early while an import is applying)
  if (!devModeToggle.checked && (liveEvaluationEnabled || liveEvaluationToggle.checked)) {
    liveEvaluationEnabled = false;
    liveEvaluationToggle.checked = false;
    liveProbability = null;
    liveEvaluationEvents = [];
    lastLiveInfo = null;
    liveEvaluationGate.clear();
    render();
  }
});
branchBack.addEventListener("click", () => {
  if (applyingImport || !reviewMode) return;
  invalidateImportIntent(true);
  void loadBranchNode(`main-${reviewPly ?? 0}`);
});

gameOverReview.addEventListener("click", () => {
  if (applyingImport) return;
  window.location.hash = buildHash("review");
  invalidateImportIntent();
  requestReviewStart();
});
gameOverAgain.addEventListener("click", () => {
  restartGame();
});
difficultySelect.addEventListener("change", () => {
  saveDifficulty(browserStorage(), Number(difficultySelect.value));
  gameError = "";
  render();
});
userSideSelect.addEventListener("change", () => {
  if (applyingImport) { userSideSelect.value = userSideSetting; return; }
  userSideSetting = userSideSelect.value === "black" ? "black" : "red";
  saveUserSide(browserStorage(), userSideSetting);
  // a game on which the user has not moved yet (or none at all) is simply started again on the new side;
  // otherwise the choice waits for the next new game
  const history = gameState.current?.history ?? [];
  // the computer's own opening (the init command) is not a move of the user
  const userHasMoved = history.some((record) => record.side === gameSide) || (pending && pendingCommandType !== "init");
  const action = sideChangeAction({ reviewMode, source: currentSource, userHasMoved, chosen: userSideSetting, onBoard: gameSide });
  if (action === "restart") restartGame();
  else render();
});
function currentUndoPlan(): UndoPlan {
  return undoPlan({
    reviewMode,
    boardShown: branchState !== null,
    parentId: variationTree?.node(branchNodeId)?.parentId ?? null,
    turnStartId: variationTree?.turnStartOf(branchNodeId) ?? null,
    busy: branchPending || branchSearching,
    mainHistoryLength: gameState.current?.history.length ?? 0,
    userSide: gameSide,
  });
}

undoButton.addEventListener("click", () => {
  if (applyingImport || pending || !gameState.current) return;
  const plan = currentUndoPlan();
  if (plan.kind === "none") return;
  if (plan.kind === "branch") {
    selectedSquare = null;
    void loadBranchNode(plan.nodeId);
    return;
  }
  invalidateImportIntent(true);
  selectedSquare = null;
  sendCommand({ type: "undo", userSide: gameSide }, () => requestLiveEvaluation());
});
restartButton.addEventListener("click", () => {
  restartGame();
});
reviewBudget.addEventListener("change", () => {
  if (applyingImport) return;
  selectedBudget = Number(reviewBudget.value);
  reviewWarningBudget = null;
  if ((REVIEW_BUDGETS as readonly number[]).includes(selectedBudget)) settingsStore.set({ reviewBudget: selectedBudget });
});
reviewPerspective.addEventListener("change", () => {
  if (applyingImport) return;
  reviewUserSide = reviewPerspective.value === "black" ? "black" : "red";
  if (reviewMode) render();
});
userLevelSelect.addEventListener("change", () => {
  if (!userLevel || !(SKILL_LEVELS as readonly string[]).includes(userLevelSelect.value)) return;
  userLevel.setManual(userLevelSelect.value as SkillLevelName);
  updateUserLevelControls();
  render();
});
userLevelReestimate.addEventListener("click", () => {
  if (!userLevel) return;
  userLevel.reestimate();
  updateUserLevelControls();
  render();
});
liveEvaluationToggle.addEventListener("change", () => {
  if (applyingImport) return;
  liveEvaluationEnabled = liveEvaluationToggle.checked;
  if (liveEvaluationEnabled) gameAssisted = true;
  liveProbability = null;
  liveEvaluationEvents = [];
  lastLiveInfo = null;
  liveEvaluationGate.clear();
  render();
  requestLiveEvaluation();
});
startReviewButton.addEventListener("click", () => {
  if (applyingImport) return;
  invalidateImportIntent();
  requestReviewStart();
});
reviewWarningGo.addEventListener("click", () => {
  if (applyingImport || reviewWarningBudget === null) return;
  startReview(reviewWarningBudget);
});
reviewWarningFaster.addEventListener("click", () => {
  if (applyingImport || reviewWarningBudget === null) return;
  selectedBudget = REVIEW_BUDGETS[0];
  reviewBudget.value = String(selectedBudget); // this review only: the saved setting is left alone
  startReview(selectedBudget);
});
saveGameButton.addEventListener("click", () => { void saveCurrentGame(); });
archiveExportButton.addEventListener("click", () => {
  libraryStatus = zhTW.library.archiveExportError;
  try {
    const archive = buildArchive(savedGames, reportDateInLocalTimezone());
    downloadReviewFile(JSON.stringify(archive, null, 2), `象棋教練備份-${archive.exportedAt}.json`, "application/json;charset=utf-8");
    libraryStatus = zhTW.library.archiveReady(archive.games.length);
  } catch { /* keep the export error message */ }
  render();
});
archiveFileInput.addEventListener("change", () => {
  const file = archiveFileInput.files?.[0];
  archiveFileInput.value = "";
  if (!file) return;
  void importArchiveFile(file);
});
importSubmitButton.addEventListener("click", () => {
  if (applyingImport) return;
  const generation = ++importIntentGeneration;
  const positionVersion = importPositionVersion;
  const input = importText.value;
  importStatus = zhTW.recordImport.analyzing;
  pendingImport = null;
  render();
  void importClient.parse(input).then((result) => {
    if (generation !== importIntentGeneration || input !== importText.value || positionVersion !== importPositionVersion) return;
    pendingImport = result;
    importStatus = importSummary(result);
    render();
    if (!result.errors.length && result.startFen && result.moves.length) applyImportedRecord(result);
  }).catch(() => {
    if (generation !== importIntentGeneration || input !== importText.value || positionVersion !== importPositionVersion) return;
    importStatus = zhTW.recordImport.loadError;
    pendingImport = null;
    render();
  });
});
importText.addEventListener("input", () => {
  if (applyingImport) return;
  invalidateImportIntent();
});
importPrefixButton.addEventListener("click", () => {
  if (applyingImport || !pendingImport) return;
  const result = pendingImport;
  invalidateImportIntent(true);
  applyImportedRecord(result, true);
});
for (const button of Array.from(settingsPage.querySelectorAll<HTMLButtonElement>("[data-settings-category]"))) {
  button.addEventListener("click", () => {
    settingsPage.dataset.category = button.dataset.settingsCategory;
    for (const other of Array.from(settingsPage.querySelectorAll<HTMLButtonElement>("[data-settings-category]"))) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}
bindShell(document.querySelector<HTMLElement>(".app-shell")!);
window.addEventListener("hashchange", () => render());
const resumedGame = loadGameInProgress(browserStorage());
if (resumedGame) {
  // a refresh: the game on the board is the one that was there, with the same side, difficulty and library binding
  difficultySelect.value = String(resumedGame.difficulty);
  saveDifficulty(browserStorage(), resumedGame.difficulty);
  setGameSide(resumedGame.userSide);
  gameDifficulty = resumedGame.difficulty;
  currentSource = resumedGame.source;
  gameAssisted = resumedGame.assisted;
  currentImportFormat = resumedGame.importFormat;
  currentImportMetadata = resumedGame.importMetadata;
  currentImportWarnings = resumedGame.importWarnings;
  pendingBindingId = resumedGame.libraryRecordId;
  render();
  createGameWorker();
  // an imported record is for looking at, so the computer is not asked to move in it
  const command: GameCommand = resumedGame.source === "imported"
    ? { type: "load-review", startFen: resumedGame.startFen, moves: resumedGame.moves }
    : { type: "resume", startFen: resumedGame.startFen, moves: resumedGame.moves, userSide: resumedGame.userSide, difficultyLevel: resumedGame.difficulty };
  sendCommand(command, undefined, (error) => {
    // the stored game cannot be replayed (damaged, or from another version): forget it and start a new one
    if (error === "invalidMove") queueMicrotask(() => restartGame());
    else { clearGameInProgress(browserStorage()); persistedGameKey = ""; pendingBindingId = null; } // do not get stuck on it at every refresh
  });
} else {
  render();
  createGameWorker();
  gameDifficulty = Number(difficultySelect.value);
  sendCommand({ type: "init", userSide: gameSide, difficultyLevel: Number(difficultySelect.value) });
}
void loadGameLibrary();
void registerServiceWorker({
  navigator,
  base: import.meta.env.BASE_URL,
  production: import.meta.env.PROD,
  document,
  onUpdateReady: (apply) => showUpdateBanner(document, apply),
  onUpdatedElsewhere: () => showUpdatedNotice(document, () => location.reload()),
});
}

void startApplication();
